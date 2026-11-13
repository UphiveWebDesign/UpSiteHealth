import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { resetCapabilitiesCache } from "@/lib/recommendations/capabilities";
import { changeStatus, resetHistoryCache } from "@/lib/recommendations/events";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationBasis,
  recommendationState,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { loadTaskHistory } from "@/lib/recommendations/history";
import { reappearance } from "@/lib/recommendations/reappearance";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { taskActivity } from "@/lib/workflow/progress";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * A fix that came back, end to end on PostgreSQL with task history and
 * Stage 2 identity (M1): the real sync verifies the fix and records it, a
 * later crawl finds the problem again, and the history loader, the
 * reappearance check and the progress/report activity agree. A completion
 * no recheck ever verified is never called a reappearance. Nothing here
 * writes beyond what the sync and a person's status change already write.
 */

const RULE = "TECH_TITLE_TOO_LONG";
const TITLE = "Title is too long";
const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)(
  "Reappeared fixes (isolated test database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function site(label: string) {
      const org = await db.organization.create({
        data: { name: label, slug: `re-${label}-${run}` },
      });
      orgIds.push(org.id);
      const s = await createWebsite(tenantDb(db, org.id), org.id, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
      });
      const scope = { websiteId: s.id, organizationId: org.id };
      const crawl = (ago: number) =>
        db.crawlRun.create({
          data: {
            ...scope,
            status: "COMPLETED",
            maxPages: 10,
            maxDepth: 1,
            maxDiscoveredUrls: 100,
            userAgent: "test",
            completedAt: new Date(Date.now() - ago),
            seoAnalyzedAt: new Date(Date.now() - ago),
          },
        });
      const c1 = await crawl(3 * HOUR);
      const finding = await db.seoFinding.create({
        data: {
          ...scope,
          crawlRunId: c1.id,
          ruleId: RULE,
          scope: "PAGE",
          severity: "MEDIUM",
          status: "OPEN",
          title: TITLE,
          description: "d",
          recommendation: "Keep titles under 60 characters.",
          fingerprint: `${RULE}::https://x.example/`,
        },
      });
      await syncRecommendations(db, {
        id: scope.websiteId,
        organizationId: scope.organizationId,
      });
      const [task] = await db.recommendation.findMany({
        where: { ...scope, title: { endsWith: `(${RULE})` } },
      });
      expect(task.status).toBe("PROPOSED");
      /** A later crawl finds the problem (again). */
      const detectAgain = async () => {
        const c = await crawl(0); // analysed after the completion, as in reality
        await db.seoFinding.update({
          where: { id: finding.id },
          data: {
            status: "OPEN",
            resolvedAt: null,
            crawlRunId: c.id,
            lastSeenAt: new Date(),
          },
        });
        await syncRecommendations(db, {
          id: scope.websiteId,
          organizationId: scope.organizationId,
        });
      };
      /** Everything the Recommendations page and the report compute. */
      const view = async () => {
        const row = await db.recommendation.findUniqueOrThrow({
          where: { id: task.id },
        });
        const ctx = await loadRecommendationContext(db, scope);
        const state = recommendationState(
          row,
          buildRecommendations(ctx.inputs),
          ctx,
        );
        const history = await loadTaskHistory(
          tenantDb(db, org.id),
          scope.websiteId,
          [row.id],
        );
        const activity = await taskActivity(db, scope, {
          start: new Date(0),
          end: new Date(Date.now() + HOUR),
        });
        return {
          row,
          state,
          reappeared: reappearance(
            row,
            state,
            recommendationBasis(row),
            history.get(row.id) ?? [],
          ),
          activity,
        };
      };
      return { org, scope, crawl, finding, task, detectAgain, view };
    }

    beforeAll(() => {
      db = testDb();
      resetHistoryCache();
      resetCapabilitiesCache();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.$disconnect();
    });

    test("verified fixed by a clean crawl, then found again: Reappeared, with the verified and the new evidence dates", async () => {
      const s = await site("verified");
      // A clean crawl: the sync completes the task and records verification.
      const c2 = await s.crawl(2 * HOUR);
      await db.seoFinding.update({
        where: { id: s.finding.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), crawlRunId: c2.id },
      });
      await syncRecommendations(db, {
        id: s.scope.websiteId,
        organizationId: s.scope.organizationId,
      });
      const fixed = await s.view();
      expect(fixed.row.status).toBe("COMPLETED");
      expect(fixed.state.kind).toBe("verified");
      expect(fixed.reappeared).toBeNull();
      expect(fixed.activity).toMatchObject({ verifiedNow: 1, reappeared: 0 });

      await s.detectAgain();
      const back = await s.view();
      // The completed task itself is not changed by the sync (D1 today).
      expect(back.row.status).toBe("COMPLETED");
      expect(back.row.updatedAt).toEqual(fixed.row.updatedAt);
      expect(back.state.kind).toBe("still-detected");
      expect(back.reappeared).not.toBeNull();
      expect(back.reappeared!.fixedObservedAt.getTime()).toBe(
        c2.seoAnalyzedAt!.getTime(),
      );
      expect(back.reappeared!.detectedAt.getTime()).toBeGreaterThan(
        back.reappeared!.fixedObservedAt.getTime(),
      );
      expect(back.activity).toMatchObject({
        verifiedNow: 0,
        stillDetected: 1,
        reappeared: 1,
      });
      expect(back.activity.items).toEqual([
        expect.objectContaining({
          id: s.task.id,
          state: "still-detected",
          reappeared: true,
        }),
      ]);
    });

    test("marked done by a person and never verified, then still found: Still detected, never Reappeared", async () => {
      const s = await site("unverified");
      const user = await db.user.create({
        data: { email: `re-${uid()}@example.test` },
      });
      userIds.push(user.id);
      expect(
        await changeStatus(db, {
          id: s.task.id,
          ...s.scope,
          from: "PROPOSED",
          to: "COMPLETED",
          actorUserId: user.id,
          history: true,
        }),
      ).toBe(true);
      await s.detectAgain();
      const v = await s.view();
      expect(v.row.status).toBe("COMPLETED");
      expect(v.state.kind).toBe("still-detected");
      expect(v.reappeared).toBeNull();
      expect(v.activity).toMatchObject({ stillDetected: 1, reappeared: 0 });
      expect(v.activity.items[0].reappeared).toBe(false);
    });
  },
);
