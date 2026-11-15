import { describe, expect, test } from "vitest";
import { findingOutcome } from "@/lib/recommendations/lifecycle";
import { analyzeCrawl, linkIndex, type StoredCrawlPage } from "./analyze";
import {
  describeGap,
  evidenceLinkingPages,
  linkingSummary,
  pageRecheckGap,
  type RecheckContext,
} from "./recheck";
import { internalRedirect, LINKING_PAGES_SHOWN } from "./rules";

/**
 * X-Robots-Tag noindex, linking pages on broken-page findings, redirect
 * chains and internal links to redirects: from stored crawl rows through
 * analyzeCrawl (what sync and compare run) to the recheck that decides
 * whether a missing finding is fixed (what sync resolves on).
 */

const SITE = "https://site.example";
const run = {
  status: "COMPLETED" as const,
  robotsTxtStatus: "found",
  sitemapUrlsDiscovered: 1,
};
type Link = { url: string; type: "internal" | "external" };
const internal = (path: string): Link => ({
  url: `${SITE}${path}`,
  type: "internal",
});

/** An analysed HTML page with the given links and response headers. */
function page(
  path: string,
  over: {
    links?: Link[];
    xRobotsTag?: string[] | null;
    robotsMetaRaw?: string | null;
    wordCount?: number;
    linksOmitted?: number;
    title?: string;
  } = {},
): StoredCrawlPage {
  const title = over.title ?? `A distinct page title for ${path}`;
  return {
    id: path,
    url: `${SITE}${path}`,
    finalUrl: `${SITE}${path}`,
    redirectCount: 0,
    status: "CRAWLED",
    skipReason: null,
    resourceType: "HTML",
    httpStatus: 200,
    title,
    metaDescription: `A meta description that is comfortably long enough for ${path} here.`,
    canonicalUrl: null,
    robotsMetaRaw: over.robotsMetaRaw ?? null,
    h1Count: 1,
    wordCount: over.wordCount ?? 400,
    discoverySource: "LINK",
    discoveredFromUrl: `${SITE}/`,
    result: {
      headings: { h1: [title], h2: [], h3: [] },
      images: [],
      links: over.links ?? [],
      structuredData: [],
      linksOmitted: over.linksOmitted ?? 0,
      ...(over.xRobotsTag === null
        ? {}
        : { responseHeaders: { xRobotsTag: over.xRobotsTag ?? [] } }),
    },
  };
}

/** A URL that answered with an error (the crawler stores no content). */
const broken = (
  path: string,
  httpStatus = 404,
  from = "/",
): StoredCrawlPage => ({
  ...page(path),
  httpStatus,
  title: null,
  metaDescription: null,
  h1Count: null,
  wordCount: null,
  discoveredFromUrl: `${SITE}${from}`,
  result: null,
});

/** A URL that redirected (no content: it is analysed at its final URL). */
const redirecting = (
  path: string,
  to: string,
  redirectCount: number | null,
  httpStatus = 200,
): StoredCrawlPage => ({
  ...page(path),
  finalUrl: to.startsWith("http") ? to : `${SITE}${to}`,
  redirectCount,
  httpStatus,
  title: null,
  metaDescription: null,
  h1Count: null,
  wordCount: null,
  result: null,
});

const notFetched = (
  path: string,
  status: StoredCrawlPage["status"],
): StoredCrawlPage => ({
  ...page(path),
  status,
  skipReason: status === "SKIPPED" ? "BUDGET_EXCEEDED" : null,
  httpStatus: null,
  redirectCount: null,
  result: null,
});

const analyse = (rows: StoredCrawlPage[]) =>
  analyzeCrawl(rows, run, "site.example");
const findings = (rows: StoredCrawlPage[], ruleId: string) =>
  analyse(rows).drafts.filter((d) => d.ruleId === ruleId);

/** The recheck sync.ts applies to a page finding missing from `rows`. */
function recheck(
  ruleId: string,
  evidence: Record<string, unknown>,
  rows: StoredCrawlPage[],
  runStatus: RecheckContext["run"]["status"] = "COMPLETED",
) {
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  return pageRecheckGap(ruleId, byUrl.get(evidence.url as string), {
    run: { status: runStatus },
    evidence,
    pageAt: (u) => byUrl.get(u),
    // The current crawl's own links, as sync.ts passes them.
    links: linkIndex(rows, runStatus),
  });
}

