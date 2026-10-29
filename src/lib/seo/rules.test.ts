import { describe, expect, test } from "vitest";
import {
  analyzePage,
  analyzeSite,
  siteFindingPages,
  type SeoPage,
} from "./rules";

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
        // Not thin: a noindex page is reported once, as noindex.
        "TECH_STRUCTURED_DATA_INVALID",
        "TECH_IMAGE_MISSING_ALT",
      ].sort(),
    );
    expect(ids(page({ wordCount: 20 }))).toEqual(["TECH_THIN_CONTENT"]);
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

describe("content quality uses main content and respects noindex", () => {
  // A WordPress theme adds header, menu, sidebar and footer text: the page
  // totals 900 words, but its main content is the default post.
  const HELLO = page({
    url: "https://site.example/hello-world/",
    title: "Hello world! - MOH MAYA COTTAGES & CAFE",
    h1: ["Hello world!"],
    wordCount: 900,
    mainWords: 52,
    mainText: [
      "Hello world!",
      "Welcome to WordPress. This is your first post. Edit or delete it, then start writing!",
      "Hi, this is a comment.",
    ],
  });

  test("thin content is judged on main-content words when stored", () => {
    const thin = analyzePage(HELLO, "site.example").find(
      (f) => f.ruleId === "TECH_THIN_CONTENT",
    );
    expect(thin?.evidence).toEqual({
      url: HELLO.url,
      wordCount: 52,
      minWords: 200,
      measuredOn: "main content",
      pageWordCount: 900,
    });
    // Without stored main content (older crawls), the page total is used.
    expect(ids(page({ wordCount: 900, mainWords: null }))).toEqual([]);
    expect(ids(page({ wordCount: 150 }))).toEqual(["TECH_THIN_CONTENT"]);
  });

  test("the default WordPress post is placeholder content, despite substantial theme text", () => {
    const f = analyzePage(HELLO, "site.example").find(
      (x) => x.ruleId === "TECH_PLACEHOLDER_CONTENT",
    );
    expect(f).toMatchObject({
      severity: "MEDIUM",
      evidence: {
        placeholder: "WordPress “Hello world!” post",
        signals: [
          "default body text",
          "default URL /hello-world/",
          "default title or H1",
        ],
        mainWords: 52,
      },
    });
  });

  test("placeholder signals: body text alone or URL and title together; never the title alone", () => {
    const placeholder = (over: Partial<SeoPage>) =>
      ids(page({ wordCount: 600, ...over })).includes(
        "TECH_PLACEHOLDER_CONTENT",
      );
    // Default text moved to another URL and retitled: still the default post.
    expect(
      placeholder({
        url: "https://site.example/news/welcome/",
        title: "Welcome",
        mainText: ["Welcome to WordPress. This is your first post."],
      }),
    ).toBe(true);
    // Default URL and title, content not stored (older crawl).
    expect(
      placeholder({
        url: "https://site.example/sample-page/",
        title: "Sample Page | Site",
      }),
    ).toBe(true);
    // A real post titled "Hello world!" at its own URL, with real content.
    expect(
      placeholder({
        url: "https://site.example/blog/we-are-open/",
        title: "Hello world!",
        h1: ["Hello world!"],
        mainText: ["We opened our cafe in Kasol this spring."],
      }),
    ).toBe(false);
    // The default URL with a real, edited page.
    expect(
      placeholder({
        url: "https://site.example/hello-world/",
        title: "Our first season in Kasol",
        mainText: ["We opened our cafe in Kasol this spring."],
      }),
    ).toBe(false);
  });

  test("a noindex placeholder or thin page is reported only as noindex", () => {
    expect(ids({ ...HELLO, robotsMetaRaw: "noindex, follow" })).toEqual([
      "TECH_NOINDEX",
    ]);
  });
});

describe("legal pages: routine snippet findings are marked, never dropped", () => {
  const short = (over: Partial<SeoPage>) =>
    analyzePage(
      page({ metaDescription: "Privacy policy of the site.", ...over }),
      "site.example",
    ).find((f) => f.ruleId === "TECH_META_DESCRIPTION_TOO_SHORT")!;

  test("a privacy policy's short description keeps its severity and is marked legal", () => {
    const f = short({
      url: "https://mohmaya.example/privacy-policy/",
      title: "Privacy Policy - MOH MAYA COTTAGES & CAFE",
      h1: ["Privacy Policy"],
    });
    expect(f.severity).toBe("LOW");
    expect(f.evidence).toMatchObject({ pageKind: "legal", actualLength: 27 });
  });

  test("both signals are needed: a legal URL or policy wording alone is not enough", () => {
    expect(
      short({
        url: "https://site.example/privacy-policy/",
        title: "How we protect guests",
      }).evidence.pageKind,
    ).toBeUndefined();
    expect(
      short({
        url: "https://site.example/blog/guest-guide/",
        title: "Our privacy policy, explained for guests",
      }).evidence.pageKind,
    ).toBeUndefined();
  });

  test("non-routine findings on legal pages are untouched", () => {
    const legal = {
      url: "https://site.example/terms-and-conditions/",
      title: "Terms and Conditions",
      h1: ["Terms and Conditions"],
    };
    const noindex = analyzePage(
      page({ ...legal, robotsMetaRaw: "noindex" }),
      "site.example",
    ).find((f) => f.ruleId === "TECH_NOINDEX")!;
    expect(noindex.evidence.pageKind).toBeUndefined();
    const error = analyzePage(
      page({ ...legal, httpStatus: 500 }),
      "site.example",
    );
    expect(error.map((f) => [f.ruleId, f.severity])).toEqual([
      ["TECH_HTTP_ERROR", "HIGH"],
    ]);
  });
});

