import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { requestCrawlCancel, startCrawl } from "@/lib/crawler/engine";
import { processCrawls } from "@/lib/crawler/scheduler";
import type { NetPolicy } from "@/lib/net/ssrf";
import {
  loadPortfolioAttention,
  portfolioAttention,
} from "@/lib/insights/attention";
import { loadWebsiteSummaries } from "@/lib/insights/signals";
import { syncRecommendations } from "@/lib/recommendations/generate";
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
/**
 * Hotel JSON-LD on the home page and /level1 (off by default, so other tests
 * see the site unchanged): "incomplete" has no address or telephone, while
 * the home page links a phone number; "complete" adds both.
 */
let hotelMarkup: "off" | "incomplete" | "complete" = "off";
/** Whether the home page carries the Hotel markup too (/level1 always does). */
let hotelOnHome = true;
/**
 * 25 extra pages /dup/0 … /dup/24 linked from the home page (off by default):
 * "same" gives them one title (a duplicate-title finding whose evidence lists
 * only 20 of them), "unique" gives each its own; `dupUnique` makes only those
 * pages unique while the others keep the shared title, and `dupFailing`
 * makes one of them return HTTP 500.
 */
const DUP_PAGES = 25;
let dupMode: "off" | "same" | "unique" = "off";
let dupUnique = new Set<number>();
let dupFailing: number | null = null;
const hotel = () => {
  if (hotelMarkup === "off") return "";
  const data = {
    "@context": "https://schema.org",
    "@type": "Hotel",
    "@id": `${origin}/#hotel`,
    name: "Test Valley Stay",
    ...(hotelMarkup === "complete"
      ? {
          address: {
            "@type": "PostalAddress",
            streetAddress: "1 Valley Road",
            addressLocality: "Testville",
          },
          telephone: "+44 20 0000 0000",
        }
      : {}),
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
};
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
             <a href="/nofollow" rel="nofollow">NF</a><img src="/logo.png" alt="Logo">${
               dupMode === "off"
                 ? ""
                 : Array.from(
                     { length: DUP_PAGES },
                     (_, i) => `<a href="/dup/${i}">Dup ${i}</a>`,
                   ).join("")
             }${
               hotelMarkup === "off"
                 ? ""
                 : `<a href="tel:+442000000000">Call us</a>${hotelOnHome ? hotel() : ""}`
             }`,
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
          pageHtml(
            "Level one page of the site",
            `<a href="/level2">L2</a>${hotel()}`,
          ),
        );
      case "/level2":
        return html(
          pageHtml("Level two page of the site", `<a href="/level3">L3</a>`),
        );
      case "/from-sitemap":
        return html(pageHtml("Only linked from the sitemap", ""));
      default: {
        const dup = /^\/dup\/(\d+)$/.exec(req.url ?? "");
        if (dup && dupMode !== "off") {
          const n = Number(dup[1]);
          if (n === dupFailing) {
            res.writeHead(500, { "content-type": "text/html" });
            return res.end("<h1>Server error</h1>");
          }
          return html(
            pageHtml(
              dupMode === "unique" || dupUnique.has(n)
                ? `Unique duplicate-test page number ${n}`
                : "One title shared by many test pages",
              "<p>Test page</p>",
            ),
          );
        }
        res.writeHead(404, { "content-type": "text/html" });
        return res.end("<h1>Not found</h1>");
      }
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

      // The portfolio attention list reports the same came-back finding,
      // once, linked to this comparison.
      const now = new Date();
      const attention = portfolioAttention(
        await loadPortfolioAttention(
          tdb,
          db,
          { organizationId: org.id, role: "MEMBER" },
          await loadWebsiteSummaries(tdb, { now }),
          "/o/x",
          now,
        ),
        "/o/x",
        { now, only: "returned" },
      );
      expect(attention.byCategory.returned).toEqual({ count: 1, websites: 1 });
      expect(attention.sites[0].items).toMatchObject([
        {
          category: "returned",
          count: 1,
          action: {
            href: `/o/x/websites/${site.id}/crawls/${third!.current.id}?change=came-back`,
          },
        },
      ]);

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

    test("incomplete Hotel markup: one finding and one task across crawls, resolved and completed once fixed", async () => {
      const RULE = "TECH_LOCAL_BUSINESS_INCOMPLETE";
      const TITLE = `Business structured data is incomplete (${RULE})`;
      const { org, tdb, site } = await setup("hotel");
      const recrawl = async () => {
        const run = await startCrawl(tdb, org.id, site.id);
        await crawl();
        const row = await db.crawlRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(row.status).toBe("COMPLETED");
        expect(row.seoAnalyzedAt).not.toBeNull();
      };
      const findings = () =>
        db.seoFinding.findMany({ where: { websiteId: site.id, ruleId: RULE } });
      const tasks = () =>
        db.recommendation.findMany({
          where: { websiteId: site.id, title: TITLE },
        });
      hotelMarkup = "incomplete";
      try {
        // Crawl 1: one site finding for the business, both pages listed.
        await recrawl();
        const [first, ...rest1] = await findings();
        expect(rest1).toEqual([]);
        expect(first).toMatchObject({
          scope: "SITE",
          severity: "LOW",
          status: "OPEN",
          crawlPageId: null,
        });
        expect(first.evidence).toEqual({
          entity: "Test Valley Stay",
          types: ["Hotel"],
          missing: ["address", "telephone"],
          telephoneLinksOnPage: 1,
          count: 2,
          urls: expect.arrayContaining([`${origin}/`, `${origin}/level1`]),
        });

        // Crawl 2: the same row (id and fingerprint), refreshed, no duplicate.
        await recrawl();
        const [second, ...rest2] = await findings();
        expect(rest2).toEqual([]);
        expect(second).toMatchObject({
          id: first.id,
          fingerprint: first.fingerprint,
          status: "OPEN",
        });
        expect(second.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
          first.lastSeenAt.getTime(),
        );

        // Two syncs: exactly one task, keeping its identity.
        await syncRecommendations(db, site);
        const [task, ...restT1] = await tasks();
        expect(restT1).toEqual([]);
        expect(task).toMatchObject({ status: "PROPOSED", priority: "LOW" });
        await syncRecommendations(db, site);
        const [again, ...restT2] = await tasks();
        expect(restT2).toEqual([]);
        expect(again).toMatchObject({ id: task.id, status: "PROPOSED" });

        // Fixed: address and telephone added; a completed crawl rechecks it.
        hotelMarkup = "complete";
        await recrawl();
        const [fixed, ...rest3] = await findings();
        expect(rest3).toEqual([]);
        expect(fixed).toMatchObject({ id: first.id, status: "RESOLVED" });
        expect(fixed.resolvedAt).not.toBeNull();
        await syncRecommendations(db, site);
        const [done, ...restT3] = await tasks();
        expect(restT3).toEqual([]);
        expect(done).toMatchObject({ id: task.id, status: "COMPLETED" });
      } finally {
        hotelMarkup = "off";
      }
    });

    test("a business finding stays open when a page it lists fails, even in a completed crawl", async () => {
      const RULE = "TECH_LOCAL_BUSINESS_INCOMPLETE";
      const { org, tdb, site } = await setup("hotel-gap");
      const recrawl = async () => {
        const run = await startCrawl(tdb, org.id, site.id);
        await crawl();
        return db.crawlRun.findUniqueOrThrow({ where: { id: run.id } });
      };
      const findings = () =>
        db.seoFinding.findMany({ where: { websiteId: site.id, ruleId: RULE } });
      hotelMarkup = "incomplete";
      hotelOnHome = false; // the business markup is only on /level1
      try {
        await recrawl();
        const [first, ...rest] = await findings();
        expect(rest).toEqual([]);
        expect(first.evidence).toMatchObject({ urls: [`${origin}/level1`] });

        // /level1 fails: the crawl still completes, but it cannot show the
        // markup is fixed, so the finding stays open (and its task too).
        levelOneStatus = 500;
        const failed = await recrawl();
        expect(failed.status).toBe("COMPLETED");
        const [kept, ...rest2] = await findings();
        expect(rest2).toEqual([]);
        expect(kept).toMatchObject({ id: first.id, status: "OPEN" });
        expect(kept.resolvedAt).toBeNull();
      } finally {
        hotelMarkup = "off";
        hotelOnHome = true;
        levelOneStatus = 200;
      }
    });

    test("a duplicate on more than 20 pages resolves only when every page was rechecked", async () => {
      const RULE = "TECH_DUPLICATE_TITLE";
      const SHARED = "One title shared by many test pages";
      const { org, tdb, site } = await setup("dup-25");
      // One processCrawls call stops at its deadline and leaves the run
      // RUNNING, and findings are synced only when a run finishes. About 30
      // pages can take longer than one 20-second pass on a hosted database,
      // so process until this run leaves QUEUED/RUNNING, within 150 s.
      const recrawl = async (label: string) => {
        const { id } = await startCrawl(tdb, org.id, site.id);
        const started = Date.now();
        let passes = 0;
        for (;;) {
          await crawl();
          passes++;
          const row = await db.crawlRun.findUniqueOrThrow({ where: { id } });
          if (row.status !== "QUEUED" && row.status !== "RUNNING") {
            console.info(
              `${label} crawl: ${row.status} after ${passes} pass(es), ${Math.round((Date.now() - started) / 1000)} s`,
            );
            expect(
              row.status,
              `${label} crawl ended ${row.status}: ${row.errorMessage ?? "no error message"}`,
            ).toBe("COMPLETED");
            return row;
          }
          if (Date.now() - started >= 150_000) {
            const pages = await db.crawlPage.groupBy({
              by: ["status"],
              where: { crawlRunId: id },
              _count: true,
            });
            throw new Error(
              `${label} crawl still ${row.status} after ${passes} pass(es) (150 s limit); pages by status: ${JSON.stringify(Object.fromEntries(pages.map((p) => [p.status, p._count])))}`,
            );
          }
        }
      };
      const dupFinding = async () =>
        (
          await db.seoFinding.findMany({
            where: { websiteId: site.id, ruleId: RULE },
          })
        ).filter(
          (f) => (f.evidence as { title?: string } | null)?.title === SHARED,
        );
      dupMode = "same";
      try {
        await recrawl("initial");
        const [first, ...rest] = await dupFinding();
        expect(rest).toEqual([]);
        const listed = (first.evidence as { urls: string[] }).urls;
        expect(first.evidence).toMatchObject({ count: DUP_PAGES });
        expect(listed).toHaveLength(20);
        const all = Array.from(
          { length: DUP_PAGES },
          (_, i) => `${origin}/dup/${i}`,
        );
        const outside = all
          .map((u, i) => [u, i] as const)
          .filter(([u]) => !listed.includes(u));
        expect(outside).toHaveLength(DUP_PAGES - 20);

        // Every page now has its own title, but one page outside the
        // 20-URL sample fails: the crawl shows no duplicate, yet that page
        // was not rechecked, so the finding must stay open.
        dupUnique = new Set(all.map((_, i) => i));
        dupFailing = outside[0][1];
        await recrawl("one page failing"); // must still be COMPLETED
        const [kept] = await dupFinding();
        expect(kept).toMatchObject({ id: first.id, status: "OPEN" });
        expect(kept.resolvedAt).toBeNull();

        // Every one of the 25 pages loads with its own title: resolved.
        dupFailing = null;
        await recrawl("all pages fixed");
        const [fixed] = await dupFinding();
        expect(fixed).toMatchObject({ id: first.id, status: "RESOLVED" });
      } finally {
        dupMode = "off";
        dupUnique = new Set();
        dupFailing = null;
      }
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
