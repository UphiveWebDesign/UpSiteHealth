import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { BusinessFactKind } from "@/generated/prisma/enums";
import { findingVisibility } from "@/lib/business/visibility";
import { syncRecommendations } from "@/lib/recommendations/generate";
import { buildExport } from "@/lib/reports/exports";
import { LINK_RULE, NOT_DESCRIBED_RULE } from "@/lib/seo/content";
import { syncSeoFindings } from "@/lib/seo/sync";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { loadContentPlan, type ContentPlan } from "@/lib/workflow/content-plan";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * The Content Plan from real stored evidence: findings written by the real
 * SEO sync, tasks by the real recommendation sync, read through the tenant
 * client. Covers the actions and their pages, a fact rejected after the
 * crawl, a dismissed task, another organization's scope, and the
 * seo-findings export for client members (no content findings).
 */
describe.skipIf(!TEST_DATABASE_URL)("content plan (local database)", () => {
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
      data: { name: `${label} ${run}`, slug: `cplan-${label}-${run}` },
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

  const ready = (p: ContentPlan) => {
    if (p.state !== "ready") throw new Error("plan not ready");
    return p;
  };
  const plan = async (s: Site, scopeOrg = s.organizationId) =>
    ready(await loadContentPlan(tenantDb(db, scopeOrg), s.id));

  test("actions from the crawl's evidence: the page to describe and the page to link from", async () => {
    const s = await florist("flow");
    await crawl(s, [HOME(), WEDDING, funeral(VAGUE)]);
    await syncRecommendations(db, {
      id: s.id,
      organizationId: s.organizationId,
    });
    const p = await plan(s);
    expect(p.groups.map((g) => g.kind)).toEqual(["describe", "link"]);
    const [describe, link] = p.groups.flatMap((g) => g.actions);
    expect(describe).toMatchObject({
      title: "Describe Funeral flowers on its page",
      pages: [new URL("/funeral-flowers", s.url).href],
      progress: "to-do",
      confirm: null,
      notRecheckedSince: null,
    });
    expect(link).toMatchObject({
      title: "Link to the Wedding flowers page",
      target: new URL("/wedding-flowers", s.url).href,
      pages: [new URL("/", s.url).href],
    });
    expect(p.heldBack).toEqual([]);
    expect(p.crawl?.note).toBeNull();
  });

  test("a fact rejected after the crawl leaves its action out (listed for the team)", async () => {
    const s = await florist("rejected");
    await crawl(s, [HOME(), WEDDING, funeral(VAGUE)]);
    await db.businessFact.updateMany({
      where: { websiteId: s.id, value: "Funeral flowers" },
      data: { status: "REJECTED" },
    });
    const p = await plan(s);
    expect(p.groups.flatMap((g) => g.actions).map((a) => a.kind)).toEqual([
      "link",
    ]);
    expect(p.heldBack).toEqual([
      {
        label: "Funeral flowers",
        reason: expect.stringMatching(/changed, rejected or deleted/),
      },
    ]);
  });

  test("a content task the team dismissed leaves its items out; completed work waits for the crawl", async () => {
    const s = await florist("decided");
    await crawl(s, [HOME(), WEDDING, funeral(VAGUE)]);
    await syncRecommendations(db, {
      id: s.id,
      organizationId: s.organizationId,
    });
    const task = (rule: string) =>
      db.recommendation.updateMany({
        where: { websiteId: s.id, title: { endsWith: `(${rule})` } },
        data: {
          status: rule === NOT_DESCRIBED_RULE ? "DISMISSED" : "COMPLETED",
        },
      });
    expect((await task(NOT_DESCRIBED_RULE)).count).toBe(1);
    expect((await task(LINK_RULE)).count).toBe(1);
    const p = await plan(s);
    expect(p.dismissed).toBe(1);
    expect(p.groups.flatMap((g) => g.actions)).toEqual([
      expect.objectContaining({ kind: "link", progress: "awaiting-check" }),
    ]);
  });

  test("another organization's scope reads nothing of this website", async () => {
    const mine = await florist("iso-a");
    const other = await florist("iso-b");
    await crawl(mine, [HOME(), WEDDING, funeral(VAGUE)]);
    const p = await plan(mine, other.organizationId);
    expect(p).toMatchObject({
      total: 0,
      groups: [],
      newPages: [],
      heldBack: [],
      crawl: null,
    });
  });

  test("the seo-findings export leaves content findings out for client members only", async () => {
    const s = await florist("export");
    await crawl(s, [HOME(), WEDDING, funeral(VAGUE)]);
    const csv = (role: "CLIENT" | "MEMBER") =>
      buildExport(tenantDb(db, s.organizationId), "seo-findings", {
        days: 30,
        websiteId: s.id,
        role,
      });
    const team = await csv("MEMBER");
    expect(team).toContain(NOT_DESCRIBED_RULE);
    expect(team).toContain(LINK_RULE);
    const client = await csv("CLIENT");
    expect(client).not.toContain("CONTENT_");
    expect(client).not.toMatch(/Funeral flowers|Wedding flowers/);
    // The SEO findings page's own filter, through the tenant client.
    const seen = (role: "CLIENT" | "MEMBER") =>
      tenantDb(db, s.organizationId)
        .seoFinding.findMany({
          where: { websiteId: s.id, ...findingVisibility(role) },
          select: { ruleId: true },
        })
        .then((rows) => rows.map((r) => r.ruleId));
    expect(await seen("MEMBER")).toEqual(
      expect.arrayContaining([NOT_DESCRIBED_RULE, LINK_RULE]),
    );
    expect((await seen("CLIENT")).some((r) => r.startsWith("CONTENT_"))).toBe(
      false,
    );
    // Missing role: the most restricted.
    expect(
      await buildExport(tenantDb(db, s.organizationId), "seo-findings", {
        days: 30,
        websiteId: s.id,
      }),
    ).not.toContain("CONTENT_");
  });
});
