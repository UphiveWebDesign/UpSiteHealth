import { describe, expect, test } from "vitest";
import { parsePage } from "./html";
import { parseRobots, parseSitemap } from "./robots";
import {
  isInternalUrl,
  normalizeCrawlUrl,
  resourceTypeFromContentType,
  resourceTypeFromPath,
} from "./urls";

describe("normalizeCrawlUrl", () => {
  test.each([
    ["/about#team", "https://a.com/x", "https://a.com/about"],
    ["HTTPS://A.COM:443//b//c", undefined, "https://a.com/b/c"],
    ["http://a.com:80/", undefined, "http://a.com/"],
    ["?q=1", "https://a.com/p", "https://a.com/p?q=1"],
    ["mailto:x@a.com", "https://a.com/", null],
    ["javascript:void(0)", "https://a.com/", null],
    ["https://u:p@a.com/", undefined, null],
  ])("%s (base %s) → %s", (href, base, expected) => {
    expect(normalizeCrawlUrl(href, base)).toBe(expected);
  });

  test("internal links treat www as the same site", () => {
    expect(isInternalUrl("https://www.a.com/x", "a.com")).toBe(true);
    expect(isInternalUrl("https://blog.a.com/x", "a.com")).toBe(false);
  });

  test("resource types", () => {
    expect(resourceTypeFromPath("https://a.com/logo.PNG")).toBe("IMAGE");
    expect(resourceTypeFromPath("https://a.com/guide.pdf")).toBe("PDF");
    expect(resourceTypeFromPath("https://a.com/page")).toBeNull();
    expect(resourceTypeFromContentType("text/html; charset=utf-8")).toBe(
      "HTML",
    );
    expect(resourceTypeFromContentType("application/json")).toBe("OTHER");
  });
});

describe("parseRobots", () => {
  const robots = parseRobots(
    [
      "User-agent: *",
      "Disallow: /private",
      "Allow: /private/public",
      "Disallow: /*.pdf$",
      "",
      "User-agent: OtherBot",
      "Disallow: /",
      "Sitemap: https://a.com/sitemap.xml",
    ].join("\n"),
    "UpSiteHealthBot/1.0 (+https://upsitehealth.example/crawler)",
  );

  test.each([
    ["https://a.com/", true],
    ["https://a.com/private/x", false],
    ["https://a.com/private/public/x", true],
    ["https://a.com/files/a.pdf", false],
    ["https://a.com/files/a.pdf?x", true],
  ])("%s allowed=%s", (url, allowed) => {
    expect(robots.isAllowed(url)).toBe(allowed);
  });

  test("collects sitemaps", () => {
    expect(robots.sitemaps).toEqual(["https://a.com/sitemap.xml"]);
  });

  test("a group naming our bot overrides the * group", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: UpSiteHealthBot\nDisallow: /admin",
      "UpSiteHealthBot/1.0",
    );
    expect(r.isAllowed("https://a.com/blog")).toBe(true);
    expect(r.isAllowed("https://a.com/admin")).toBe(false);
  });
});

test("parseSitemap reads urlsets and indexes", () => {
  expect(
    parseSitemap(
      "<urlset><url><loc> https://a.com/a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[https://a.com/b]]></loc></url></urlset>",
    ),
  ).toEqual({
    urls: ["https://a.com/a?x=1&y=2", "https://a.com/b"],
    isIndex: false,
  });
  expect(
    parseSitemap(
      "<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>",
    ).isIndex,
  ).toBe(true);
});