const analyseAs = (rows: StoredCrawlPage[], status: "COMPLETED" | "PARTIAL") =>
  analyzeCrawl(rows, { ...run, status }, "site.example");

// ─── Feature 2: X-Robots-Tag noindex ────────────────────────────────────────

describe("X-Robots-Tag noindex", () => {
  const noindexOf = (rows: StoredCrawlPage[]) =>
    findings(rows, "TECH_NOINDEX").map((d) => d.evidence);

  test("header only: reported, with the header as its source", () => {
    expect(noindexOf([page("/members", { xRobotsTag: ["noindex"] })])).toEqual([
      {
        url: `${SITE}/members`,
        robotsMeta: null,
        noindexSource: "header",
        xRobotsTag: ["noindex"],
        headerAgents: ["all"],
      },
    ]);
  });

  test("meta only and both sources", () => {
    expect(
      noindexOf([page("/a", { robotsMetaRaw: "noindex", xRobotsTag: [] })]),
    ).toEqual([
      { url: `${SITE}/a`, robotsMeta: "noindex", noindexSource: "meta" },
    ]);
    expect(
      noindexOf([
        page("/b", {
          robotsMetaRaw: "noindex",
          xRobotsTag: ["googlebot: noindex"],
        }),
      ])[0],
    ).toMatchObject({ noindexSource: "both", headerAgents: ["googlebot"] });
  });

  test("case, several header lines and user-agent directives", () => {
    expect(noindexOf([page("/c", { xRobotsTag: ["NOINDEX"] })])).toHaveLength(
      1,
    );
    expect(
      noindexOf([
        page("/d", { xRobotsTag: ["otherbot: nofollow", "noindex"] }),
      ]),
    ).toHaveLength(1);
    expect(
      noindexOf([page("/e", { xRobotsTag: ["Bingbot: NONE"] })])[0],
    ).toMatchObject({ headerAgents: ["bingbot"] });
    // A directive for some other crawler does not keep the page out of search.
    expect(
      noindexOf([page("/f", { xRobotsTag: ["otherbot: noindex"] })]),
    ).toEqual([]);
  });

  test("missing header, or a crawl that did not record headers: not reported", () => {
    expect(noindexOf([page("/g", { xRobotsTag: [] })])).toEqual([]);
    expect(noindexOf([page("/h", { xRobotsTag: null })])).toEqual([]);
  });

  test("a header-noindex page is not also reported as thin content", () => {
    const rows = [page("/thin", { xRobotsTag: ["noindex"], wordCount: 20 })];
    const ids = analyse(rows).drafts.map((d) => d.ruleId);
    expect(ids).toContain("TECH_NOINDEX");
    expect(ids).not.toContain("TECH_THIN_CONTENT");
    // And a thin-content finding that left for this reason is "not applicable".
    expect(
      findingOutcome(
        {
          ruleId: "TECH_THIN_CONTENT",
          scope: "PAGE",
          evidence: { url: `${SITE}/thin` },
        },
        (u) => rows.find((r) => r.url === u) as never,
      ).outcome,
    ).toBe("not-applicable");
  });

  test("recheck: resolved only by a fresh crawl that recorded headers and found no noindex", () => {
    const evidence = { url: `${SITE}/members`, noindexSource: "header" };
    // The header was removed: confirmed.
    expect(
      recheck("TECH_NOINDEX", evidence, [page("/members", { xRobotsTag: [] })]),
    ).toBeNull();
    // Headers not recorded (a crawl stored before capture): not proof.
    expect(
      recheck("TECH_NOINDEX", evidence, [
        page("/members", { xRobotsTag: null }),
      ]),
    ).toEqual({ kind: "missing-data" });
    // Not crawled, skipped, failed, or an error page: kept open.
    expect(recheck("TECH_NOINDEX", evidence, [])).toMatchObject({
      kind: "not-crawled",
    });
    expect(
      recheck("TECH_NOINDEX", evidence, [notFetched("/members", "SKIPPED")]),
    ).toMatchObject({ kind: "not-crawled", skipReason: "BUDGET_EXCEEDED" });
    expect(
      recheck("TECH_NOINDEX", evidence, [notFetched("/members", "FAILED")]),
    ).toEqual({ kind: "fetch-failed" });
    expect(
      recheck("TECH_NOINDEX", evidence, [broken("/members", 500)]),
    ).toEqual({ kind: "http-error", httpStatus: 500 });
  });
});

