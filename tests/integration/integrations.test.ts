import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { mockProvider } from "@/lib/ai-search/providers";
import { processCrawls, startCrawl } from "@/lib/crawler/engine";
import { cronStages } from "@/lib/cron/work";
import { evaluateIntegrations } from "@/lib/integrations/evaluate";
import { latestProbe, loadIntegrationEvidence } from "@/lib/integrations/load";
import {
  runIntegrationCheck,
  websitesDueForProbe,
} from "@/lib/integrations/service";
import type { NetPolicy } from "@/lib/net/ssrf";
import {
  loadRecommendationContext,
  recommendationMeta,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import { buildExport } from "@/lib/reports/exports";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

const policy: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};
const DESC =
  "A meta description that is long enough to pass the fifty character minimum.";
let withGa4 = true;

const GA4 = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST1234"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-TEST1234');</script>`;
const GTM = `<script>(function(w,d,s,l,i){var j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','GTM-TEST12');</script>`;

function html(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><title>${title}</title>
    <meta name="description" content="${DESC} ${title}">
    <link rel="canonical" href="${origin}${title === "Home page of the site" ? "/" : "/about"}">
    ${withGa4 ? GA4 : ""}${GTM}</head><body><h1>${title}</h1>${body}</body></html>`;
}

let server: Server;
let origin: string;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = req.headers.host?.split(":")[0];
    const ok = (type: string, body: string) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    if (host === "gtm.test") {
      return req.url === "/gtm.js?id=GTM-TEST12"
        ? ok("application/javascript", "var data={'tag_id':'G-TEST1234'};")
        : (res.writeHead(404), res.end());
    }
    switch (req.url) {
      case "/robots.txt":
        return ok(
          "text/plain",
          `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml`,
        );
      case "/sitemap.xml":
        return ok(
          "application/xml",
          `<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/about</loc></url></urlset>`,
        );
      case "/":
        return ok(
          "text/html",
          html("Home page of the site", `<a href="/about">About</a>`),
        );
      case "/about":
        return ok("text/html", html("About the test company", "<p>About</p>"));
      default:
        res.writeHead(404, { "content-type": "text/html" });
        return res.end("<h1>Not found</h1>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  origin = `http://site.test:${port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe.skipIf(!TEST_DATABASE_URL)(
  "integration health (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    const probeDeps = () => ({
      policy,
      resolveTxt: async () => [["google-site-verification=abc"]],
      gtmOrigin: `http://gtm.test:${port}`,
    });

    async function setup(label: string) {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `int-${label}-${run}` },
      });
      orgIds.push(org.id);
      const tdb = tenantDb(db, org.id);
      const site = await createWebsite(tdb, org.id, {
        name: label,
        url: origin,
      });
      const scope = { websiteId: site.id, organizationId: org.id };
      const crawl = async () => {
        await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
        await processCrawls(db, { deadline: Date.now() + 20_000, policy });
      };
      const statuses = async () =>
        evaluateIntegrations((await loadIntegrationEvidence(db, scope))!);
      const byKey = async (key: string) =>
        (await statuses()).find((s) => s.key === key)!;
      return { org, tdb, site, scope, crawl, byKey };
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("a real crawl and probe: tags detected (not verified), robots and sitemap verified", async () => {
      const { tdb, site, scope, crawl, byKey } = await setup("detect");
      expect((await byKey("GA4")).state).toBe("not-checked"); // nothing crawled yet
      await crawl();
      const ga4 = await byKey("GA4");
      expect(ga4.state).toBe("detected");
      expect(ga4.evidence[0]).toContain("G-TEST1234");
      expect((await byKey("GTM")).evidence.join(" ")).toContain(
        "availability not checked yet",
      );
      expect((await byKey("ROBOTS")).state).toBe("not-checked");

      const statusBefore = (
        await db.website.findUniqueOrThrow({ where: { id: site.id } })
      ).status;
      await runIntegrationCheck(db, site, probeDeps());
      const gtm = await byKey("GTM");
      expect(gtm.state).toBe("detected");
      expect(gtm.evidence.join(" ")).toContain("published");
      expect((await byKey("ROBOTS")).state).toBe("verified");
      expect((await byKey("SITEMAP")).state).toBe("verified");
      expect((await byKey("GSC")).state).toBe("detected");
      expect((await byKey("CANONICAL")).state).toBe("verified");

      // Stored apart from monitoring: status, history and exports unchanged.
      expect(
        (await db.website.findUniqueOrThrow({ where: { id: site.id } })).status,
      ).toBe(statusBefore);
      expect(await latestProbe(db, scope)).not.toBeNull();
      await db.websiteCheck.create({
        data: {
          ...scope,
          type: "UPTIME",
          status: "COMPLETED",
          outcome: "SUCCESS",
          completedAt: new Date(),
        },
      });
      const csv = await buildExport(tdb, "checks", {
        days: 7,
        websiteId: site.id,
      });
      const rows = csv.trim().split("\n").slice(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(",UPTIME,");
      expect(csv).not.toContain(",SEO,");
    });

    test("an old crawl without tag data shows Not measured, never Missing", async () => {
      const { scope, crawl, byKey } = await setup("old");
      await crawl();
      const run = await db.crawlRun.findFirstOrThrow({
        where: { websiteId: scope.websiteId },
      });
      const pages = await db.crawlPage.findMany({
        where: { crawlRunId: run.id },
      });
      for (const p of pages) {
        if (!p.result) continue;
        const { tags: _tags, ...older } = p.result as Record<string, unknown>;
        await db.crawlPage.update({
          where: { id: p.id },
          data: { result: older as object },
        });
      }
      const ga4 = await byKey("GA4");
      expect(ga4).toMatchObject({ state: "not-checked", problems: [] });
      expect(ga4.headline).toMatch(/^Not measured/);
    });

    test("a missing GA4 tag creates a task with metadata; it completes only after a crawl confirms the fix", async () => {
      const { site, scope, crawl } = await setup("task");
      withGa4 = false;
      try {
        await crawl();
      } finally {
        withGa4 = true;
      }
      await runIntegrationCheck(db, site, {
        ...probeDeps(),
        gtmOrigin: `http://gtm-missing.test:${port}`, // container has no GA4
      });
      await syncRecommendations(db, site);
      const task = await db.recommendation.findFirstOrThrow({
        where: { websiteId: site.id, title: { contains: "(INT_GA4_MISSING)" } },
      });
      expect(task.status).toBe("PROPOSED");
      expect(task.expectedImpact).toContain("does not affect search rankings");
      const ctx = await loadRecommendationContext(db, scope);
      expect(recommendationMeta(task, ctx)).toMatchObject({
        benefit: "measurement",
        verification: expect.stringContaining("next crawl"),
      });

      // The latest crawl losing its tag data is not a fix.
      const latest = await db.crawlRun.findFirstOrThrow({
        where: { websiteId: site.id },
        orderBy: { createdAt: "desc" },
      });
      for (const p of await db.crawlPage.findMany({
        where: { crawlRunId: latest.id },
      })) {
        if (!p.result) continue;
        const { tags: _tags, ...older } = p.result as Record<string, unknown>;
        await db.crawlPage.update({
          where: { id: p.id },
          data: { result: older as object },
        });
      }
      expect((await syncRecommendations(db, site)).completed).toBe(0);

      // A real recrawl with GA4 installed confirms it.
      await crawl();
      await syncRecommendations(db, site);
      expect(
        (await db.recommendation.findUniqueOrThrow({ where: { id: task.id } }))
          .status,
      ).toBe("COMPLETED");
    });

    test("tenant isolation and scheduling", async () => {
      const { site, scope } = await setup("tenant");
      const other = await db.organization.create({
        data: { name: `other ${run}`, slug: `int-other-${run}` },
      });
      orgIds.push(other.id);
      const foreign = { websiteId: scope.websiteId, organizationId: other.id };
      expect(await loadIntegrationEvidence(db, foreign)).toBeNull();
      expect(await latestProbe(db, foreign)).toBeNull();

      const due = async () =>
        (await websitesDueForProbe(db, 100_000)).map((w) => w.id);
      expect(await due()).toContain(site.id);
      await runIntegrationCheck(db, site, probeDeps());
      expect(await due()).not.toContain(site.id);
    });

    test("the cron stage defers probes it has no time for and stores nothing", async () => {
      const { scope } = await setup("deadline");
      const stage = cronStages({
        db,
        workerId: `int-${run}`,
        makeProvider: (_id, brand) => mockProvider(brand),
        emailSender: null,
        probeDeps: probeDeps(),
      }).find((s) => s.name === "integrations")!;
      const result = (await stage.run({ deadline: Date.now() + 1_000 })) as {
        probed: number;
        deferred: number;
      };
      expect(result.probed).toBe(0);
      expect(await latestProbe(db, scope)).toBeNull();
    });
  },
);