describe("parsePage", () => {
  const html = `<!doctype html><html lang="en-GB"><head>
    <meta charset="utf-8"><title>  Home   page </title>
    <meta name="Description" content="A description">
    <meta name="robots" content="noindex, follow">
    <link rel="canonical" href="https://other.example/home">
    <script type="application/ld+json">{"@type":"Organization"}</script>
    <script type="application/ld+json">{broken</script>
    </head><body>
    <h1>Welcome</h1><h2>One</h2><h2>Two</h2>
    <p>Some words here <script>var hidden = "not counted";</script></p>
    <a href="/about#x">About us</a>
    <a href="https://www.site.example/contact" rel="nofollow ugc">Contact</a>
    <a href="https://elsewhere.example/" rel="sponsored">Ad</a>
    <a href="mailto:me@site.example">Mail</a>
    <img src="/logo.png" alt="Logo" width="100" height="50" loading="lazy">
    <img src="/hero.jpg">
    </body></html>`;
  const page = parsePage(html, "https://site.example/");

  test("extracts the indexed columns", () => {
    expect(page).toMatchObject({
      title: "Home page",
      metaDescription: "A description",
      canonicalUrl: "https://other.example/home",
      robotsMetaRaw: "noindex, follow",
      language: "en-GB",
    });
    // Welcome One Two Some words here About us Contact Ad Mail (script excluded)
    expect(page.wordCount).toBe(11);
  });

  test("result JSON matches the production shape (plus the additive tags key)", () => {
    // Production keys are unchanged; `tags` is new and absent on older rows.
    expect(Object.keys(page.result).sort()).toEqual([
      "charset",
      "headings",
      "images",
      "links",
      "structuredData",
      "tags",
    ]);
    expect(page.result.charset).toBe("utf-8");
    expect(page.result.headings).toEqual({
      h1: ["Welcome"],
      h2: ["One", "Two"],
      h3: [],
    });
    expect(page.result.links).toEqual([
      {
        url: "https://site.example/about",
        anchorText: "About us",
        type: "internal",
        rel: null,
        nofollow: false,
        sponsored: false,
        ugc: false,
      },
      {
        url: "https://www.site.example/contact",
        anchorText: "Contact",
        type: "internal",
        rel: "nofollow ugc",
        nofollow: true,
        sponsored: false,
        ugc: true,
      },
      expect.objectContaining({ type: "external", sponsored: true }),
    ]);
    expect(page.result.images[0]).toEqual({
      url: "https://site.example/logo.png",
      alt: "Logo",
      width: "100",
      height: "50",
      loading: "lazy",
    });
    expect(page.result.images[1]).toMatchObject({ alt: null, width: null });
    expect(page.result.structuredData.map((s) => s.valid)).toEqual([
      true,
      false,
    ]);
  });
});

describe("tracking and verification tags", () => {
  const tagsOf = (head: string, body = "") =>
    parsePage(
      `<html><head>${head}</head><body>${body}</body></html>`,
      "https://example.com/",
    ).result.tags;

  test("a standard GA4 install lists its ID once", () => {
    expect(
      tagsOf(`<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
        <script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}
        gtag('js', new Date()); gtag('config', 'G-ABC123');</script>`),
    ).toMatchObject({ ga4: ["G-ABC123"], gtagLoaders: 1, ua: [], gtm: [] });
  });

  test("duplicates stay visible: config twice, loader twice", () => {
    const t =
      tagsOf(`<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
      <script>gtag('config','G-ABC123'); gtag("config", "G-ABC123");</script>`);
    expect(t.ga4).toEqual(["G-ABC123", "G-ABC123"]);
    expect(t.gtagLoaders).toBe(2);
  });

  test("GTM snippet with its noscript fallback is one container", () => {
    const t = tagsOf(
      `<script>(function(w,d,s,l,i){var j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','GTM-AB12CD');</script>`,
      `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-AB12CD"></iframe></noscript>`,
    );
    expect(t.gtm).toEqual(["GTM-AB12CD"]);
  });

  test("old Universal Analytics IDs are recognised", () => {
    expect(
      tagsOf(`<script>ga('create', 'UA-12345-1', 'auto');</script>
        <script async src="https://www.googletagmanager.com/gtag/js?id=UA-999999-2"></script>`)
        .ua,
    ).toEqual(["UA-12345-1", "UA-999999-2"]);
  });

  test("verification meta tags; look-alike hosts are ignored", () => {
    const t = tagsOf(`<meta name="google-site-verification" content="abc">
      <meta name="msvalidate.01" content="XYZ">
      <script src="https://googletagmanager.com.evil.example/gtag/js?id=G-FAKE1234"></script>`);
    expect(t).toMatchObject({
      googleSiteVerification: ["abc"],
      bingSiteVerification: ["XYZ"],
      ga4: [],
      gtagLoaders: 0,
    });
  });
});
