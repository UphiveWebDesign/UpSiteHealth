import { describe, expect, test } from "vitest";
import type { TenantDb } from "@/lib/tenancy/scope";
import {
  comparePages,
  describeWhatChanged,
  fieldForRule,
  loadWhatChanged,
  whatChangedRequest,
  type PageSnapshot,
  type ReturnedTask,
  type WhatChangedRequest,
} from "./what-changed";

const URL = "https://shop.example/services/wedding-flowers";
const page = (
  crawlRunId: string,
  over: Partial<PageSnapshot> = {},
): PageSnapshot => ({
  crawlRunId,
  url: URL,
  status: "CRAWLED",
  h1Count: 1,
  title: "Wedding flowers",
  metaDescription: "Bouquets for your day.",
  canonicalUrl: URL,
  ...over,
});

describe("fieldForRule", () => {
  test("title, meta description and canonical rules compare their value; others nothing", () => {
    expect(fieldForRule("TECH_TITLE_TOO_LONG")).toBe("title");
    expect(fieldForRule("TECH_DUPLICATE_TITLE")).toBe("title");
    expect(fieldForRule("TECH_META_DESCRIPTION_MISSING")).toBe(
      "metaDescription",
    );
    expect(fieldForRule("TECH_CANONICAL_EXTERNAL")).toBe("canonicalUrl");
    expect(fieldForRule("TECH_IMAGE_MISSING_ALT")).toBeNull();
    expect(fieldForRule("TECH_HTTP_ERROR")).toBeNull();
  });
});

describe("comparePages", () => {
  test("a changed title: before and after from the same URL in the two crawls", () => {
    const w = comparePages(
      "title",
      URL,
      [page("v")],
      [
        page("d", {
          title: "Wedding flowers | Bloom Florists | Same-day delivery",
        }),
      ],
    );
    expect(w).toEqual({
      field: "title",
      url: URL,
      before: "Wedding flowers",
      after: "Wedding flowers | Bloom Florists | Same-day delivery",
      changed: true,
    });
  });

  test("unchanged values are reported as unchanged", () => {
    expect(comparePages("title", URL, [page("v")], [page("d")])).toMatchObject({
      changed: false,
      before: "Wedding flowers",
      after: "Wedding flowers",
    });
  });

  test("a value the page did not have (null or blank) is none, not invented", () => {
    const w = comparePages(
      "metaDescription",
      URL,
      [page("v")],
      [page("d", { metaDescription: "   " })],
    );
    expect(w).toMatchObject({
      before: "Bouquets for your day.",
      after: null,
      changed: true,
    });
  });

  test("no comparison without exactly one parsed page with that URL in each crawl", () => {
    const other = page("d", { url: "https://shop.example/contact" });
    // Unrelated page only.
    expect(comparePages("title", URL, [page("v")], [other])).toBeNull();
    // Missing in the verifying crawl.
    expect(comparePages("title", URL, [], [page("d")])).toBeNull();
    // Fetched but not parsed as HTML: a null title would mean nothing.
    expect(
      comparePages(
        "title",
        URL,
        [page("v", { h1Count: null, title: null })],
        [page("d")],
      ),
    ).toBeNull();
    expect(
      comparePages(
        "title",
        URL,
        [page("v", { status: "FAILED" })],
        [page("d")],
      ),
    ).toBeNull();
    // Two rows for the URL: ambiguous.
    expect(
      comparePages("title", URL, [page("v"), page("v")], [page("d")]),
    ).toBeNull();
  });
});

describe("describeWhatChanged", () => {
  test("changed, unchanged, none and long values", () => {
    expect(
      describeWhatChanged({
        field: "title",
        url: URL,
        before: "A",
        after: null,
        changed: true,
      }),
    ).toBe("Page title: “A” → (none)");
    expect(
      describeWhatChanged({
        field: "canonicalUrl",
        url: URL,
        before: URL,
        after: URL,
        changed: false,
      }),
    ).toBe(`Canonical URL unchanged: “${URL}”`);
    const long = "x".repeat(200);
    const text = describeWhatChanged({
      field: "metaDescription",
      url: URL,
      before: null,
      after: long,
      changed: true,
    });
    expect(text.startsWith("Meta description: (none) → “")).toBe(true);
    expect(text.endsWith("…”")).toBe(true);
    expect(text.length).toBeLessThan(110);
  });
});