// ─── Feature 3: the pages that link to a broken URL ─────────────────────────

describe("broken-page findings name every linking page", () => {
  const httpError = (rows: StoredCrawlPage[]) => {
    const [d] = findings(rows, "TECH_HTTP_ERROR");
    return d?.evidence;
  };

  test("one linking page", () => {
    expect(
      httpError([page("/", { links: [internal("/gone")] }), broken("/gone")]),
    ).toMatchObject({
      httpStatus: 404,
      linkedFrom: `${SITE}/`,
      linkingPages: [`${SITE}/`],
      linkingPageCount: 1,
      linkingPagesTruncated: false,
    });
  });

  test("several linking pages, deduplicated and in URL order; external and self links ignored", () => {
    const rows = [
      page("/b", { links: [internal("/gone"), internal("/gone")] }),
      page("/a", {
        links: [internal("/gone"), { url: `${SITE}/gone`, type: "external" }],
      }),
      // An external link to a URL with the same path is not this page.
      page("/c", {
        links: [{ url: "https://other.example/gone", type: "external" }],
      }),
      broken("/gone"),
    ];
    const e = httpError(rows)!;
    expect(e.linkingPages).toEqual([`${SITE}/a`, `${SITE}/b`]);
    expect(e.linkingPageCount).toBe(2);
    // A finding is per broken URL, never per linking page.
    expect(findings(rows, "TECH_HTTP_ERROR")).toHaveLength(1);
  });

  test("more than 20 linking pages: 20 listed, the total kept, marked truncated", () => {
    const sources = Array.from({ length: 25 }, (_, i) =>
      page(`/p${String(i).padStart(2, "0")}`, { links: [internal("/gone")] }),
    );
    const e = httpError([...sources, broken("/gone")])!;
    expect(e.linkingPages).toHaveLength(LINKING_PAGES_SHOWN);
    expect(e.linkingPageCount).toBe(25);
    expect(e.linkingPagesTruncated).toBe(true);
    expect(evidenceLinkingPages(e)).toMatchObject({
      count: 25,
      truncated: true,
    });
  });

  test("no linking page known: the first discoverer is kept, nothing invented", () => {
    const e = httpError([broken("/gone", 404, "/old-sitemap-entry")])!;
    expect(e.linkedFrom).toBe(`${SITE}/old-sitemap-entry`);
    expect(e).not.toHaveProperty("linkingPages");
    expect(evidenceLinkingPages(e).urls).toEqual([]);
  });

  test("partial crawl: analysed pages still count; pages with omitted links are flagged", () => {
    const rows = [
      page("/a", { links: [internal("/gone")] }),
      notFetched("/b", "FAILED"),
      notFetched("/c", "SKIPPED"),
      page("/big", { links: [internal("/gone")], linksOmitted: 12 }),
      broken("/gone"),
    ];
    expect(httpError(rows)).toMatchObject({
      linkingPages: [`${SITE}/a`, `${SITE}/big`],
      linkingPageCount: 2,
      linkingPagesMayBeIncomplete: true,
    });
    expect(linkIndex(rows).incomplete).toBe(true);
  });

  test("recheck: resolved only when the broken URL itself loads in a fresh crawl", () => {
    const evidence = {
      url: `${SITE}/gone`,
      linkingPages: [`${SITE}/a`],
      linkingPageCount: 1,
    };
    // The destination recovered.
    expect(recheck("TECH_HTTP_ERROR", evidence, [page("/gone")])).toBeNull();
    // The linking page dropped out of a partial crawl and nothing reached the
    // broken URL: not proof that it was fixed.
    expect(
      recheck("TECH_HTTP_ERROR", evidence, [notFetched("/a", "SKIPPED")]),
    ).toMatchObject({ kind: "not-crawled" });
    expect(
      recheck("TECH_HTTP_ERROR", evidence, [notFetched("/gone", "FAILED")]),
    ).toEqual({ kind: "fetch-failed" });
    // Still broken: the analysis reports it again (it never reaches recheck).
    expect(
      findings(
        [page("/a", { links: [internal("/gone")] }), broken("/gone")],
        "TECH_HTTP_ERROR",
      ),
    ).toHaveLength(1);
  });
});

