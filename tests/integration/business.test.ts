import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { recommendationVisibility } from "@/lib/business/visibility";
import { processCrawls, startCrawl } from "@/lib/crawler/engine";
import type { NetPolicy } from "@/lib/net/ssrf";
import {
  buildRecommendations,
  loadRecommendationContext,
  recommendationState,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { loadPlan } from "@/lib/workflow/plan";
import { countConfirmedFixes, taskActivity } from "@/lib/workflow/progress";
import { loadReport } from "@/lib/workflow/report";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

const policy: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};
let hasBoilerPage = false;
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (title: string, body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><html><head><title>${title}</title><meta name="description" content="A meta description that is long enough for the checks, about ${title}."></head><body><h1>${title}</h1>${body}</body></html>`,
      );
    };
    const nav = `<a href="/contact">Contact us</a>${hasBoilerPage ? '<a href="/boiler-repair">Boiler repair</a>' : ""}`;
    if (req.url === "/") return html("Plumb and Co plumbers", nav);
    if (req.url === "/contact") return html("Contact us", nav);
    // A real page about the service: a thin page would not count as done.
    if (req.url === "/boiler-repair" && hasBoilerPage)
      return html(
        "Boiler repair",
        `${nav}<p>Boiler repair for homes and landlords. ${Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ")}</p>`,
      );
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://plumb.test:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const TASK = "Add a page for “Boiler repair” (BIZ_SERVICE_PAGE)";

describe.skipIf(!TEST_DATABASE_URL)(
  "business facts and coverage (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    let userId: string;

    async function setup(label: string) {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `biz-${label}-${run}` },
      });
      orgIds.push(org.id);
      const tdb = tenantDb(db, org.id);
      const site = await createWebsite(tdb, org.id, {
        name: label,
        url: origin,
      });
      const crawl = async () => {
        const r = await startCrawl(tdb, org.id, site.id, { maxDepth: 2 });
        await processCrawls(db, { deadline: Date.now() + 20_000, policy });
        return db.crawlRun.findUniqueOrThrow({ where: { id: r.id } });
      };
      const addFact = (
        kind: "SERVICE" | "GOAL",
        value: string,
        status: "APPROVED" | "PENDING",
      ) =>
        tdb.businessFact.create({
          data: {
            organizationId: org.id,
            websiteId: site.id,
            kind,
            value,
            normalizedValue: value.toLowerCase(),
            source: "CLIENT",
            status,
            createdById: userId,
            ...(status === "APPROVED"
              ? { reviewedById: userId, reviewedAt: new Date() }
              : {}),
          },
        });
      const website = { id: site.id, organizationId: org.id };
      const scope = { websiteId: site.id, organizationId: org.id };
      const tasks = () =>
        db.recommendation.findMany({
          where: { websiteId: site.id, title: { contains: "(BIZ_" } },
          orderBy: { title: "asc" },
        });
      return { org, tdb, site, crawl, addFact, website, scope, tasks };
    }

    beforeAll(async () => {
      db = testDb();
      const user = await db.user.create({
        data: { email: `biz-${run}@example.test`, name: "Reviewer" },
      });
      userId = user.id;
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.user.deleteMany({ where: { id: userId } });
      await db.$disconnect();
    });

    test("approved facts become one task each; pending facts never; completion needs a recrawl showing the page", async () => {
      hasBoilerPage = false;
      const { crawl, addFact, website, tasks, scope } = await setup("flow");
      expect((await crawl()).status).toBe("COMPLETED");
      await addFact("SERVICE", "Boiler repair", "APPROVED");
      await addFact("SERVICE", "Gas safety checks", "PENDING");
      await addFact("GOAL", "calls", "APPROVED"); // a contact page exists

      await syncRecommendations(db, website);
      await syncRecommendations(db, website); // idempotent
      expect((await tasks()).map((t) => [t.title, t.status])).toEqual([
        [TASK, "PROPOSED"],
      ]);

      // Marked done by a person: not verified until a crawl shows the page.
      const [task] = await tasks();
      await db.recommendation.update({
        where: { id: task.id },
        data: { status: "COMPLETED" },
      });
      let ctx = await loadRecommendationContext(db, scope);
      let state = recommendationState(
        { ...task, status: "COMPLETED", updatedAt: new Date() },
        buildRecommendations(ctx.inputs),
        ctx,
      );
      expect(state.kind).toBe("awaiting-recheck");

      // The page is published and found by the next crawl: verified.
      hasBoilerPage = true;
      await new Promise((r) => setTimeout(r, 5));
      await crawl();
      ctx = await loadRecommendationContext(db, scope);
      const need = ctx.coverage?.needs.find((n) => n.key === TASK);
      expect(need?.status).toBe("covered");
      const [done] = await tasks();
      state = recommendationState(done, buildRecommendations(ctx.inputs), ctx);
      expect(state.kind).toBe("verified");
    });

    test("an open task completes automatically only on evidence; unapproving its fact never completes it", async () => {
      hasBoilerPage = false;
      const { crawl, addFact, website, tasks, tdb, scope } =
        await setup("auto");
      await crawl();
      const f = await addFact("SERVICE", "Boiler repair", "APPROVED");
      await syncRecommendations(db, website);
      expect((await tasks())[0].status).toBe("PROPOSED");

      // Unapproved: it no longer applies, but it is not "fixed".
      await tdb.businessFact.updateMany({
        where: { id: f.id },
        data: { status: "PENDING", reviewedAt: null, reviewedById: null },
      });
      await syncRecommendations(db, website);
      expect((await tasks())[0].status).toBe("PROPOSED");
      const plan = await loadPlan(db, scope);
      expect(plan.waiting.map((i) => i.note)).toEqual([
        "The business facts behind it are no longer approved; dismiss it if it no longer applies.",
      ]);

      // Approved again and the page now exists: the sync completes it.
      await tdb.businessFact.updateMany({
        where: { id: f.id },
        data: {
          status: "APPROVED",
          reviewedAt: new Date(),
          reviewedById: userId,
        },
      });
      hasBoilerPage = true;
      await crawl();
      await syncRecommendations(db, website);
      expect((await tasks())[0].status).toBe("COMPLETED");
    });

    test("dismissed coverage tasks stay dismissed", async () => {
      hasBoilerPage = false;
      const { crawl, addFact, website, tasks } = await setup("dismiss");
      await crawl();
      await addFact("SERVICE", "Boiler repair", "APPROVED");
      await syncRecommendations(db, website);
      const [t] = await tasks();
      await db.recommendation.update({
        where: { id: t.id },
        data: { status: "DISMISSED" },
      });
      await syncRecommendations(db, website);
      expect((await tasks()).map((x) => x.status)).toEqual(["DISMISSED"]);
    });

    test("client members never receive business tasks; the team does", async () => {
      hasBoilerPage = false;
      const { crawl, addFact, website, scope } = await setup("visibility");
      await crawl();
      await addFact("SERVICE", "Boiler repair", "APPROVED");
      await syncRecommendations(db, website);
      const titles = async (role: "CLIENT" | "MEMBER") => {
        const p = await loadPlan(db, scope, recommendationVisibility(role));
        return [...p["fix-first"], ...p.continue, ...p.next].map(
          (i) => i.title,
        );
      };
      expect(await titles("MEMBER")).toContain(TASK);
      expect(await titles("CLIENT")).not.toContain(TASK);
      const period = { start: new Date(0), end: new Date(Date.now() + 60_000) };
      const all = await taskActivity(db, scope, period);
      const client = await taskActivity(
        db,
        scope,
        period,
        recommendationVisibility("CLIENT"),
      );
      expect(all.openNow - client.openNow).toBe(1);
    });

    test("tenant isolation and database rules for facts", async () => {
      const a = await setup("tenant-a");
      const b = await setup("tenant-b");
      await a.addFact("SERVICE", "Boiler repair", "APPROVED");
      expect(await b.tdb.businessFact.count()).toBe(0);
      expect(await a.tdb.businessFact.count()).toBe(1);
      // A fact cannot point at another organization's website (composite FK).
      await expect(
        db.businessFact.create({
          data: {
            organizationId: b.org.id,
            websiteId: a.site.id,
            kind: "SERVICE",
            value: "x",
            normalizedValue: "x",
            source: "TEAM",
          },
        }),
      ).rejects.toThrow();
      // Approval is a recorded decision: APPROVED needs a review time.
      await expect(
        a.tdb.businessFact.create({
          data: {
            organizationId: a.org.id,
            websiteId: a.site.id,
            kind: "SERVICE",
            value: "y",
            normalizedValue: "y",
            source: "INFERENCE",
            status: "APPROVED",
          },
        }),
      ).rejects.toThrow();
      // One fact per kind and wording.
      await expect(
        a.addFact("SERVICE", "Boiler repair", "PENDING"),
      ).rejects.toThrow();
    });

    test("without the business_facts table (migration not applied) technical work still syncs and loads", async () => {
      hasBoilerPage = false;
      const { crawl, addFact, website, scope, tasks, tdb, org, site } =
        await setup("no-table");
      await crawl();
      await addFact("SERVICE", "Boiler repair", "APPROVED");
      await syncRecommendations(db, website);
      const before = await db.recommendation.findMany({
        where: { websiteId: site.id },
        select: { title: true, status: true },
      });
      expect(before.some((r) => r.title === TASK)).toBe(true);
      const technical = before.filter((r) => !r.title.includes("(BIZ_"));
      expect(technical.length).toBeGreaterThan(0);

      // Local test database only: hide the table the way production lacks it.
      await db.$executeRawUnsafe(
        'ALTER TABLE "business_facts" RENAME TO "business_facts_hidden"',
      );
      try {
        await syncRecommendations(db, website); // threw P2021 before the fix
        const ctx = await loadRecommendationContext(db, scope);
        expect(ctx.coverage).toBeUndefined(); // not checked, never "no facts"
        const plan = await loadPlan(db, scope);
        const titles = [
          ...plan["fix-first"],
          ...plan.continue,
          ...plan.next,
        ].map((i) => i.title);
        for (const t of technical) expect(titles).toContain(t.title);
        // The business task is neither completed nor treated as gone.
        expect((await tasks())[0].status).toBe("PROPOSED");
        expect(plan.waiting.map((i) => [i.title, i.note])).toEqual([
          [TASK, "Waiting for a recheck to confirm the current state."],
        ]);
        const period = {
          start: new Date(0),
          end: new Date(Date.now() + 60_000),
        };
        expect((await taskActivity(db, scope, period)).openNow).toBe(
          before.length,
        );
        expect(await countConfirmedFixes(db, scope)).toBe(0);
        expect(
          await loadReport(tdb, db, org.id, site.id, "28d"),
        ).not.toBeNull();
      } finally {
        await db.$executeRawUnsafe(
          'ALTER TABLE "business_facts_hidden" RENAME TO "business_facts"',
        );
      }
    });
  },
);
