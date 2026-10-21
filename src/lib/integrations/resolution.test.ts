import { describe, expect, test } from "vitest";
import type { PageTags } from "@/lib/crawler/html";
import {
  gtmBrokenCode,
  type EvidencePage,
  type IntegrationEvidence,
} from "./evaluate";
import type { ProbeResult } from "./probe";
import { confirmResolved } from "./resolution";

const SITE = "https://a.example";
const T1 = new Date("2026-10-01T00:00:00Z");
const T2 = new Date("2026-10-08T00:00:00Z");
const noTags: PageTags = {
  ga4: [],
  gtagLoaders: 0,
  gtm: [],
  ua: [],
  googleSiteVerification: [],
  bingSiteVerification: [],
};

function page(
  path: string,
  tags: Partial<PageTags> | null = {},
  o: Partial<EvidencePage> = {},
): EvidencePage {
  return {
    url: `${SITE}${path}`,
    status: "CRAWLED",
    httpStatus: 200,
    resourceType: "HTML",
    finalUrl: `${SITE}${path}`,
    canonicalUrl: `${SITE}${path}`,
    robotsMetaRaw: null,
    depth: path === "/" ? 0 : 1,
    result: {
      images: [],
      structuredData: [],
      ...(tags ? { tags: { ...noTags, ...tags } } : {}),
    },
    ...o,
  };
}
const skipped = (path: string) =>
  page(path, null, { status: "SKIPPED", httpStatus: null, result: null });

function probe(o: Partial<ProbeResult> = {}): ProbeResult {
  return {
    kind: "integration-probe",
    version: 1,
    robots: {
      status: "found",
      httpStatus: 200,
      error: null,
      blocksAll: false,
      sitemaps: [`${SITE}/sitemap.xml`],
    },
    sitemaps: {
      source: "robots",
      files: [
        {
          url: `${SITE}/sitemap.xml`,
          httpStatus: 200,
          error: null,
          urlCount: 2,
          isIndex: false,
        },
      ],
      totalUrls: 2,
      sampleUrls: [`${SITE}/`, `${SITE}/a`],
    },
    dnsTxt: { status: "ok", googleTokens: 0, error: null },
    bing: { status: "missing", httpStatus: 404, error: null },
    gtm: [],
    ...o,
  };
}
const ev = (
  pages: EvidencePage[] | null,
  p: ProbeResult | null,
  at = T2,
  status: "COMPLETED" | "PARTIAL" = "COMPLETED",
): IntegrationEvidence => ({
  websiteUrl: SITE,
  crawl: pages ? { status, analyzedAt: at, pages } : null,
  probe: p ? { checkedAt: at, result: p } : null,
});

const failedRobots = probe({
  robots: {
    status: "error",
    httpStatus: null,
    error: "TIMEOUT",
    blocksAll: null,
    sitemaps: [],
  },
});