// ─── Feature 4: redirect chains and links to redirects ──────────────────────

describe("TECH_REDIRECT_CHAIN", () => {
  const chainOf = (rows: StoredCrawlPage[]) =>
    findings(rows, "TECH_REDIRECT_CHAIN").map((d) => d.evidence);

  test("zero or one redirect is not a chain; two or more is", () => {
    expect(chainOf([page("/direct")])).toEqual([]);
    expect(chainOf([redirecting("/one", "/final/", 1)])).toEqual([]);
    expect(chainOf([redirecting("/two", "/final/", 2)])).toEqual([
      {
        url: `${SITE}/two`,
        finalUrl: `${SITE}/final/`,
        redirectCount: 2,
        finalStatus: 200,
        foundVia: "LINK",
      },
    ]);
    expect(chainOf([redirecting("/five", "/final/", 5)])[0].redirectCount).toBe(
      5,
    );
  });

  test("only what was recorded: no intermediate URLs", () => {
    const [e] = chainOf([redirecting("/two", "/final/", 2)]);
    expect(Object.keys(e).sort()).toEqual(
      ["finalStatus", "finalUrl", "foundVia", "redirectCount", "url"].sort(),
    );
  });

  test("redirects off the site, unknown counts and unfetched URLs are not reported", () => {
    expect(
      chainOf([redirecting("/out", "https://partner.example/x", 3)]),
    ).toEqual([]);
    expect(chainOf([redirecting("/legacy", "/new", null)])).toEqual([]);
    expect(chainOf([notFetched("/loop", "FAILED")])).toEqual([]);
    expect(chainOf([notFetched("/later", "SKIPPED")])).toEqual([]);
    // A chain that only comes back to the same URL is not a move.
    expect(chainOf([redirecting("/same", "/same#top", 2)])).toEqual([]);
  });

  test("a chain ending on an error page is still a chain (the error is its own finding)", () => {
    const rows = [redirecting("/old", "/removed", 2, 404)];
    expect(chainOf(rows)[0]).toMatchObject({ finalStatus: 404 });
    expect(findings(rows, "TECH_HTTP_ERROR")).toHaveLength(1);
    expect(findings(rows, "TECH_LINK_TO_REDIRECT")).toEqual([]);
  });

  test("recheck: resolved by a fresh redirect count below two, never by missing evidence", () => {
    const evidence = { url: `${SITE}/two`, redirectCount: 2 };
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [
        redirecting("/two", "/final/", 1),
      ]),
    ).toBeNull();
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [
        { ...page("/two"), url: `${SITE}/two` },
      ]),
    ).toBeNull();
    // Now a direct error: the chain is gone (the error is reported itself).
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [
        { ...broken("/two"), redirectCount: 0 },
      ]),
    ).toBeNull();
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [
        redirecting("/two", "/final/", null),
      ]),
    ).toEqual({ kind: "missing-data" });
    expect(recheck("TECH_REDIRECT_CHAIN", evidence, [])).toMatchObject({
      kind: "not-crawled",
    });
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [notFetched("/two", "FAILED")]),
    ).toEqual({ kind: "fetch-failed" });
  });

  test("internalRedirect only describes same-site moves", () => {
    const row = (over: Partial<Parameters<typeof internalRedirect>[0]>) => ({
      id: "r",
      url: `${SITE}/a`,
      status: "CRAWLED",
      httpStatus: 200,
      finalUrl: `${SITE}/b`,
      redirectCount: 1,
      ...over,
    });
    expect(internalRedirect(row({}))).toEqual({
      finalUrl: `${SITE}/b`,
      redirectCount: 1,
    });
    // www and bare host are the same site.
    expect(
      internalRedirect(row({ finalUrl: "https://www.site.example/b" })),
    ).not.toBeNull();
    expect(internalRedirect(row({ status: "FAILED" }))).toBeNull();
    expect(internalRedirect(row({ finalUrl: null }))).toBeNull();
    expect(internalRedirect(row({ redirectCount: 0 }))).toBeNull();
  });
});

