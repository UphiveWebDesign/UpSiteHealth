import { describe, expect, test } from "vitest";
import { analyzePage, analyzeSite, type SeoPage } from "./rules";

const page = (over: Partial<SeoPage> = {}): SeoPage => ({
  id: "p1",
  url: "https://site.example/a",
  httpStatus: 200,
  title: "A perfectly reasonable page title",
  metaDescription:
    "A meta description that is comfortably within the recommended length range for snippets.",
  canonicalUrl: null,
  robotsMetaRaw: null,
  h1Count: 1,
  wordCount: 500,
  images: [],
  structuredData: [],
  ...over,
});

const ids = (p: SeoPage) => analyzePage(p, "site.example").map((f) => f.ruleId);

describe("analyzePage", () => {
  test("a healthy page has no findings", () => {
    expect(ids(page())).toEqual([]);
  });

  test("production rules keep their ids, severities, thresholds and evidence", () => {
    const [short] = analyzePage(page({ title: "Too short" }), "site.example");
    expect(short).toMatchObject({
      ruleId: "TECH_TITLE_TOO_SHORT",
      scope: "PAGE",
      severity: "LOW",
      fingerprint: "TECH_TITLE_TOO_SHORT::https://site.example/a",
      evidence: {
        url: "https://site.example/a",
        actualLength: 9,
        minLength: 15,
      },
    });
    const [long] = analyzePage(page({ title: "x".repeat(61) }), "site.example");
    expect(long.evidence).toEqual({
      url: "https://site.example/a",
      actualLength: 61,
      maxLength: 60,
    });
    const [descShort] = analyzePage(
      page({ metaDescription: "short" }),
      "site.example",
    );
    expect(descShort).toMatchObject({
      ruleId: "TECH_META_DESCRIPTION_TOO_SHORT",
      evidence: { minLength: 50 },
    });
    const [descLong] = analyzePage(
      page({ metaDescription: "d".repeat(161) }),
      "site.example",
    );
    expect(descLong).toMatchObject({
      ruleId: "TECH_META_DESCRIPTION_TOO_LONG",
      evidence: { maxLength: 160 },
    });
    const [canonical] = analyzePage(
      page({ canonicalUrl: "https://other.example/a" }),
      "site.example",
    );
    expect(canonical).toMatchObject({
      ruleId: "TECH_CANONICAL_EXTERNAL",
      severity: "INFO",
      evidence: {
        canonicalUrl: "https://other.example/a",
        canonicalHost: "other.example",
      },
    });
    const [dims] = analyzePage(
      page({
        images: [
          { url: "x", alt: "a", width: "1", height: "1", loading: null },
          { url: "y", alt: "b", width: null, height: "1", loading: null },
        ],
      }),
      "site.example",
    );
    expect(dims).toMatchObject({
      ruleId: "TECH_IMAGE_MISSING_DIMENSIONS",
      severity: "INFO",
      evidence: { affectedCount: 1, totalCount: 2 },
    });
  });

  test("boundaries are inclusive of the recommended range", () => {
    expect(ids(page({ title: "t".repeat(15) }))).toEqual([]);
    expect(ids(page({ title: "t".repeat(60) }))).toEqual([]);
    expect(ids(page({ metaDescription: "d".repeat(50) }))).toEqual([]);
    expect(ids(page({ metaDescription: "d".repeat(160) }))).toEqual([]);
  });

  test("www canonical is internal; decorative alt is fine", () => {
    expect(ids(page({ canonicalUrl: "https://www.site.example/a" }))).toEqual(
      [],
    );
    expect(
      ids(
        page({
          images: [
            { url: "x", alt: "", width: "1", height: "1", loading: null },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("error pages report only the HTTP error", () => {
    expect(ids(page({ httpStatus: 404, title: null }))).toEqual([
      "TECH_HTTP_ERROR",
    ]);
  });

  test("other reconstructed rules", () => {
    expect(
      ids(
        page({
          title: null,
          metaDescription: null,
          h1Count: 0,
          robotsMetaRaw: "NOINDEX, follow",
          wordCount: 20,
          structuredData: [{ valid: false, data: null, error: "x" }],
          images: [
            { url: "x", alt: null, width: "1", height: "1", loading: null },
          ],
        }),
      ).sort(),
    ).toEqual(
      [
        "TECH_TITLE_MISSING",
        "TECH_META_DESCRIPTION_MISSING",
        "TECH_H1_MISSING",
        "TECH_NOINDEX",
        "TECH_THIN_CONTENT",
        "TECH_STRUCTURED_DATA_INVALID",
        "TECH_IMAGE_MISSING_ALT",
      ].sort(),
    );
    expect(ids(page({ h1Count: 3 }))).toEqual(["TECH_H1_MULTIPLE"]);
  });
});

describe("analyzeSite", () => {
  test("groups duplicate titles and descriptions with stable fingerprints", () => {
    const pages = [
      page({
        id: "1",
        url: "https://site.example/1",
        title: "Same title for both pages",
      }),
      page({
        id: "2",
        url: "https://site.example/2",
        title: "Same title for both pages",
      }),
      page({
        id: "3",
        url: "https://site.example/3",
        title: "A unique title here",
      }),
    ];
    const findings = analyzeSite(pages, {
      robotsTxtStatus: "found",
      sitemapUrlsDiscovered: 3,
    });
    const dupTitle = findings.find((f) => f.ruleId === "TECH_DUPLICATE_TITLE");
    expect(dupTitle).toMatchObject({
      scope: "SITE",
      crawlPageId: null,
      evidence: {
        count: 2,
        urls: ["https://site.example/1", "https://site.example/2"],
      },
    });
    expect(dupTitle!.fingerprint).toMatch(
      /^TECH_DUPLICATE_TITLE::site:[0-9a-f]{16}$/,
    );
    // All three share the default description.
    expect(
      findings.find((f) => f.ruleId === "TECH_DUPLICATE_META_DESCRIPTION")
        ?.evidence,
    ).toMatchObject({
      count: 3,
    });
    expect(
      analyzeSite(pages, {
        robotsTxtStatus: "found",
        sitemapUrlsDiscovered: 3,
      }),
    ).toEqual(findings);
  });

  test("missing robots.txt and sitemap", () => {
    expect(
      analyzeSite([], {
        robotsTxtStatus: "missing",
        sitemapUrlsDiscovered: 0,
      }).map((f) => f.ruleId),
    ).toEqual(["TECH_ROBOTS_TXT_MISSING", "TECH_SITEMAP_MISSING"]);
  });
});