describe("probe-based tasks need a conclusive recheck", () => {
  test("blocked robots.txt followed by a failed fetch stays open", () => {
    const r = confirmResolved("ROBOTS", "BLOCKED", ev(null, failedRobots), []);
    expect(r).toMatchObject({ conclusive: false });
  });
  test("blocked robots.txt that now loads and allows crawling is resolved", () => {
    expect(confirmResolved("ROBOTS", "BLOCKED", ev(null, probe()), [])).toEqual(
      {
        conclusive: true,
      },
    );
  });

  test("whole-site block resolved once Googlebot is allowed, even if others stay blocked", () => {
    const googleOnly = probe({
      robots: {
        status: "found",
        httpStatus: 200,
        error: null,
        blocksAll: true,
        blocksGooglebot: false,
        sitemaps: [],
      },
    });
    expect(
      confirmResolved("ROBOTS", "BLOCKED", ev(null, googleOnly), []).conclusive,
    ).toBe(true);
    expect(
      confirmResolved("ROBOTS", "BLOCKS_OTHERS", ev(null, googleOnly), [])
        .conclusive,
    ).toBe(false);
  });

  test("missing sitemap followed by a fetch failure stays open", () => {
    const failed = probe({
      sitemaps: {
        source: "default",
        files: [
          {
            url: `${SITE}/sitemap.xml`,
            httpStatus: null,
            error: "TIMEOUT",
            urlCount: null,
            isIndex: false,
          },
        ],
        totalUrls: 0,
        sampleUrls: [],
      },
    });
    // The failure itself is reported as BROKEN, and MISSING is not resolved.
    expect(
      confirmResolved("SITEMAP", "MISSING", ev(null, failed), []).conclusive,
    ).toBe(false);
    expect(
      confirmResolved("SITEMAP", "MISSING", ev(null, probe()), []).conclusive,
    ).toBe(true);
  });

  test("a sitemap file that fails to load is not 'fixed' by every file failing", () => {
    const allFail = probe({
      sitemaps: {
        source: "robots",
        files: [
          {
            url: `${SITE}/sitemap.xml`,
            httpStatus: 503,
            error: null,
            urlCount: null,
            isIndex: false,
          },
        ],
        totalUrls: 0,
        sampleUrls: [],
      },
    });
    expect(
      confirmResolved("SITEMAP", "FILE_ERRORS", ev(null, allFail), [])
        .conclusive,
    ).toBe(false);
  });

  test("unpublished GTM container followed by a timeout or unexpected response stays open", () => {
    const code = gtmBrokenCode("GTM-AB12CD");
    const pages = [page("/", { gtm: ["GTM-AB12CD"] })];
    for (const check of [
      { status: "error" as const, httpStatus: null, error: "TIMEOUT" },
      {
        status: "error" as const,
        httpStatus: 200,
        error: "UNEXPECTED_RESPONSE",
      },
      { status: "error" as const, httpStatus: 500, error: null },
    ]) {
      const p = probe({ gtm: [{ id: "GTM-AB12CD", ga4Ids: [], ...check }] });
      expect(confirmResolved("GTM", code, ev(pages, p), []).conclusive).toBe(
        false,
      );
    }
    const published = probe({
      gtm: [
        {
          id: "GTM-AB12CD",
          status: "available",
          httpStatus: 200,
          error: null,
          ga4Ids: [],
        },
      ],
    });
    expect(
      confirmResolved("GTM", code, ev(pages, published), []).conclusive,
    ).toBe(true);
  });

  test("a removed GTM container is resolved only by a completed crawl that scanned tags", () => {
    const code = gtmBrokenCode("GTM-AB12CD");
    expect(
      confirmResolved("GTM", code, ev([page("/"), page("/a")], probe()), [])
        .conclusive,
    ).toBe(true);
    expect(
      confirmResolved(
        "GTM",
        code,
        ev([page("/"), page("/a")], probe(), T2, "PARTIAL"),
        [],
      ).conclusive,
    ).toBe(false);
  });
});