describe("TECH_LINK_TO_REDIRECT", () => {
  const linkOf = (rows: StoredCrawlPage[]) =>
    findings(rows, "TECH_LINK_TO_REDIRECT").map((d) => d.evidence);

  test("internal links to a redirecting URL: one finding per URL, naming the linking pages", () => {
    const rows = [
      page("/", { links: [internal("/contact-us"), internal("/about")] }),
      page("/about", { links: [internal("/contact-us")] }),
      redirecting("/contact-us", "/contact/", 1),
      page("/contact/"),
    ];
    expect(linkOf(rows)).toEqual([
      {
        url: `${SITE}/contact-us`,
        finalUrl: `${SITE}/contact/`,
        redirectCount: 1,
        finalStatus: 200,
        foundVia: "LINK",
        linkingPages: [`${SITE}/`, `${SITE}/about`],
        linkingPageCount: 2,
        linkingPagesTruncated: false,
        linkingCoverage: "complete",
        pagesAnalysed: 3,
      },
    ]);
  });

  test("not reported without a linking page, with unknown redirect evidence, or for external links", () => {
    // Redirects, but only the sitemap lists it.
    expect(linkOf([redirecting("/old", "/new", 1), page("/new")])).toEqual([]);
    // Linked, but its redirect status is unknown (skipped, failed, not recorded).
    expect(
      linkOf([
        page("/", { links: [internal("/x")] }),
        notFetched("/x", "SKIPPED"),
      ]),
    ).toEqual([]);
    expect(
      linkOf([
        page("/", { links: [internal("/y")] }),
        redirecting("/y", "/z", null),
      ]),
    ).toEqual([]);
    // An external link to another site's redirect is not this site's link.
    expect(
      linkOf([
        page("/", { links: [{ url: `${SITE}/old`, type: "external" }] }),
        redirecting("/old", "/new", 1),
      ]),
    ).toEqual([]);
    // Redirecting off the site (often an intended shortcut).
    expect(
      linkOf([
        page("/", { links: [internal("/go")] }),
        redirecting("/go", "https://partner.example/", 1),
      ]),
    ).toEqual([]);
  });

  describe("recheck: the current crawl's own links decide", () => {
    const evidence = {
      url: `${SITE}/contact-us`,
      finalUrl: `${SITE}/contact/`,
      redirectCount: 1,
      linkingPages: [`${SITE}/`, `${SITE}/about`],
      linkingPageCount: 2,
      linkingPagesTruncated: false,
    };
    const fixedLinks = [
      page("/", { links: [internal("/contact/")] }),
      page("/about", { links: [internal("/contact/")] }),
    ];
    const redirectSkipped = notFetched("/contact-us", "SKIPPED");

    test("the destination no longer redirects: fixed", () => {
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [page("/contact-us")]),
      ).toBeNull();
    });

    test("a complete crawl in which no page links to the URL: fixed", () => {
      // The redirect itself is not crawled any more (nothing links to it).
      expect(recheck("TECH_LINK_TO_REDIRECT", evidence, fixedLinks)).toBeNull();
    });

    test("listed pages fixed, but another page still links to it: kept open", () => {
      const gap = recheck("TECH_LINK_TO_REDIRECT", evidence, [
        ...fixedLinks,
        page("/footer-page", { links: [internal("/contact-us")] }),
      ]);
      expect(gap).toEqual({
        kind: "still-linked",
        from: `${SITE}/footer-page`,
      });
      expect(describeGap(gap!)).toBe(
        "Not rechecked: /footer-page still links to this URL, and the crawl could not confirm whether the URL still redirects.",
      );
    });

    test("a newly discovered page links to it: still reported, or kept open when the URL was not fetched", () => {
      const newSource = page("/new-landing", {
        links: [internal("/contact-us")],
      });
      // The URL was fetched and still redirects: the analysis reports it.
      expect(
        linkOf([
          ...fixedLinks,
          newSource,
          redirecting("/contact-us", "/contact/", 1),
        ])[0],
      ).toMatchObject({ linkingPages: [`${SITE}/new-landing`] });
      // It was not fetched this time: kept open, never fixed.
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [
          ...fixedLinks,
          newSource,
          redirectSkipped,
        ]),
      ).toEqual({ kind: "still-linked", from: `${SITE}/new-landing` });
    });

    test("a partial crawl with no observed link is not proof", () => {
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, fixedLinks, "PARTIAL"),
      ).toEqual({ kind: "incomplete-run", runStatus: "PARTIAL" });
      // Completed, but a page failed or was skipped at the page limit.
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [
          ...fixedLinks,
          notFetched("/blog", "FAILED"),
        ]),
      ).toEqual({ kind: "partial-links" });
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [
          fixedLinks[0],
          notFetched("/about", "SKIPPED"),
        ]),
      ).toEqual({ kind: "partial-links" });
      // A page with more links than the crawler records.
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [
          fixedLinks[0],
          page("/about", { links: [internal("/contact/")], linksOmitted: 3 }),
        ]),
      ).toEqual({ kind: "partial-links" });
    });

    test("a listed page the crawl no longer analyses is not proof either", () => {
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [
          fixedLinks[0],
          broken("/about", 503),
        ]),
      ).toEqual({ kind: "http-error", httpStatus: 503 });
      // Now excluded by robots.txt: outside the crawl's scope, not read.
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [
          fixedLinks[0],
          {
            ...notFetched("/about", "SKIPPED"),
            skipReason: "ROBOTS_DISALLOWED",
          },
        ]),
      ).toMatchObject({ kind: "not-crawled" });
    });

    test("missing or stale evidence never resolves it", () => {
      // No current link evidence passed (only the destination can confirm).
      expect(
        pageRecheckGap(
          "TECH_LINK_TO_REDIRECT",
          redirecting("/contact-us", "/contact/", 1),
          { run: { status: "COMPLETED" }, evidence, pageAt: () => undefined },
        ),
      ).toEqual({ kind: "missing-data" });
      expect(
        pageRecheckGap("TECH_LINK_TO_REDIRECT", page("/contact-us")),
      ).toBeNull();
      // An analysed page stored without links (older crawl format).
      const old = { ...fixedLinks[1], result: { headings: {}, images: [] } };
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [fixedLinks[0], old]),
      ).toEqual({ kind: "partial-links" });
      // The redirect's own count was not recorded.
      expect(
        recheck("TECH_LINK_TO_REDIRECT", evidence, [
          redirecting("/contact-us", "/contact/", null),
          page("/", { links: [internal("/contact-us")] }),
        ]),
      ).toEqual({ kind: "still-linked", from: `${SITE}/` });
    });

    test("a truncated list is fine when the whole current crawl shows no link", () => {
      expect(
        recheck(
          "TECH_LINK_TO_REDIRECT",
          { ...evidence, linkingPageCount: 30, linkingPagesTruncated: true },
          fixedLinks,
        ),
      ).toBeNull();
    });
  });
});

