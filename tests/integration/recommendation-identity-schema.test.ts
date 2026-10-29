import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import {
  identityCapabilities,
  resetCapabilitiesCache,
} from "@/lib/recommendations/capabilities";
import { resetHistoryCache } from "@/lib/recommendations/events";
import { createRecommendationOnce } from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";
import { supportsLockContention } from "./test-db-guard";

/**
 * Migration 4_recommendation_identity (Stage 2, M1) on a real database:
 * the evidence table's tenancy and append-only triggers and foreign keys
 * (V1 to V8), the follow-up link's uniqueness and composite key, the
 * capability check against the real catalog, and key-first creation.
 * Needs M1 applied (itest-ci since 28 Oct). Rows are seeded directly.
 */
vi.mock("@/lib/db", () => ({ db: () => null }));

const RULE = "TECH_TITLE_TOO_LONG";

/** Thrown inside a transaction to roll it back on purpose. */
class Rollback extends Error {}
async function rolledBack(
  db: PrismaClient,
  fn: (tx: PrismaClient) => Promise<void>,
) {
  await expect(
    db.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaClient);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

describe.skipIf(!TEST_DATABASE_URL)(
  "M1 schema behaviour (isolated test database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];

    async function tenant(label: string) {
      const org = await db.organization.create({
        data: { name: label, slug: `m1-${label}-${run}` },
      });
      orgIds.push(org.id);
      const website = async () => {
        const w = await createWebsite(tenantDb(db, org.id), org.id, {
          name: `site ${uid()}`,
          url: `https://${uid()}.example`,
        });
        const scope = { websiteId: w.id, organizationId: org.id };
        const crawl = await db.crawlRun.create({
          data: {
            ...scope,
            status: "COMPLETED",
            maxPages: 10,
            maxDepth: 1,
            maxDiscoveredUrls: 100,
            userAgent: "test",
            completedAt: new Date(),
            seoAnalyzedAt: new Date(),
          },
        });
        const finding = await db.seoFinding.create({
          data: {
            ...scope,
            crawlRunId: crawl.id,
            ruleId: RULE,
            scope: "PAGE",
            severity: "MEDIUM",
            status: "OPEN",
            title: "Title is too long",
            description: "d",
            recommendation: "r",
            fingerprint: `${RULE}::${uid()}`,
          },
        });
        const fact = await db.businessFact.create({
          data: {
            ...scope,
            kind: "SERVICE",
            value: "Boiler repair",
            normalizedValue: `boiler repair ${uid()}`,
            synonyms: [],
            source: "CLIENT",
            status: "APPROVED",
            reviewedAt: new Date(),
          },
        });
        const task = (status: "PROPOSED" | "COMPLETED" = "PROPOSED") =>
          db.recommendation.create({
            data: {
              ...scope,
              title: `Task ${uid()} (${RULE})`,
              explanation: "x",
              priority: "MEDIUM",
              recommendedAction: "y",
              status,
            },
          });
        return { org, scope, crawl, finding, fact, task };
      };
      return { org, website };
    }

    type Site = Awaited<
      ReturnType<Awaited<ReturnType<typeof tenant>>["website"]>
    >;
    /** An evidence item for `site`'s task, with optional source references. */
    const item = (
      site: Site,
      recommendationId: string,
      refs: {
        crawlRunId?: string;
        seoFindingId?: string;
        businessFactId?: string;
      } = {},
    ) =>
      db.recommendationEvidence.create({
        data: {
          ...site.scope,
          recommendationId,
          setId: `set-${uid()}`,
          setDigest: "digest",
          role: "OBSERVED",
          kind: "seo-finding",
          source: "seo-rules",
          sourceVersion: "k3",
          observedAt: new Date("2026-10-27T10:00:00Z"),
          summary: "Title too long on /",
          payload: { httpStatus: 200 },
          factStatus: refs.businessFactId ? "APPROVED" : null,
          provenance: "RECORDED",
          ...refs,
        },
      });
    const setFollowUp = (id: string, recurrenceOfId: string) =>
      db.$executeRaw`UPDATE recommendations SET "recurrenceOfId" = ${recurrenceOfId} WHERE id = ${id}`;
    const followUpOf = async (id: string) =>
      (
        await db.$queryRaw<Array<{ recurrenceOfId: string | null }>>`
          SELECT "recurrenceOfId" FROM recommendations WHERE id = ${id}`
      )[0]?.recurrenceOfId;

    beforeAll(async () => {
      db = testDb();
      resetHistoryCache();
      resetCapabilitiesCache();
    });
    afterAll(async () => {
      // Cascades through websites and tasks, follow-up chains included.
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    describe("capability check against the real catalog", () => {
      test("every part present: enabled", async () => {
        resetCapabilitiesCache();
        expect(await identityCapabilities(db)).toEqual({
          enabled: true,
          missing: [],
        });
      });

      /** The check's answer inside a transaction that `change` alters, then rolled back. */
      async function capabilitiesAfter(
        change: (tx: PrismaClient) => Promise<unknown>,
      ) {
        let caps: Awaited<ReturnType<typeof identityCapabilities>> | undefined;
        vi.spyOn(log, "info").mockImplementation(() => {});
        vi.spyOn(log, "warn").mockImplementation(() => {});
        try {
          await rolledBack(db, async (tx) => {
            await change(tx);
            resetCapabilitiesCache();
            caps = await identityCapabilities(tx);
          });
        } finally {
          vi.restoreAllMocks();
          resetCapabilitiesCache();
        }
        return caps;
      }

      test("a disabled evidence trigger: off, naming the triggers (rolled back)", async () => {
        const caps = await capabilitiesAfter((tx) =>
          tx.$executeRawUnsafe(
            'ALTER TABLE "recommendation_evidence" DISABLE TRIGGER "recommendation_evidence_tenancy"',
          ),
        );
        expect(caps).toEqual({
          enabled: false,
          missing: [expect.stringContaining("recommendation_evidence_tenancy")],
        });
        expect((await identityCapabilities(db)).enabled).toBe(true);
      });

      test("the follow-up foreign key missing: off, naming it (rolled back)", async () => {
        const caps = await capabilitiesAfter((tx) =>
          tx.$executeRawUnsafe(
            'ALTER TABLE "recommendations" DROP CONSTRAINT "recommendations_recurrenceOfId_websiteId_organizationId_fkey"',
          ),
        );
        expect(caps).toEqual({
          enabled: false,
          missing: [expect.stringContaining("recurrenceOfId")],
        });
        expect((await identityCapabilities(db)).enabled).toBe(true);
      });

      test("a failed detection query: off (unit tests show it is not cached)", async () => {
        // An error aborts the transaction, so the check's own query fails.
        const caps = await capabilitiesAfter((tx) =>
          tx.$queryRawUnsafe("SELECT 1/0").catch(() => {}),
        );
        expect(caps).toEqual({
          enabled: false,
          missing: ["capability check failed"],
        });
        expect((await identityCapabilities(db)).enabled).toBe(true);
      });

      test("RLS is on with no policies; the app's role reads the table (it bypasses RLS)", async () => {
        const [r] = await db.$queryRaw<
          Array<{ rls: boolean; policies: number; bypass: boolean }>
        >`SELECT c.relrowsecurity AS rls,
            (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
              OR pg_get_userbyid(c.relowner) = current_user AS bypass
          FROM pg_class c WHERE c.oid = 'public.recommendation_evidence'::regclass`;
        expect(r).toEqual({ rls: true, policies: 0, bypass: true });
      });
    });

    describe("evidence: tenancy, foreign keys, append-only (V1 to V8)", () => {
      test("V0: an item referencing its own website's crawl, finding and fact is accepted", async () => {
        const s = await (await tenant("v0")).website();
        const t = await s.task();
        const e = await item(s, t.id, {
          crawlRunId: s.crawl.id,
          seoFindingId: s.finding.id,
          businessFactId: s.fact.id,
        });
        expect(e).toMatchObject({ supersededAt: null, provenance: "RECORDED" });
      });

      test("V1: a reference to another organization's or another website's source is refused, for each reference", async () => {
        const a = await tenant("v1a");
        const own = await a.website();
        const sibling = await a.website(); // same organization, other website
        const other = await (await tenant("v1b")).website();
        const t = await own.task();
        for (const foreign of [sibling, other])
          for (const refs of [
            { crawlRunId: foreign.crawl.id },
            { seoFindingId: foreign.finding.id },
            { businessFactId: foreign.fact.id },
          ])
            await expect(item(own, t.id, refs)).rejects.toThrow(
              /belongs to another website or organization/,
            );
        expect(
          await db.recommendationEvidence.count({
            where: { recommendationId: t.id },
          }),
        ).toBe(0);
      });

      test("V2: an item whose task is not its own website's or organization's is refused (composite key)", async () => {
        const a = await tenant("v2a");
        const own = await a.website();
        const sibling = await a.website();
        const other = await (await tenant("v2b")).website();
        for (const site of [sibling, other]) {
          const t = await site.task();
          await expect(item(own, t.id)).rejects.toThrow();
        }
      });

      test("V3: deleting a fact, a finding or a crawl run clears the reference and keeps everything else", async () => {
        const s = await (await tenant("v3")).website();
        const t = await s.task();
        const e = await item(s, t.id, {
          crawlRunId: s.crawl.id,
          seoFindingId: s.finding.id,
          businessFactId: s.fact.id,
        });
        await db.businessFact.delete({ where: { id: s.fact.id } });
        const afterFact = await db.recommendationEvidence.findUniqueOrThrow({
          where: { id: e.id },
        });
        expect(afterFact).toEqual({ ...e, businessFactId: null });
        // Deleting the crawl run also deletes its finding (cascade): both
        // references become NULL through the append-only trigger.
        await db.crawlRun.delete({ where: { id: s.crawl.id } });
        expect(
          await db.recommendationEvidence.findUniqueOrThrow({
            where: { id: e.id },
          }),
        ).toEqual({
          ...e,
          businessFactId: null,
          crawlRunId: null,
          seoFindingId: null,
        });
      });

      test("V4: any other change is refused: content, a second supersededAt, clearing it, adding or changing a reference", async () => {
        const s = await (await tenant("v4")).website();
        const t = await s.task();
        const e = await item(s, t.id, { crawlRunId: s.crawl.id });
        const update = (data: Record<string, unknown>) =>
          db.recommendationEvidence.update({ where: { id: e.id }, data });
        await expect(update({ summary: "rewritten" })).rejects.toThrow(
          /append-only/,
        );
        await expect(update({ setDigest: "other" })).rejects.toThrow(
          /append-only/,
        );
        await expect(update({ payload: { httpStatus: 404 } })).rejects.toThrow(
          /append-only/,
        );
        await expect(update({ businessFactId: s.fact.id })).rejects.toThrow(
          /append-only/,
        );
        // V5: supersededAt may be set once, from NULL.
        const at = new Date("2026-10-28T10:00:00Z");
        await expect(update({ supersededAt: at })).resolves.toMatchObject({
          supersededAt: at,
        });
        await expect(
          update({ supersededAt: new Date("2026-10-29T10:00:00Z") }),
        ).rejects.toThrow(/append-only/);
        await expect(update({ supersededAt: null })).rejects.toThrow(
          /append-only/,
        );
        expect(
          await db.recommendationEvidence.findUniqueOrThrow({
            where: { id: e.id },
          }),
        ).toEqual({ ...e, supersededAt: at });
      });

      test("V4b: a reference cannot be moved to another row of the same website either", async () => {
        const s = await (await tenant("v4b")).website();
        const t = await s.task();
        const e = await item(s, t.id, { crawlRunId: s.crawl.id });
        const otherRun = await db.crawlRun.create({
          data: {
            ...s.scope,
            status: "COMPLETED",
            maxPages: 10,
            maxDepth: 1,
            maxDiscoveredUrls: 100,
            userAgent: "test",
          },
        });
        await expect(
          db.recommendationEvidence.update({
            where: { id: e.id },
            data: { crawlRunId: otherRun.id },
          }),
        ).rejects.toThrow(/append-only/);
      });

      test("V6: the tenant-scoped client reads only its own organization's items", async () => {
        const a = await (await tenant("v6a")).website();
        const b = await (await tenant("v6b")).website();
        const ea = await item(a, (await a.task()).id);
        const eb = await item(b, (await b.task()).id);
        const seen = await tenantDb(
          db,
          a.org.id,
        ).recommendationEvidence.findMany({
          where: { id: { in: [ea.id, eb.id] } },
        });
        expect(seen.map((x) => x.id)).toEqual([ea.id]);
      });

      test("V7: items go with their task and website (deletes are not blocked)", async () => {
        const s = await (await tenant("v7")).website();
        const t = await s.task();
        const e1 = await item(s, t.id);
        await db.recommendationEvidence.delete({ where: { id: e1.id } });
        const e2 = await item(s, t.id);
        await db.website.delete({ where: { id: s.scope.websiteId } });
        expect(
          await db.recommendationEvidence.count({ where: { id: e2.id } }),
        ).toBe(0);
        expect(await db.recommendation.count({ where: { id: t.id } })).toBe(0);
      });

      test("the summary is limited to 500 characters", async () => {
        const s = await (await tenant("sum")).website();
        const t = await s.task();
        await expect(
          db.recommendationEvidence.create({
            data: {
              ...s.scope,
              recommendationId: t.id,
              setId: "s",
              setDigest: "d",
              role: "MISSING",
              kind: "legacy",
              source: "seo-rules",
              summary: "x".repeat(501),
              provenance: "LEGACY_UNAVAILABLE",
            },
          }),
        ).rejects.toThrow();
      });
    });

    describe("follow-up link (recurrenceOfId)", () => {
      test("one follow-up per completed task; a second is refused", async () => {
        const s = await (await tenant("r-uniq")).website();
        const done = await s.task("COMPLETED");
        const f1 = await s.task();
        const f2 = await s.task();
        expect(await setFollowUp(f1.id, done.id)).toBe(1);
        expect(await followUpOf(f1.id)).toBe(done.id);
        await expect(setFollowUp(f2.id, done.id)).rejects.toThrow();
        expect(await followUpOf(f2.id)).toBeNull();
      });

      test("a task is never its own follow-up", async () => {
        const s = await (await tenant("r-self")).website();
        const t = await s.task("COMPLETED");
        await expect(setFollowUp(t.id, t.id)).rejects.toThrow();
      });

      test("a follow-up of another website's or organization's task is refused (composite key)", async () => {
        const a = await tenant("r-x");
        const w1 = await a.website();
        const w2 = await a.website();
        const other = await (await tenant("r-y")).website();
        const f = await w1.task();
        for (const site of [w2, other]) {
          const done = await site.task("COMPLETED");
          await expect(setFollowUp(f.id, done.id)).rejects.toThrow();
        }
        expect(await followUpOf(f.id)).toBeNull();
      });

      test("NO ACTION: a linked task cannot be deleted or have its id changed; the website goes with the whole chain", async () => {
        const s = await (await tenant("r-del")).website();
        const done = await s.task("COMPLETED");
        const f = await s.task();
        await setFollowUp(f.id, done.id);
        await expect(
          db.recommendation.delete({ where: { id: done.id } }),
        ).rejects.toThrow();
        await expect(
          db.$executeRaw`UPDATE recommendations SET id = ${`${done.id}-x`} WHERE id = ${done.id}`,
        ).rejects.toThrow();
        // A chain of two follow-ups, then the website: one statement removes all.
        const f2 = await s.task();
        await db.recommendation.update({
          where: { id: f.id },
          data: { status: "COMPLETED" },
        });
        await setFollowUp(f2.id, f.id);
        await db.website.delete({ where: { id: s.scope.websiteId } });
        expect(
          await db.recommendation.count({
            where: { id: { in: [done.id, f.id, f2.id] } },
          }),
        ).toBe(0);
      });
    });

    describe("key-first creation and duplicate prevention", () => {
      const draft = (title: string) => ({
        title,
        explanation: "x",
        priority: "MEDIUM" as const,
        expectedImpact: "z",
        recommendedAction: "y",
        issueId: null,
      });
      const key = `seo:${RULE}`;

      test("the key decides, not the title: a second wording finds the first task, which is keyed", async () => {
        const s = await (await tenant("k1")).website();
        const first = await createRecommendationOnce(
          db,
          s.scope,
          draft(`Title is too long (${RULE})`),
          null,
          { identity: true, key },
        );
        expect(first.created).toBe(true);
        const second = await createRecommendationOnce(
          db,
          s.scope,
          draft(`Shorten the page title (${RULE})`),
          null,
          { identity: true, key },
        );
        expect(second).toEqual({
          created: false,
          id: first.id,
          status: "PROPOSED",
        });
        const [{ identityKey }] = await db.$queryRaw<
          Array<{ identityKey: string | null }>
        >`SELECT "identityKey" FROM recommendations WHERE id = ${first.id}`;
        expect(identityKey).toBe(key);
      });

      test("two connections creating the same key at once leave one task", async (ctx) => {
        const [server] = await db.$queryRaw<
          Array<{ version: string }>
        >`SELECT version() AS version`;
        if (!supportsLockContention(server.version)) ctx.skip();
        const s = await (await tenant("k2")).website();
        const other = testDb();
        try {
          const results = await Promise.all([
            createRecommendationOnce(db, s.scope, draft(`A (${RULE})`), null, {
              identity: true,
              key,
            }),
            createRecommendationOnce(
              other,
              s.scope,
              draft(`B (${RULE})`),
              null,
              {
                identity: true,
                key,
              },
            ),
          ]);
          expect(results.filter((r) => r.created)).toHaveLength(1);
          expect(new Set(results.map((r) => r.id)).size).toBe(1);
          expect(await db.recommendation.count({ where: { ...s.scope } })).toBe(
            1,
          );
        } finally {
          await other.$disconnect();
        }
      });
    });
  },
);