describe("loadWhatChanged", () => {
  const V = new Date("2026-11-10T10:00:00Z");
  const D = new Date("2026-11-11T10:00:00Z");
  const request: WhatChangedRequest = {
    taskId: "t",
    websiteId: "w",
    ruleId: "TECH_TITLE_TOO_LONG",
    url: URL,
    verifiedCrawlRunId: "v",
    detectingCrawlRunId: "d",
    fixedObservedAt: V,
    detectedAt: D,
  };
  const fake = (
    runs: Array<{ id: string; websiteId: string; seoAnalyzedAt: Date | null }>,
    pages: PageSnapshot[],
  ) =>
    ({
      crawlRun: { findMany: async () => runs },
      crawlPage: { findMany: async () => pages },
    }) as unknown as TenantDb;
  const runs = [
    { id: "v", websiteId: "w", seoAnalyzedAt: V },
    { id: "d", websiteId: "w", seoAnalyzedAt: D },
  ];
  const pages = [page("v"), page("d", { title: "Wedding flowers | Shop" })];

  test("everything lines up: the comparison, by task", async () => {
    const m = await loadWhatChanged(fake(runs, pages), [request]);
    expect(m.get("t")).toMatchObject({
      before: "Wedding flowers",
      after: "Wedding flowers | Shop",
      changed: true,
    });
  });

  test("a crawl of another website, or analysed at another time, is never used", async () => {
    expect(
      (
        await loadWhatChanged(
          fake([{ ...runs[0], websiteId: "other" }, runs[1]], pages),
          [request],
        )
      ).size,
    ).toBe(0);
    expect(
      (
        await loadWhatChanged(
          fake([runs[0], { ...runs[1], seoAnalyzedAt: V }], pages),
          [request],
        )
      ).size,
    ).toBe(0);
    // A run the tenant-scoped client did not return (another organization's).
    expect(
      (await loadWhatChanged(fake([runs[1]], pages), [request])).size,
    ).toBe(0);
  });

  test("the same crawl twice, or a rule about something else: nothing", async () => {
    expect(
      (
        await loadWhatChanged(fake(runs, pages), [
          { ...request, detectingCrawlRunId: "v" },
        ])
      ).size,
    ).toBe(0);
    expect(
      (
        await loadWhatChanged(fake(runs, pages), [
          { ...request, ruleId: "TECH_IMAGE_MISSING_ALT" },
        ])
      ).size,
    ).toBe(0);
  });

  test("a failed read shows nothing rather than a partial comparison", async () => {
    const broken = {
      crawlRun: {
        findMany: async () => {
          throw new Error("down");
        },
      },
      crawlPage: { findMany: async () => pages },
    } as unknown as TenantDb;
    expect((await loadWhatChanged(broken, [request])).size).toBe(0);
  });
});

describe("whatChangedRequest", () => {
  const V = new Date("2026-11-10T10:00:00Z");
  const D = new Date("2026-11-11T10:00:00Z");
  const task: ReturnedTask = {
    id: "t1",
    websiteId: "w1",
    title: "Title is too long (TECH_TITLE_TOO_LONG)",
    issueId: null,
    reappeared: {
      verifiedAt: V,
      fixedObservedAt: V,
      detectedAt: D,
      verifiedCrawlRunId: "run-v",
    },
    urls: [URL, "https://shop.example/other"],
    evidenceCrawlRunId: "run-d",
  };

  test("the task's own website, first affected page and the two exact crawls", () => {
    expect(whatChangedRequest(task)).toEqual({
      taskId: "t1",
      websiteId: "w1",
      ruleId: "TECH_TITLE_TOO_LONG",
      url: URL,
      verifiedCrawlRunId: "run-v",
      detectingCrawlRunId: "run-d",
      fixedObservedAt: V,
      detectedAt: D,
    });
  });

  test("nothing for an unsupported rule, a task that is not a returned fix, or missing evidence", () => {
    for (const t of [
      { ...task, title: "Image without alt text (TECH_IMAGE_MISSING_ALT)" },
      { ...task, title: "Site is down", issueId: "i1" },
      { ...task, reappeared: null },
      {
        ...task,
        reappeared: { ...task.reappeared!, verifiedCrawlRunId: null },
      },
      { ...task, evidenceCrawlRunId: null },
      { ...task, urls: [] },
    ])
      expect(whatChangedRequest(t)).toBeNull();
  });
});