// ─── Corrective pass: crawl coverage of linking evidence (M1) ───────────────

describe("linking evidence says how complete the crawl was", () => {
  const httpErrorOf = (
    rows: StoredCrawlPage[],
    status: "COMPLETED" | "PARTIAL",
  ) =>
    analyseAs(rows, status).drafts.find((d) => d.ruleId === "TECH_HTTP_ERROR")!
      .evidence;
  const linking = [
    page("/", { links: [internal("/gone"), internal("/gone")] }),
    page("/a", { links: [internal("/gone")] }),
    broken("/gone"),
  ];

  test("complete crawl: complete coverage, pages analysed, unique sources", () => {
    expect(httpErrorOf(linking, "COMPLETED")).toMatchObject({
      linkingPageCount: 2,
      linkingCoverage: "complete",
      pagesAnalysed: 2,
    });
    expect(linkingSummary(httpErrorOf(linking, "COMPLETED"))).toBe(
      "linked from 2 pages",
    );
  });

  test("partial crawl (page budget reached): partial coverage, never 'pages' alone", () => {
    const rows = [
      ...linking,
      {
        ...notFetched("/later", "SKIPPED"),
        skipReason: "BUDGET_EXCEEDED" as const,
      },
    ];
    const e = httpErrorOf(rows, "PARTIAL");
    expect(e).toMatchObject({ linkingCoverage: "partial", pagesAnalysed: 2 });
    expect(linkingSummary(e)).toBe("linked from 2 crawled pages");
    // The page-budget skip alone makes it partial, whatever the run says.
    expect(linkIndex(rows, "COMPLETED").coverage).toBe("partial");
  });

  test("a failed page makes coverage partial; robots or depth exclusions do not", () => {
    expect(
      linkIndex([...linking, notFetched("/x", "FAILED")], "COMPLETED").coverage,
    ).toBe("partial");
    expect(
      linkIndex(
        [
          ...linking,
          {
            ...notFetched("/private", "SKIPPED"),
            skipReason: "ROBOTS_DISALLOWED",
          },
          { ...notFetched("/deep", "SKIPPED"), skipReason: "DEPTH_EXCEEDED" },
        ],
        "COMPLETED",
      ).coverage,
    ).toBe("complete");
    expect(linkIndex(linking).coverage).toBe("partial"); // status unknown
  });

  test("more than 20 linking pages keeps the cap, the true total and the coverage", () => {
    const sources = Array.from({ length: 23 }, (_, i) =>
      page(`/s${String(i).padStart(2, "0")}`, { links: [internal("/gone")] }),
    );
    const e = httpErrorOf([...sources, broken("/gone")], "PARTIAL");
    expect(e.linkingPages).toHaveLength(LINKING_PAGES_SHOWN);
    expect(e).toMatchObject({
      linkingPageCount: 23,
      linkingPagesTruncated: true,
      linkingCoverage: "partial",
      pagesAnalysed: 23,
    });
  });
});