describe("local business structured data: complete, incomplete and absent", () => {
  const hotel = (data: object, valid = true) => ({
    valid,
    data: valid ? data : null,
    error: valid ? null : "Unexpected token",
  });
  const site = (pages: SeoPage[]) =>
    analyzeSite(pages, { robotsTxtStatus: "found", sitemapUrlsDiscovered: 3 })
      .filter((f) => f.ruleId === "TECH_LOCAL_BUSINESS_INCOMPLETE")
      .map((f) => f.evidence);
  // Rank Math style: a graph with the business and other nodes (Moh Maya).
  const MOH_MAYA_GRAPH = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["Hotel", "Organization"],
        "@id": "https://mm.example/#organization",
        name: "Moh Maya Cottages & Cafe",
        url: "https://mm.example",
      },
      { "@type": "WebSite", name: "Moh Maya" },
    ],
  };

  test("Moh Maya: a Hotel with only a name and URL, on every page, is one finding", () => {
    const pages = ["/", "/hello-world/", "/privacy-policy/"].map((path, i) =>
      page({
        id: `p${i}`,
        url: `https://mm.example${path}`,
        title: `Page ${i} title for the valley stay`,
        metaDescription: `A distinct description number ${i} for this page of the site.`,
        telLinks: 4,
        structuredData: [hotel(MOH_MAYA_GRAPH)],
      }),
    );
    expect(site(pages)).toEqual([
      {
        entity: "Moh Maya Cottages & Cafe",
        types: ["Hotel", "Organization"],
        missing: ["address", "telephone"],
        telephoneLinksOnPage: 4,
        count: 3,
        urls: pages.map((p) => p.url),
      },
    ]);
  });

  test("complete markup, or a field present on any copy, raises nothing", () => {
    const complete = {
      "@type": "Hotel",
      name: "Complete Stay",
      address: { "@type": "PostalAddress", addressLocality: "Sosan" },
      telephone: "+91 00000 00000",
    };
    expect(
      site([page({ telLinks: 2, structuredData: [hotel(complete)] })]),
    ).toEqual([]);
    const partA = {
      "@type": "Hotel",
      "@id": "#biz",
      name: "Split",
      address: "Somewhere",
    };
    const partB = {
      "@type": "Hotel",
      "@id": "#biz",
      name: "Split",
      telephone: "123",
    };
    expect(
      site([
        page({
          id: "a",
          url: "https://site.example/a",
          telLinks: 1,
          structuredData: [hotel(partA)],
        }),
        page({
          id: "b",
          url: "https://site.example/b",
          telLinks: 1,
          structuredData: [hotel(partB)],
        }),
      ]),
    ).toEqual([]);
  });

  test("telephone is asked for only when the page shows phone links; address always", () => {
    const noPhoneShown = site([
      page({
        telLinks: 0,
        structuredData: [hotel({ "@type": "Restaurant", name: "Cafe" })],
      }),
    ]);
    expect(noPhoneShown).toEqual([
      expect.objectContaining({ missing: ["address"] }),
    ]);
    expect(noPhoneShown[0]).not.toHaveProperty("telephoneLinksOnPage");
    // Older crawls without contact signals: telephone is never asked for.
    expect(
      site([
        page({
          structuredData: [
            hotel({ "@type": "Hotel", name: "Old", address: "X" }),
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test("malformed JSON-LD is reported as invalid only, never as incomplete", () => {
    const p = page({ telLinks: 3, structuredData: [hotel({}, false)] });
    expect(site([p])).toEqual([]);
    expect(ids(p)).toEqual(["TECH_STRUCTURED_DATA_INVALID"]);
    // A valid but incomplete Hotel is not invalid.
    const q = page({
      telLinks: 3,
      structuredData: [hotel({ "@type": "Hotel", name: "Q" })],
    });
    expect(ids(q)).toEqual([]);
  });

  test("several entities are judged separately; non-local types are ignored", () => {
    const found = site([
      page({
        telLinks: 1,
        structuredData: [
          hotel({ "@type": "Hotel", name: "Stay A" }),
          hotel({
            "@type": "Restaurant",
            name: "Cafe B",
            address: "Main road",
          }),
          hotel({ "@type": "Organization", name: "Brand only" }),
          hotel({ "@type": "WebSite", name: "Site" }),
        ],
      }),
    ]);
    expect(found.map((e) => [e.entity, e.missing])).toEqual([
      ["Stay A", ["address", "telephone"]],
      ["Cafe B", ["telephone"]],
    ]);
  });
});

describe("site findings keep their complete page list apart from the evidence sample", () => {
  test("a duplicate title on 25 pages stores 20 URLs and count 25, and lists all 25", () => {
    const pages = Array.from({ length: 25 }, (_, i) =>
      page({
        id: `p${i}`,
        url: `https://site.example/p${i}`,
        title: "Same title on every page",
      }),
    );
    const facts = { robotsTxtStatus: "found", sitemapUrlsDiscovered: 25 };
    const [dup] = analyzeSite(pages, facts).filter(
      (f) => f.ruleId === "TECH_DUPLICATE_TITLE",
    );
    expect(dup.evidence).toMatchObject({ count: 25 });
    expect((dup.evidence.urls as string[]).length).toBe(20);
    expect(siteFindingPages(pages, facts).get(dup.fingerprint)).toEqual(
      pages.map((p) => p.url),
    );
  });
});