describe("page-based tasks need the affected pages re-examined", () => {
  const before = (pages: EvidencePage[]) => [ev(pages, probe(), T1)];

  test("partial GA4 coverage: a partial crawl that skipped the untagged page stays open", () => {
    const history = before([page("/", { ga4: ["G-ABC123"] }), page("/b")]);
    const current = ev(
      [page("/", { ga4: ["G-ABC123"] }), skipped("/b")],
      probe(),
      T2,
      "PARTIAL",
    );
    expect(confirmResolved("GA4", "PARTIAL", current, history)).toMatchObject({
      conclusive: false,
      reason:
        "1 of the 1 affected pages were not re-examined by the latest crawl.",
    });
    const fixed = ev(
      [page("/", { ga4: ["G-ABC123"] }), page("/b", { ga4: ["G-ABC123"] })],
      probe(),
      T2,
      "PARTIAL",
    );
    expect(confirmResolved("GA4", "PARTIAL", fixed, history).conclusive).toBe(
      true,
    );
  });

  test("duplicate tags and old UA IDs: not resolved when the page was not revisited", () => {
    const cases: Array<[string, Partial<PageTags>]> = [
      ["DUPLICATED", { ga4: ["G-ABC123", "G-ABC123"] }],
      ["OUTDATED", { ga4: ["G-ABC123"], ua: ["UA-1234-1"] }],
    ];
    for (const [code, tags] of cases) {
      const history = before([
        page("/", { ga4: ["G-ABC123"] }),
        page("/x", tags),
      ]);
      const current = ev(
        [page("/", { ga4: ["G-ABC123"] }), skipped("/x")],
        probe(),
        T2,
        "PARTIAL",
      );
      expect(
        confirmResolved("GA4", code, current, history).conclusive,
        code,
      ).toBe(false);
      const clean = ev(
        [page("/", { ga4: ["G-ABC123"] }), page("/x", { ga4: ["G-ABC123"] })],
        probe(),
      );
      expect(
        confirmResolved("GA4", code, clean, history).conclusive,
        code,
      ).toBe(true);
    }
  });

  test("a page that now returns an error or lost tag data is not re-examined", () => {
    const history = before([page("/", { ga4: ["G-ABC123"] }), page("/b")]);
    for (const b of [page("/b", {}, { httpStatus: 500 }), page("/b", null)]) {
      const current = ev([page("/", { ga4: ["G-ABC123"] }), b], probe());
      // (an older-shape page is "not measured"; the evaluator may also stop
      // reporting the problem, but resolution still needs the page)
      expect(
        confirmResolved("GA4", "PARTIAL", current, history).conclusive,
      ).toBe(false);
    }
  });

  test("canonical problems need the source pages revisited and a completed crawl", () => {
    const history = before([
      page("/", {}, { canonicalUrl: `${SITE}/gone` }),
      page("/gone", {}, { httpStatus: 404 }),
    ]);
    const partial = ev([page("/"), skipped("/gone")], probe(), T2, "PARTIAL");
    expect(
      confirmResolved("CANONICAL", "TO_ERROR", partial, history).conclusive,
    ).toBe(false);
    const complete = ev([page("/"), page("/gone")], probe());
    expect(
      confirmResolved("CANONICAL", "TO_ERROR", complete, history).conclusive,
    ).toBe(true);
  });

  test("broken sitemap URLs: not resolved if the URL was not recrawled", () => {
    const history = before([page("/"), page("/a", {}, { httpStatus: 404 })]);
    const current = ev([page("/"), skipped("/a")], probe(), T2, "PARTIAL");
    expect(
      confirmResolved("SITEMAP", "LISTS_ERRORS", current, history).conclusive,
    ).toBe(false);
    // Removed from a fully sampled sitemap: no recheck needed.
    const removed = probe({
      sitemaps: { ...probe().sitemaps, totalUrls: 1, sampleUrls: [`${SITE}/`] },
    });
    expect(
      confirmResolved(
        "SITEMAP",
        "LISTS_ERRORS",
        ev([page("/"), skipped("/a")], removed, T2, "PARTIAL"),
        history,
      ).conclusive,
    ).toBe(true);
    // Recrawled and fixed.
    expect(
      confirmResolved(
        "SITEMAP",
        "LISTS_ERRORS",
        ev([page("/"), page("/a")], probe()),
        history,
      ).conclusive,
    ).toBe(true);
  });

  test("without earlier evidence, only a completed crawl confirms", () => {
    const partial = ev(
      [page("/", { ga4: ["G-ABC123"] })],
      probe(),
      T2,
      "PARTIAL",
    );
    expect(confirmResolved("GA4", "PARTIAL", partial, []).conclusive).toBe(
      false,
    );
    const complete = ev([page("/", { ga4: ["G-ABC123"] })], probe());
    expect(confirmResolved("GA4", "PARTIAL", complete, []).conclusive).toBe(
      true,
    );
  });
});

test("a problem that is still detected, or an unchecked integration, is never resolved", () => {
  expect(
    confirmResolved("ROBOTS", "BLOCKED", ev(null, null), []).conclusive,
  ).toBe(false);
  const stillBlocked = probe({
    robots: {
      status: "found",
      httpStatus: 200,
      error: null,
      blocksAll: true,
      sitemaps: [],
    },
  });
  expect(
    confirmResolved("ROBOTS", "BLOCKED", ev(null, stillBlocked), []).conclusive,
  ).toBe(false);
});
