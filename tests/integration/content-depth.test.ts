import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { BusinessFactKind } from "@/generated/prisma/enums";
import { recommendationVisibility } from "@/lib/business/visibility";
import { syncRecommendations } from "@/lib/recommendations/generate";
import {
  LINK_RULE,
  loadContentAnalysis,
  NOT_DESCRIBED_RULE,
} from "@/lib/seo/content";
import { syncSeoFindings } from "@/lib/seo/sync";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * Content depth and internal-link findings through the real SEO sync and
 * recommendation sync: a service page that does not describe its service,
 * and a page naming a service without linking to it, become tasks the team
 * sees and client members do not; a later complete crawl showing the fix
 * resolves them; another organization's scope reads nothing.
 */
describe.skipIf(!TEST_DATABASE_URL)(
  "content depth and internal links (local database)",
  () => {
    let db: PrismaClient;
    const run = uid();
    const orgIds: string[] = [];
    type Site = { id: string; organizationId: string; url: string };
    type PageSpec = {
      path: string;
      title: string;
      h1: string;
      text: string;
      links?: string[];
    };

    async function site(label: string): Promise<Site> {
      const org = await db.organization.create({
        data: { name: `${label} ${run}`, slug: `depth-${label}-${run}` },
      });
      orgIds.push(org.id);
      const w = await createWebsite(tenantDb(db, org.id), org.id, {
        name: `site ${uid()}`,
        url: `https://${uid()}.example/`,
      });
      return { id: w.id, organizationId: org.id, url: w.url };
    }
    async function fact(s: Site, kind: BusinessFactKind, value: string) {
      await db.businessFact.create({
        data: {
          organizationId: s.organizationId,
          websiteId: s.id,
          kind,
          value,
          normalizedValue: value.toLowerCase(),
          source: "CLIENT",
          status: "APPROVED",
          reviewedAt: new Date(),
        },
      });
    }
    /** A finished crawl of these pages, reconciled by the real SEO sync. */
    async function crawl(s: Site, pages: PageSpec[]) {
      const r = await db.crawlRun.create({
        data: {
          organizationId: s.organizationId,
          websiteId: s.id,
          status: "COMPLETED",
          maxPages: 100,
          maxDepth: 3,
          maxDiscoveredUrls: 1000,
          userAgent: "test",
          robotsTxtStatus: "found",
          sitemapUrlsDiscovered: pages.length,
        },
      });
      for (const p of pages) {
        const url = new URL(p.path, s.url).href;
        await db.crawlPage.create({
          data: {
            organizationId: s.organizationId,
            websiteId: s.id,
            crawlRunId: r.id,
            url,
            normalizedUrl: url,
            status: "CRAWLED",
            discoverySource: "LINK",
            depth: 1,
            httpStatus: 200,
            resourceType: "HTML",
            title: p.title,
            h1Count: 1,
            wordCount: 400,
            result: {
              headings: { h1: [p.h1], h2: [], h3: [] },
              links: (p.links ?? []).map((l) => ({
                url: new URL(l, s.url).href,
                anchorText: "more",
                type: "internal",
                rel: null,
                nofollow: false,
                sponsored: false,
                ugc: false,
              })),
              linksOmitted: 0,
              images: [],
              structuredData: [],
              content: {
                v: 1,
                source: "main",
                words: 400,
                blocks: [{ t: p.text, w: p.text.split(" ").length }],
              },
              contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
            },
          },
        });
      }
      await syncSeoFindings(
        db,
        {
          id: r.id,
          organizationId: s.organizationId,
          websiteId: s.id,
          status: "COMPLETED",
          robotsTxtStatus: "found",
          sitemapUrlsDiscovered: pages.length,
        },
        new URL(s.url).hostname,
      );
      return r;
    }
    const findings = (s: Site, ruleId: string) =>
      db.seoFinding.findMany({ where: { websiteId: s.id, ruleId } });

    const HOME = (links: string[] = []): PageSpec => ({
      path: "/",
      title: "Florist | Bloom",
      h1: "Fresh flowers every day",
      text: "We arrange wedding flowers and seasonal bouquets for every occasion.",
      links,
    });
    const WEDDING: PageSpec = {
      path: "/wedding-flowers",
      title: "Wedding flowers | Bloom",
      h1: "Wedding flowers",
      text: "Our wedding flowers are designed with each couple, from bouquets to arches.",
    };
    const funeral = (text: string): PageSpec => ({
      path: "/funeral-flowers",
      title: "Funeral flowers | Bloom",
      h1: "Funeral flowers",
      text,
    });
    const VAGUE =
      "We are here for you when it matters most, with care and respect.";
    const DESCRIBED =
      "Our funeral flowers include wreaths, sprays and tributes, delivered to the service.";

    async function florist(label: string) {
      const s = await site(label);
      await fact(s, "SERVICE", "Wedding flowers");
      await fact(s, "SERVICE", "Funeral flowers");
      return s;
    }

    beforeAll(() => {
      db = testDb();
    });
    afterAll(async () => {
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    });

    test("findings and tasks from a complete crawl; the team sees them, client members do not", async () => {
      const s = await florist("flow");
      await crawl(s, [HOME(), WEDDING, funeral(VAGUE)]);

      const [described] = await findings(s, NOT_DESCRIBED_RULE);
      expect(described).toMatchObject({ status: "OPEN" });
      expect(described.evidence).toMatchObject({
        url: new URL("/funeral-flowers", s.url).href,
        service: "Funeral flowers",
        mainWords: 400,
      });
      const [link] = await findings(s, LINK_RULE);
      expect(link.evidence).toMatchObject({
        target: new URL("/wedding-flowers", s.url).href,
        sources: [
          {
            url: new URL("/", s.url).href,
            passage:
              "We arrange wedding flowers and seasonal bouquets for every occasion.",
          },
        ],
      });

      await syncRecommendations(db, {
        id: s.id,
        organizationId: s.organizationId,
      });
      const titles = (role: "MEMBER" | "CLIENT") =>
        tenantDb(db, s.organizationId)
          .recommendation.findMany({
            where: {
              AND: [{ websiteId: s.id }, recommendationVisibility(role)],
            },
            select: { title: true },
          })
          .then((rs) => rs.map((r) => r.title));
      const team = await titles("MEMBER");
      expect(team).toEqual(
        expect.arrayContaining([
          `Service page does not describe the service (${NOT_DESCRIBED_RULE})`,
          `Pages that name a service do not link to its page (${LINK_RULE})`,
        ]),
      );
      const client = await titles("CLIENT");
      expect(client.some((t) => t.includes("(CONTENT_"))).toBe(false);
    });

    test("a later complete crawl that describes the service and adds the link resolves both", async () => {
      const s = await florist("fix");
      await crawl(s, [HOME(), WEDDING, funeral(VAGUE)]);
      await crawl(s, [HOME(["/wedding-flowers"]), WEDDING, funeral(DESCRIBED)]);
      expect((await findings(s, NOT_DESCRIBED_RULE))[0].status).toBe(
        "RESOLVED",
      );
      expect((await findings(s, LINK_RULE))[0].status).toBe("RESOLVED");
    });

    test("adequate coverage with the link already there: no content-depth or link finding", async () => {
      const s = await florist("ok");
      await crawl(s, [
        HOME(["/wedding-flowers", "/funeral-flowers"]),
        WEDDING,
        funeral(DESCRIBED),
      ]);
      expect(await findings(s, NOT_DESCRIBED_RULE)).toEqual([]);
      expect(await findings(s, LINK_RULE)).toEqual([]);
    });

    test("another organization's scope reads nothing of this crawl", async () => {
      const mine = await florist("iso-a");
      const other = await florist("iso-b");
      const r = await crawl(mine, [HOME(), WEDDING, funeral(VAGUE)]);
      const foreign = await loadContentAnalysis(
        db,
        {
          id: r.id,
          organizationId: other.organizationId,
          websiteId: mine.id,
          status: "COMPLETED",
        },
        new Date(),
      );
      expect(foreign).toBeNull();
      expect(await findings(other, NOT_DESCRIBED_RULE)).toEqual([]);
    });
  },
);