// ─── Corrective pass: chains that now end off-site (L4) ─────────────────────

describe("TECH_REDIRECT_CHAIN recheck after a redirect change", () => {
  const evidence = { url: `${SITE}/two`, redirectCount: 2 };

  test("still a two-hop internal chain: reported again (never reaches recheck)", () => {
    expect(
      findings([redirecting("/two", "/final/", 2)], "TECH_REDIRECT_CHAIN"),
    ).toHaveLength(1);
  });

  test("shortened to one hop, or a single redirect off the site: fixed", () => {
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [
        redirecting("/two", "/final/", 1),
      ]),
    ).toBeNull();
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [
        redirecting("/two", "https://partner.example/", 1),
      ]),
    ).toBeNull();
  });

  test("still two or more hops but now ending off the site: kept open, says why", () => {
    const rows = [redirecting("/two", "https://partner.example/", 3)];
    expect(findings(rows, "TECH_REDIRECT_CHAIN")).toEqual([]); // not a new finding
    const gap = recheck("TECH_REDIRECT_CHAIN", evidence, rows);
    expect(gap).toEqual({ kind: "still-chained", redirectCount: 3 });
    expect(describeGap(gap!)).toBe(
      "Not confirmed fixed: the URL still takes 3 redirects (it now ends on another site, which this check does not report as a new chain).",
    );
  });

  test("missing redirect evidence, or a partial crawl that did not fetch the URL: kept open", () => {
    expect(
      recheck("TECH_REDIRECT_CHAIN", evidence, [
        redirecting("/two", "/final/", null),
      ]),
    ).toEqual({ kind: "missing-data" });
    expect(
      recheck(
        "TECH_REDIRECT_CHAIN",
        evidence,
        [notFetched("/two", "SKIPPED")],
        "PARTIAL",
      ),
    ).toMatchObject({ kind: "not-crawled" });
    // The URL itself was fetched in a partial crawl: its own fresh count
    // decides (the chain is a property of that one URL).
    expect(
      recheck(
        "TECH_REDIRECT_CHAIN",
        evidence,
        [redirecting("/two", "/final/", 1)],
        "PARTIAL",
      ),
    ).toBeNull();
  });
});
