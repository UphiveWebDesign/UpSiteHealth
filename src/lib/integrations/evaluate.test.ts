import { describe, expect, test } from "vitest";
import type { PageTags } from "@/lib/crawler/html";
import {
  evaluateIntegrations,
  gtmIdsFromCrawl,
  type EvidencePage,
  type IntegrationEvidence,
  type IntegrationKey,
} from "./evaluate";
import type { ProbeResult } from "./probe";

const SITE = "https://a.example";
const T = new Date("2026-10-20T10:00:00Z");
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

const probe = (o: Partial<ProbeResult> = {}): IntegrationEvidence["probe"] => ({
  checkedAt: T,
  result: {
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
  },
});

function evaluate(
  pages: EvidencePage[] | null,
  p: IntegrationEvidence["probe"] = null,
  status: "COMPLETED" | "PARTIAL" = "COMPLETED",
) {
  const list = evaluateIntegrations({
    websiteUrl: SITE,
    crawl: pages ? { status, analyzedAt: T, pages } : null,
    probe: p,
  });
  return (key: IntegrationKey) => list.find((s) => s.key === key)!;
}

describe("detection is never verification", () => {
  test("a GA4 ID on every page is 'detected', with the limitation stated", () => {
    const ga4 = evaluate([
      page("/", { ga4: ["G-ABC123"] }),
      page("/a", { ga4: ["G-ABC123"] }),
    ])("GA4");
    expect(ga4.state).toBe("detected");
    expect(ga4.headline).toBe(
      "GA4 tag detected · data collection not verified",
    );
    expect(ga4.problems).toEqual([]);
    expect(ga4.limitations.join(" ")).toContain(
      "does not show that data reaches Google Analytics",
    );
  });

  test("a published GTM container is still only 'detected'", () => {
    const gtm = evaluate(
      [page("/", { gtm: ["GTM-AB12CD"] })],
      probe({
        gtm: [
          {
            id: "GTM-AB12CD",
            status: "available",
            httpStatus: 200,
            error: null,
            ga4Ids: ["G-ZZZ999"],
          },
        ],
      }),
    );
    expect(gtm("GTM").state).toBe("detected");
    // GA4 seen inside the public container is detection too.
    expect(gtm("GA4")).toMatchObject({ state: "detected", problems: [] });
    expect(gtm("GA4").evidence.join(" ")).toContain(
      "published Google Tag Manager container",
    );
  });

  test("a Search Console token is 'detected', never verified", () => {
    const gsc = evaluate(
      [page("/", { googleSiteVerification: ["tok"] })],
      probe(),
    )("GSC");
    expect(gsc.state).toBe("detected");
    expect(gsc.headline).toContain("property not verified here");
  });
});

describe("missing versus not measured", () => {
  test("no crawl: not checked, not missing", () => {
    const s = evaluate(null);
    for (const key of ["GA4", "GTM", "CANONICAL", "SCHEMA"] as const) {
      expect(s(key).state, key).toBe("not-checked");
      expect(s(key).problems, key).toEqual([]);
    }
    expect(s("ROBOTS").state).toBe("not-checked");
    expect(s("SITEMAP").state).toBe("not-checked");
  });

  test("a crawl from before tag detection is 'Not measured'", () => {
    const s = evaluate([page("/", null), page("/a", null)]);
    expect(s("GA4")).toMatchObject({ state: "not-checked", problems: [] });
    expect(s("GA4").headline).toMatch(/^Not measured/);
    expect(s("GTM").state).toBe("not-checked");
  });

  test("measured and absent is missing (measurement, not a ranking penalty)", () => {
    const ga4 = evaluate([page("/"), page("/a")])("GA4");
    expect(ga4.state).toBe("needs-attention");
    expect(ga4.benefit).toBe("measurement");
    expect(ga4.problems.map((p) => p.code)).toEqual(["MISSING"]);
    expect(JSON.stringify(ga4).toLowerCase()).not.toContain("ranking");
  });

  test("GTM present but container not inspected yet: GA4 is not called missing", () => {
    expect(evaluate([page("/", { gtm: ["GTM-AB12CD"] })])("GA4").state).toBe(
      "not-checked",
    );
  });

  test("error pages and unparsed pages are not counted as missing the tag", () => {
    const ga4 = evaluate([
      page("/", { ga4: ["G-ABC123"] }),
      page("/err", {}, { httpStatus: 500 }),
      page("/pdf", {}, { resourceType: "PDF" }),
    ])("GA4");
    expect(ga4.state).toBe("detected");
    expect(ga4.evidence[0]).toContain("1 of 1 crawled pages");
  });
});

