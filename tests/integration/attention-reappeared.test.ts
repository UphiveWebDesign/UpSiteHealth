import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  loadPortfolioAttention,
  portfolioAttention,
} from "@/lib/insights/attention";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import { resetCapabilitiesCache } from "@/lib/recommendations/capabilities";
import { changeStatus, resetHistoryCache } from "@/lib/recommendations/events";
import { syncRecommendations } from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * The agency Overview's "verified fixes that came back", on PostgreSQL with
 * task history and Stage 2 identity: several websites, a fix the real sync
 * verified and a later crawl found again, a completion never verified, and
 * plain outstanding work. Only the verified fix is "reappeared"; another
 * organization's returned fix is never read.
 */

const HOUR = 60 * 60 * 1000;
const BASE = "/o/x";
const RULES = {
  back: ["TECH_TITLE_TOO_LONG", "Title is too long"],
  unverified: ["TECH_IMAGE_MISSING_ALT", "Image without alt text"],
  open: ["TECH_HTTP_ERROR", "Page returns an error"],
} as const;

describe.skipIf(!TEST_DATABASE_URL)(
  "Overview: verified fixes that came back (isolated test database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function org(label: string) {
      const o = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `atr-${label}-${run}` },
      });
      orgIds.push(o.id);
      return o;
    }

    /** A manual website with one finding per given rule, synced into tasks. */
    async function site(orgId: string, rules: Array<keyof typeof RULES>) {
      const s = await createWebsite(tenantDb(db, orgId), orgId, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example`,
        crawlMode: "MANUAL",
      });
      const scope = { websiteId: s.id, organizationId: orgId };
      const sync = () =>
        syncRecommendations(db, { id: s.id, organizationId: orgId });
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
      const findings = new Map<string, string>();
      for (const k of rules) {
        const [ruleId, title] = RULES[k];
        const f = await db.seoFinding.create({
          data: {
            ...scope,
            crawlRunId: c1.id,
            ruleId,
            scope: "PAGE",
            severity: "HIGH",
            status: "OPEN",
            title,
            description: title,
            recommendation: "Fix it.",
            // As the analyser records it: the affected page.
            evidence: { url: `https://x.example/${k}` },
            fingerprint: `${ruleId}::https://x.example/${k}`,
          },
        });
        findings.set(k, f.id);
      }
      await sync();
      const task = (k: keyof typeof RULES) =>
        db.recommendation.findFirstOrThrow({
          where: { ...scope, title: { endsWith: `(${RULES[k][0]})` } },
        });
      return { s, scope, sync, crawl, findings, task };
    }

    /** Verified by a clean crawl, then found again by a later crawl. */
    async function verifyThenReturn(
      x: Awaited<ReturnType<typeof site>>,
      also: () => Promise<void> = async () => {},
    ) {
      const c2 = await x.crawl(2 * HOUR);
      await db.seoFinding.update({
        where: { id: x.findings.get("back")! },
        data: { status: "RESOLVED", resolvedAt: new Date(), crawlRunId: c2.id },
      });
      await x.sync();
      expect((await x.task("back")).status).toBe("COMPLETED");
      await also();
      const c3 = await x.crawl(0); // analysed after the completion
      await db.seoFinding.updateMany({
        where: { ...x.scope },
        data: {
          status: "OPEN",
          resolvedAt: null,
          crawlRunId: c3.id,
          lastSeenAt: new Date(),
        },
      });
      await x.sync();
    }

    async function load(orgId: string) {
      const tdb = tenantDb(db, orgId);
      const now = new Date();
      const inputs = await loadPortfolioAttention(
        tdb,
        db,
        { organizationId: orgId, role: "OWNER" },
        await loadWebsiteSummaries(tdb, { now }),
        BASE,
        now,
      );
      return { inputs, attention: portfolioAttention(inputs, BASE, { now }) };
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

    test("only the verified fix that came back is listed as such, across websites, with its dates and page", async () => {
      const a = await org("a");
      const user = await db.user.create({
        data: { email: `atr-${uid()}@example.test` },
      });
      userIds.push(user.id);
      const mixed = await site(a.id, ["back", "unverified", "open"]);
      const plain = await site(a.id, ["open"]);
      await verifyThenReturn(mixed, async () => {
        // A person marks alt text done; no recheck ever verifies it.
        const alt = await mixed.task("unverified");
        await changeStatus(db, {
          id: alt.id,
          ...mixed.scope,
          from: alt.status,
          to: "COMPLETED",
          actorUserId: user.id,
          history: true,
        });
      });

      const { attention } = await load(a.id);
      expect(attention.websites).toBe(2);
      expect(attention.byCategory.reappeared).toEqual({
        count: 1,
        websites: 1,
      });
      expect(attention.byCategory["still-detected"]).toEqual({
        count: 1,
        websites: 1,
      });
      expect(attention.byCategory["high-priority"].websites).toBe(2);

      // The website with a returned fix ranks first; its item comes first.
      const first = attention.sites[0];
      expect(first.websiteId).toBe(mixed.s.id);
      const back = first.items[0];
      const backTask = await mixed.task("back");
      expect(back).toMatchObject({
        category: "reappeared",
        tone: "danger",
        count: 1,
      });
      expect(back.entries).toEqual([
        {
          id: backTask.id,
          label: "Title is too long",
          href: `${BASE}/websites/${mixed.s.id}/recommendations#task-${backTask.id}`,
          detail: expect.stringMatching(
            /^High priority · verified fixed .+ · found again .+ · https:\/\/x\.example\/back$/,
          ),
          reopen: true,
        },
      ]);
      const still = first.items.find((i) => i.category === "still-detected")!;
      expect(still.entries.map((e) => e.label)).toEqual([
        "Image without alt text",
      ]);
      expect(
        attention.sites
          .find((s) => s.websiteId === plain.s.id)!
          .items.map((i) => i.category),
      ).toEqual(["high-priority"]);
    });

    test("another organization's returned fix is never read or counted", async () => {
      const a = await org("iso-a");
      const b = await org("iso-b");
      await site(a.id, ["open"]);
      const theirs = await site(b.id, ["back"]);
      await verifyThenReturn(theirs);

      const mine = await load(a.id);
      expect(mine.attention.byCategory.reappeared).toEqual({
        count: 0,
        websites: 0,
      });
      expect(
        mine.inputs.flatMap((s) => s.tasks).some((t) => t.reappeared),
      ).toBe(false);
      // Handed the other organization's website, nothing of it is read.
      const foreign = await loadPortfolioAttention(
        tenantDb(db, a.id),
        db,
        { organizationId: a.id, role: "OWNER" },
        (await loadWebsiteSummaries(tenantDb(db, b.id))).filter(
          (s) => s.websiteId === theirs.s.id,
        ),
        BASE,
      );
      expect(foreign[0].tasks).toEqual([]);
      // Their own Overview does show it.
      expect((await load(b.id)).attention.byCategory.reappeared.count).toBe(1);
    });
  },
);
