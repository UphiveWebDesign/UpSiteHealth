import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  processCrawls,
  requestCrawlCancel,
  startCrawl,
} from "@/lib/crawler/engine";
import type { NetPolicy } from "@/lib/net/ssrf";
import { loadCrawlComparison } from "@/lib/seo/compare";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

const policy: NetPolicy = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  isAllowed: (ip) => ip === "127.0.0.1",
};

const DESC =
  "A meta description that is long enough to pass the fifty character minimum.";
let aboutTitle =
  "About us and a far too long page title that goes beyond sixty chars";
let aboutStatus = 200;
let levelOneStatus = 200;

function pageHtml(title: string, body: string, desc = DESC) {
  return `<!doctype html><html lang="en"><head><title>${title}</title>
    <meta name="description" content="${desc}"></head><body><h1>${title}</h1>${body}</body></html>`;
}

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = (s: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(s);
    };
    switch (req.url) {
      case "/robots.txt":
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(
          `User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml`,
        );
      case "/sitemap.xml":
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<urlset><url><loc>${origin}/from-sitemap</loc></url></urlset>`,
        );
      case "/":
        return html(
          pageHtml(
            "Home page for the test site",
            `<a href="/about">About</a><a href="/level1">Deep</a><a href="/private/x">Private</a>
             <a href="/missing">Broken</a><a href="https://external.example/">Ext</a>
             <a href="/nofollow" rel="nofollow">NF</a><img src="/logo.png" alt="Logo">`,
          ),
        );
      case "/about":
        if (aboutStatus !== 200) {
          res.writeHead(aboutStatus, { "content-type": "text/html" });
          return res.end("<h1>Server error</h1>");
        }
        return html(pageHtml(aboutTitle, "<p>About</p>"));
      case "/level1":
        if (levelOneStatus !== 200) {
          res.writeHead(levelOneStatus, { "content-type": "text/html" });
          return res.end("<h1>Server error</h1>");
        }
        return html(
          pageHtml("Level one page of the site", `<a href="/level2">L2</a>`),
        );
      case "/level2":
        return html(
          pageHtml("Level two page of the site", `<a href="/level3">L3</a>`),
        );
      case "/from-sitemap":
        return html(pageHtml("Only linked from the sitemap", ""));
      default:
        res.writeHead(404, { "content-type": "text/html" });
        return res.end("<h1>Not found</h1>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://site.test:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe.skipIf(!TEST_DATABASE_URL)(
  "crawler and technical SEO (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];

    async function setup(label: string) {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `crawl-${label}-${run}` },
      });
      orgIds.push(org.id);
      const tdb = tenantDb(db, org.id);
      const site = await createWebsite(tdb, org.id, {
        name: label,
        url: origin,
      });
      return { org, tdb, site };
    }

    const crawl = () =>
      processCrawls(db, { deadline: Date.now() + 20_000, policy });

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("crawls the site, honours robots/depth, and records production-shaped findings", async () => {
      const { org, tdb, site } = await setup("full");
      const started = await startCrawl(tdb, org.id, site.id, { maxDepth: 2 });
      await expect(startCrawl(tdb, org.id, site.id)).rejects.toThrow(
        /already in progress/,
      );
      await crawl();

      const runRow = await db.crawlRun.findUniqueOrThrow({
        where: { id: started.id },
      });
      expect(runRow).toMatchObject({
        status: "COMPLETED",
        robotsTxtStatus: "found",
        sitemapUrlsDiscovered: 1,
        userAgent: expect.stringMatching(/^UpSiteHealthBot\/1\.0/),
      });
      expect(runRow.seoAnalyzedAt).not.toBeNull();

      const pages = await db.crawlPage.findMany({
        where: { crawlRunId: started.id },
      });
      const byPath = Object.fromEntries(
        pages.map((p) => [new URL(p.url).pathname, p]),
      );
      expect(byPath["/"]).toMatchObject({
        status: "CRAWLED",
        discoverySource: "SEED",
        httpStatus: 200,
      });
      expect(byPath["/about"]).toMatchObject({
        status: "CRAWLED",
        discoverySource: "LINK",
        depth: 1,
      });
      expect(byPath["/from-sitemap"]).toMatchObject({
        status: "CRAWLED",
        discoverySource: "SITEMAP",
      });
      expect(byPath["/private/x"]).toMatchObject({
        status: "SKIPPED",
        skipReason: "ROBOTS_DISALLOWED",
      });
      expect(byPath["/level3"]).toMatchObject({
        status: "SKIPPED",
        skipReason: "DEPTH_EXCEEDED",
      });
      expect(byPath["/missing"]).toMatchObject({
        status: "CRAWLED",
        httpStatus: 404,
      });
      expect(byPath["/nofollow"]).toBeUndefined();
      expect(pages.some((p) => p.url.includes("external.example"))).toBe(false);
      expect(byPath["/"].result).toMatchObject({
        headings: { h1: ["Home page for the test site"] },
        images: [expect.objectContaining({ alt: "Logo" })],
      });
      expect(runRow.pagesSkipped).toBe(2);
      expect(runRow.pagesDiscovered).toBe(pages.length);

      const findings = await db.seoFinding.findMany({
        where: { websiteId: site.id },
      });
      const longTitle = findings.find(
        (f) => f.ruleId === "TECH_TITLE_TOO_LONG",
      );
      expect(longTitle).toMatchObject({
        status: "OPEN",
        severity: "LOW",
        fingerprint: `TECH_TITLE_TOO_LONG::${origin}/about`,
        organizationId: org.id,
        evidence: { url: `${origin}/about`, maxLength: 60 },
      });
      expect(
        findings.find((f) => f.ruleId === "TECH_HTTP_ERROR")?.evidence,
      ).toMatchObject({
        httpStatus: 404,
      });
      expect(
        findings.find((f) => f.ruleId === "TECH_IMAGE_MISSING_DIMENSIONS"),
      ).toBeDefined();
    });

    test("a re-crawl resolves fixed findings and keeps finding identity", async () => {
      const { org, tdb, site } = await setup("recrawl");
      await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
      await crawl();
      const before = await db.seoFinding.findFirstOrThrow({
        where: { websiteId: site.id, ruleId: "TECH_TITLE_TOO_LONG" },
      });

      aboutTitle = "About the test company";
      try {
        await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
        await crawl();
      } finally {
        aboutTitle =
          "About us and a far too long page title that goes beyond sixty chars";
      }
      const after = await db.seoFinding.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.status).toBe("RESOLVED");
      expect(after.resolvedAt).not.toBeNull();
      expect(
        await db.seoFinding.count({
          where: { websiteId: site.id, fingerprint: before.fingerprint },
        }),
      ).toBe(1);
    });

    test("a page that starts failing keeps its findings open; only a successful recheck fixes them", async () => {
      const { org, tdb, site } = await setup("broken");
      const openCount = () =>
        db.seoFinding.count({ where: { websiteId: site.id, status: "OPEN" } });
      await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
      await crawl();
      const longTitle = await db.seoFinding.findFirstOrThrow({
        where: { websiteId: site.id, ruleId: "TECH_TITLE_TOO_LONG" },
      });
      const before = await openCount();

      // The page now errors: its title finding cannot be rechecked, so it is
      // NOT resolved, and the HTTP error is added — open counts go up.
      aboutStatus = 500;
      try {
        await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
        await crawl();
      } finally {
        aboutStatus = 200;
      }
      const kept = await db.seoFinding.findUniqueOrThrow({
        where: { id: longTitle.id },
      });
      expect(kept).toMatchObject({ status: "OPEN", resolvedAt: null });
      expect(kept.lastSeenAt).toEqual(longTitle.lastSeenAt);
      const httpError = await db.seoFinding.findFirstOrThrow({
        where: {
          websiteId: site.id,
          fingerprint: `TECH_HTTP_ERROR::${origin}/about`,
        },
        select: { id: true, status: true },
      });
      expect(httpError.status).toBe("OPEN");
      expect(await openCount()).toBe(before + 1);

      // Fixed for real: loads again with a good title → both resolve.
      aboutTitle = "About the test company";
      try {
        await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
        await crawl();
      } finally {
        aboutTitle =
          "About us and a far too long page title that goes beyond sixty chars";
      }
      for (const id of [longTitle.id, httpError.id]) {
        expect(
          (await db.seoFinding.findUniqueOrThrow({ where: { id } })).status,
        ).toBe("RESOLVED");
      }
    });

    test("a partial crawl never resolves findings on pages it skipped", async () => {
      const { org, tdb, site } = await setup("partial-keep");
      await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
      await crawl();
      const open = await db.seoFinding.findMany({
        where: { websiteId: site.id, status: "OPEN" },
        select: { id: true },
      });
      await startCrawl(tdb, org.id, site.id, { maxPages: 1 });
      await crawl();
      const after = await db.seoFinding.findMany({
        where: { id: { in: open.map((f) => f.id) } },
        select: { status: true, ruleId: true, scope: true },
      });
      // Only the home page was rechecked; it had no findings to fix, and
      // site-wide findings need a completed crawl.
      expect(after.every((f) => f.status === "OPEN")).toBe(true);
    });

    test("comparing crawls: fixed, new, not rechecked, came back, ignored — on real crawls", async () => {
      const { org, tdb, site } = await setup("compare");
      const longTitle =
        "About us and a far too long page title that goes beyond sixty chars";
      const recrawl = async () => {
        await startCrawl(tdb, org.id, site.id, { maxDepth: 1 });
        await crawl();
      };
      const pick = (
        c: Awaited<ReturnType<typeof loadCrawlComparison>>,
        kind: string,
      ) =>
        c!.items
          .filter((i) => i.kind === kind)
          .map((i) => `${i.ruleId} ${i.url?.replace(origin, "") ?? "site"}`)
          .sort();

      await recrawl();
      const first = await loadCrawlComparison(tdb, site.id);
      expect(first?.previous).toBeNull();
      expect(first?.items).toEqual([]);

      // Ignore the home page image finding; it must never count as fixed.
      await db.seoFinding.updateMany({
        where: {
          websiteId: site.id,
          fingerprint: `TECH_IMAGE_MISSING_DIMENSIONS::${origin}/`,
        },
        data: { status: "IGNORED" },
      });

      // Crawl 2: /about fixed for real; /level1 now fails with HTTP 500.
      aboutTitle = "About the test company";
      levelOneStatus = 500;
      try {
        await recrawl();
      } finally {
        aboutTitle = longTitle;
        levelOneStatus = 200;
      }
      const second = await loadCrawlComparison(tdb, site.id);
      expect(second!.previous!.id).toBe(first!.current.id);
      expect(pick(second, "fixed")).toEqual(["TECH_TITLE_TOO_LONG /about"]);
      expect(pick(second, "new")).toEqual(["TECH_HTTP_ERROR /level1"]);
      expect(pick(second, "not-rechecked")).toEqual([
        "TECH_THIN_CONTENT /level1",
      ]);
      expect(
        second!.items.find((i) => i.kind === "not-rechecked")?.reason,
      ).toContain("HTTP 500");
      expect(pick(second, "ignored")).toEqual([
        "TECH_IMAGE_MISSING_DIMENSIONS /",
      ]);
      expect(pick(second, "came-back")).toEqual([]);

      // Crawl 3: /about regresses; /level1 recovers.
      await recrawl();
      const third = await loadCrawlComparison(tdb, site.id);
      expect(pick(third, "came-back")).toEqual(["TECH_TITLE_TOO_LONG /about"]);
      expect(pick(third, "fixed")).toEqual(["TECH_HTTP_ERROR /level1"]);
      const thin = third!.items.find(
        (i) => i.ruleId === "TECH_THIN_CONTENT" && i.url === `${origin}/level1`,
      );
      expect(thin).toMatchObject({
        kind: "unchanged",
        previouslyUnchecked: true,
      });
      expect(third!.counts.fixed + third!.counts["came-back"]).toBe(2);

      // Historical: comparing crawl 2 explicitly gives the same answer.
      const again = await loadCrawlComparison(tdb, site.id, second!.current.id);
      expect(again!.counts).toEqual(second!.counts);

      // Another organization sees nothing.
      const other = await db.organization.create({
        data: { name: `other ${run}`, slug: `crawl-other-${run}` },
      });
      orgIds.push(other.id);
      const otherDb = tenantDb(db, other.id);
      expect(await loadCrawlComparison(otherDb, site.id)).toBeNull();
      expect(
        await loadCrawlComparison(otherDb, site.id, third!.current.id),
      ).toBeNull();
    });

    test("a page budget makes the run PARTIAL with BUDGET_EXCEEDED skips", async () => {
      const { org, tdb, site } = await setup("budget");
      const r = await startCrawl(tdb, org.id, site.id, { maxPages: 2 });
      await crawl();
      const row = await db.crawlRun.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.status).toBe("PARTIAL");
      expect(
        await db.crawlPage.count({
          where: { crawlRunId: r.id, skipReason: "BUDGET_EXCEEDED" },
        }),
      ).toBeGreaterThan(0);
      expect(
        await db.crawlPage.count({
          where: { crawlRunId: r.id, status: { not: "SKIPPED" } },
        }),
      ).toBe(2);
    });

    test("cancellation skips the remaining queue", async () => {
      const { org, tdb, site } = await setup("cancel");
      const r = await startCrawl(tdb, org.id, site.id);
      expect(await requestCrawlCancel(tdb, r.id)).toBe(true);
      await crawl();
      const row = await db.crawlRun.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.status).toBe("CANCELLED");
      expect(
        await db.crawlPage.count({
          where: { crawlRunId: r.id, skipReason: "CANCELLED" },
        }),
      ).toBe(1);
    });

    test("another organization cannot start or cancel this website's crawl", async () => {
      const { site } = await setup("owner");
      const other = await setup("intruder");
      await expect(
        startCrawl(other.tdb, other.org.id, site.id),
      ).rejects.toThrow(/not found/);
      const r = await startCrawl(
        tenantDb(db, site.organizationId),
        site.organizationId,
        site.id,
      );
      expect(await requestCrawlCancel(other.tdb, r.id)).toBe(false);
      await requestCrawlCancel(tenantDb(db, site.organizationId), r.id);
      await crawl();
    });
  },
);