describe("problems", () => {
  test("partial coverage lists the untagged pages", () => {
    const ga4 = evaluate([
      page("/", { ga4: ["G-ABC123"] }),
      page("/a"),
      page("/b"),
    ])("GA4");
    const partial = ga4.problems.find((p) => p.code === "PARTIAL")!;
    expect(partial.urls).toEqual([`${SITE}/a`, `${SITE}/b`]);
    expect(partial.severity).toBe("MEDIUM");
  });

  test("duplicate GA4 and duplicate GTM containers", () => {
    const s = evaluate([
      page("/", {
        ga4: ["G-ABC123", "G-ABC123"],
        gtm: ["GTM-AB12CD", "GTM-ZZ99YY"],
      }),
    ]);
    expect(s("GA4").problems.map((p) => p.code)).toContain("DUPLICATED");
    expect(s("GTM").problems.map((p) => p.code)).toContain("DUPLICATED");
    expect(s("GA4").state).toBe("needs-attention");
  });

  test("outdated Universal Analytics", () => {
    const ga4 = evaluate([page("/", { ga4: ["G-ABC123"], ua: ["UA-1234-1"] })])(
      "GA4",
    );
    const ua = ga4.problems.find((p) => p.code === "OUTDATED")!;
    expect(ua.summary).toContain("UA-1234-1");
    expect(ua.summary).toContain("no longer processes");
  });

  test("an unpublished GTM container is broken", () => {
    const gtm = evaluate(
      [page("/", { gtm: ["GTM-AB12CD"] })],
      probe({
        gtm: [
          {
            id: "GTM-AB12CD",
            status: "not-found",
            httpStatus: 404,
            error: null,
            ga4Ids: [],
          },
        ],
      }),
    )("GTM");
    expect(gtm.state).toBe("needs-attention");
    expect(gtm.problems[0]).toMatchObject({
      code: "BROKEN_GTM_AB12CD",
      severity: "HIGH",
      confidence: "medium",
    });
  });

  test("a GTM availability error is reported as unchecked, not broken", () => {
    const gtm = evaluate(
      [page("/", { gtm: ["GTM-AB12CD"] })],
      probe({
        gtm: [
          {
            id: "GTM-AB12CD",
            status: "error",
            httpStatus: null,
            error: "TIMEOUT",
            ga4Ids: [],
          },
        ],
      }),
    )("GTM");
    expect(gtm.state).toBe("detected");
    expect(gtm.evidence.join(" ")).toContain("could not be checked (TIMEOUT)");
  });
});

describe("robots.txt and sitemap (functional checks)", () => {
  test("verified when fetched and sound", () => {
    const s = evaluate([page("/"), page("/a")], probe());
    expect(s("ROBOTS").state).toBe("verified");
    expect(s("SITEMAP").state).toBe("verified");
  });

  test("robots.txt blocking everything is critical; server errors are high", () => {
    const blocked = evaluate(
      null,
      probe({
        robots: {
          status: "found",
          httpStatus: 200,
          error: null,
          blocksAll: true,
          sitemaps: [],
        },
      }),
    )("ROBOTS");
    expect(blocked.state).toBe("needs-attention");
    expect(blocked.problems[0]).toMatchObject({
      code: "BLOCKED",
      severity: "CRITICAL",
    });
    const error = evaluate(
      null,
      probe({
        robots: {
          status: "error",
          httpStatus: 503,
          error: null,
          blocksAll: null,
          sitemaps: [],
        },
      }),
    )("ROBOTS");
    expect(error.problems[0]).toMatchObject({
      code: "BROKEN",
      severity: "HIGH",
    });
  });

  test("sitemap URLs that error or are noindex, checked against the crawl", () => {
    const sm = evaluate(
      [page("/"), page("/a", {}, { httpStatus: 404 })],
      probe(),
    )("SITEMAP");
    expect(sm.problems.map((p) => p.code)).toEqual(["LISTS_ERRORS"]);
    expect(sm.problems[0].urls).toEqual([`${SITE}/a`]);
    expect(sm.state).toBe("needs-attention");
  });

  test("no sitemap anywhere is missing; an unreachable one is broken", () => {
    const missing = probe({
      robots: {
        status: "missing",
        httpStatus: 404,
        error: null,
        blocksAll: null,
        sitemaps: [],
      },
      sitemaps: {
        source: "default",
        files: [
          {
            url: `${SITE}/sitemap.xml`,
            httpStatus: 404,
            error: null,
            urlCount: null,
            isIndex: false,
          },
        ],
        totalUrls: 0,
        sampleUrls: [],
      },
    });
    expect(evaluate(null, missing)("SITEMAP").problems[0].code).toBe("MISSING");
    const broken = probe({
      sitemaps: {
        source: "robots",
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
    expect(evaluate(null, broken)("SITEMAP").problems[0].code).toBe("BROKEN");
  });
});

describe("canonical and structured data", () => {
  test("canonical to an error page needs attention; a partial crawl is not 'verified'", () => {
    const s = evaluate([
      page("/", {}, { canonicalUrl: `${SITE}/gone` }),
      page("/gone", {}, { httpStatus: 404 }),
    ]);
    expect(s("CANONICAL").problems.map((p) => p.code)).toEqual(["TO_ERROR"]);
    expect(evaluate([page("/")], null, "PARTIAL")("CANONICAL").state).toBe(
      "detected",
    );
    expect(evaluate([page("/")])("CANONICAL").state).toBe("verified");
  });

  test("structured data: types listed, never 'verified'; invalid blocks are not a second task", () => {
    const valid = page("/");
    (valid.result as { structuredData: unknown[] }).structuredData = [
      { valid: true, data: { "@type": "Organization" }, error: null },
    ];
    const invalid = page("/b");
    (invalid.result as { structuredData: unknown[] }).structuredData = [
      { valid: false, data: null, error: "x" },
    ];
    expect(evaluate([valid])("SCHEMA")).toMatchObject({ state: "detected" });
    expect(evaluate([valid])("SCHEMA").evidence[0]).toContain("Organization");
    const bad = evaluate([valid, invalid])("SCHEMA");
    expect(bad.state).toBe("needs-attention");
    expect(bad.problems[0].task).toBe(false);
  });
});

test("gtmIdsFromCrawl feeds the probe with unique container IDs", () => {
  expect(
    gtmIdsFromCrawl({
      websiteUrl: SITE,
      crawl: {
        status: "COMPLETED",
        analyzedAt: T,
        pages: [
          page("/", { gtm: ["GTM-AB12CD"] }),
          page("/a", { gtm: ["GTM-AB12CD"] }),
        ],
      },
      probe: null,
    }),
  ).toEqual(["GTM-AB12CD"]);
});

describe("missing versus unmeasured (M4, L1)", () => {
  const gtmCheck = (
    status: "available" | "not-found" | "error",
    ga4Ids: string[] = [],
  ) =>
    probe({
      gtm: [
        {
          id: "GTM-AB12CD",
          status,
          httpStatus:
            status === "available" ? 200 : status === "not-found" ? 404 : null,
          error: status === "error" ? "TIMEOUT" : null,
          ga4Ids,
        },
      ],
    });
  const gtmPages = [page("/", { gtm: ["GTM-AB12CD"] })];

  test("GA4 behind GTM: inconclusive container inspection is never 'missing'", () => {
    for (const p of [null, gtmCheck("error"), gtmCheck("not-found")]) {
      const ga4 = evaluate(gtmPages, p)("GA4");
      expect(ga4).toMatchObject({ state: "not-checked", problems: [] });
      expect(ga4.headline).toContain("could not be inspected");
    }
    expect(
      evaluate(gtmPages, gtmCheck("available"))("GA4").problems[0],
    ).toMatchObject({
      code: "MISSING",
      confidence: "medium",
    });
    expect(
      evaluate(gtmPages, gtmCheck("available", ["G-ZZZ999"]))("GA4").state,
    ).toBe("detected");
  });

  test("Search Console: a setup task needs both page source and DNS to have been read", () => {
    const dnsError = probe({
      dnsTxt: { status: "error", googleTokens: 0, error: "ESERVFAIL" },
    });
    const unmeasured = evaluate([page("/", null)], probe())("GSC");
    expect(unmeasured).toMatchObject({ state: "not-checked", problems: [] });
    expect(unmeasured.headline).toMatch(/^Not measured/);
    expect(evaluate([page("/")], dnsError)("GSC")).toMatchObject({
      state: "not-checked",
      problems: [],
    });
    expect(
      evaluate([page("/")], probe())("GSC").problems.map((p) => p.code),
    ).toEqual(["UNCONFIRMED"]);
    // Positive evidence from either source is enough to say "detected".
    const dnsToken = probe({
      dnsTxt: { status: "ok", googleTokens: 1, error: null },
    });
    expect(evaluate([page("/", null)], dnsToken)("GSC").state).toBe("detected");
  });

  test("Bing: 'Not in use' only when page source and the file were both checked", () => {
    const fileError = probe({
      bing: { status: "error", httpStatus: 503, error: null },
    });
    expect(evaluate([page("/", null)], probe())("BING").state).toBe(
      "not-checked",
    );
    expect(evaluate([page("/")], fileError)("BING").state).toBe("not-checked");
    expect(evaluate([page("/")], null)("BING").state).toBe("not-checked");
    expect(evaluate([page("/")], probe())("BING").state).toBe("not-detected");
    expect(
      evaluate([page("/", { bingSiteVerification: ["X"] })], fileError)("BING")
        .state,
    ).toBe("detected");
  });
});

describe("robots.txt and Googlebot (L2)", () => {
  const robots = (o: Partial<ProbeResult["robots"]>) =>
    probe({
      robots: {
        status: "found",
        httpStatus: 200,
        error: null,
        blocksAll: false,
        sitemaps: [`${SITE}/sitemap.xml`],
        ...o,
      },
    });
  test("generic block with Googlebot allowed is not 'blocks all crawlers'", () => {
    const r = evaluate(
      null,
      robots({ blocksAll: true, blocksGooglebot: false }),
    )("ROBOTS");
    expect(r.problems.map((p) => [p.code, p.severity])).toEqual([
      ["BLOCKS_OTHERS", "MEDIUM"],
    ]);
    expect(r.headline).toBe("Allows Googlebot, blocks other crawlers");
  });
  test("Googlebot blocked by its own group is critical even if others are allowed", () => {
    const r = evaluate(
      null,
      robots({ blocksAll: false, blocksGooglebot: true }),
    )("ROBOTS");
    expect(r.problems[0]).toMatchObject({
      code: "BLOCKED",
      severity: "CRITICAL",
    });
    expect(r.headline).toBe("Blocks Googlebot");
  });
  test("older probes without the Googlebot field fall back to the generic rules", () => {
    const r = evaluate(
      null,
      robots({ blocksAll: true, blocksGooglebot: undefined }),
    )("ROBOTS");
    expect(r.problems[0].code).toBe("BLOCKED");
  });
});
