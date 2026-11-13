import { describe, expect, test } from "vitest";
import { parsePage, type PlatformSignals } from "./html";
import { detectPlatform, readPlatformSignals } from "./platform";

const SITE = "https://shop.example";

const html = (head: string, body = "", bodyAttrs = "") =>
  `<!doctype html><html><head>${head}</head><body ${bodyAttrs}>${body}<p>Hello</p></body></html>`;

describe("platform signals in the page source", () => {
  test("a WordPress page: generator, REST API link and same-site assets", () => {
    const { platform } = parsePage(
      html(
        `<meta name="generator" content="WordPress 6.6.2">
         <link rel="https://api.w.org/" href="${SITE}/wp-json/">
         <link rel="stylesheet" href="/wp-content/themes/x/style.css">
         <script src="https://www.shop.example/wp-includes/js/jquery/jquery.min.js"></script>`,
        `<img src="/wp-content/uploads/2026/10/a.jpg" alt="">`,
      ),
      `${SITE}/`,
    ).result;
    expect(platform).toEqual({
      v: 1,
      generators: ["WordPress 6.6.2"],
      wpAssets: 2,
      wpRestLink: true,
      wooAssets: 0,
      wooBodyClasses: [],
    });
  });

  test("a WooCommerce page: generator, plugin assets and body classes", () => {
    const { platform } = parsePage(
      html(
        `<meta name="generator" content="WordPress 6.6.2">
         <meta name="generator" content="WooCommerce 9.3.3">
         <link rel="preload stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">`,
        `<script src="/wp-content/plugins/woocommerce/assets/js/frontend/cart.min.js"></script>`,
        `class="home page woocommerce-no-js woocommerce-page my-woocommerce-skin"`,
      ),
      `${SITE}/shop/`,
    ).result;
    expect(platform.generators).toEqual([
      "WordPress 6.6.2",
      "WooCommerce 9.3.3",
    ]);
    expect(platform.wooAssets).toBe(2);
    expect(platform.wpAssets).toBe(2);
    expect(platform.wooBodyClasses).toEqual([
      "woocommerce-no-js",
      "woocommerce-page",
    ]);
  });

  test("other sites' WordPress files, links and non-asset link relations are not evidence", () => {
    const { platform } = parsePage(
      html(
        `<link rel="canonical" href="${SITE}/wp-content/x">
         <link rel="alternate" href="/wp-content/feed.xml">
         <script src="https://cdn.other.example/wp-includes/js/x.js"></script>`,
        `<img src="https://blog.other.example/wp-content/uploads/a.jpg" alt="">
         <a href="/wp-content/uploads/brochure.pdf">Brochure</a>`,
      ),
      `${SITE}/`,
    ).result;
    expect(platform).toMatchObject({ wpAssets: 0, wpRestLink: false });
  });

  test("a non-WordPress page records empty signals; generators are clipped, de-duplicated and capped", () => {
    const empty = parsePage(html("<title>x</title>"), `${SITE}/`).result
      .platform;
    expect(empty).toEqual({
      v: 1,
      generators: [],
      wpAssets: 0,
      wpRestLink: false,
      wooAssets: 0,
      wooBodyClasses: [],
    });
    const many = parsePage(
      html(
        [
          `<meta name="generator" content="${"A".repeat(200)}">`,
          ...Array.from(
            { length: 8 },
            (_, i) => `<meta name="generator" content="Gen ${i % 6}">`,
          ),
        ].join(""),
      ),
      `${SITE}/`,
    ).result.platform;
    expect(many.generators).toHaveLength(5);
    expect(many.generators[0]).toHaveLength(80);
    expect(new Set(many.generators).size).toBe(5);
  });

  test("uploaded media is not evidence: it outlives a move away from WordPress", () => {
    const { platform } = parsePage(
      html(
        `<link rel="icon" href="/wp-content/uploads/2026/10/icon.png">
         <link rel="preload" href="/wp-content/uploads/hero.webp">`,
        `<img src="/wp-content/uploads/2026/10/a.jpg" alt="">`,
      ),
      `${SITE}/`,
    ).result;
    expect(platform.wpAssets).toBe(0);
  });

  test("relative asset paths resolve against <base href>", () => {
    const { platform } = parsePage(
      html(
        `<base href="https://other.example/"><script src="wp-includes/js/x.js"></script>`,
      ),
      `${SITE}/`,
    ).result;
    expect(platform.wpAssets).toBe(0);
  });
});

// Builders for stored crawl results.
const signals = (s: Partial<PlatformSignals> = {}): PlatformSignals => ({
  v: 1,
  generators: [],
  wpAssets: 0,
  wpRestLink: false,
  wooAssets: 0,
  wooBodyClasses: [],
  ...s,
});
const page = (s: Partial<PlatformSignals> = {}) => ({
  result: { headings: { h1: [] }, platform: signals(s) },
});
const historical = { result: { headings: { h1: ["Old"] }, links: [] } };

describe("detectPlatform", () => {
  test("two families of WordPress evidence on one page: WordPress, high", () => {
    const d = detectPlatform([
      page({ generators: ["WordPress 6.6.2"], wpRestLink: true }),
    ]);
    expect(d).toMatchObject({
      platform: "wordpress",
      confidence: "high",
      reason: "detected",
      pagesChecked: 1,
      pagesWithSignals: 1,
    });
    expect(d.signals.map((s) => s.kind).sort()).toEqual([
      "wp-generator",
      "wp-rest-link",
    ]);
    expect(d.signals.find((s) => s.kind === "wp-generator")?.label).toBe(
      "Generator tag “WordPress 6.6.2”",
    );
  });

  test("one family on two pages: WordPress, medium", () => {
    const d = detectPlatform([page({ wpAssets: 4 }), page({ wpAssets: 1 })]);
    expect(d).toMatchObject({ platform: "wordpress", confidence: "medium" });
    expect(d.signals).toEqual([
      {
        kind: "wp-assets",
        label: "WordPress theme, plugin or core files",
        pages: 2,
      },
    ]);
  });

  test("one family on one page is too weak to act on", () => {
    const d = detectPlatform([page({ wpAssets: 9 }), page()]);
    expect(d).toMatchObject({
      platform: "unknown",
      confidence: null,
      reason: "weak",
    });
    expect(d.signals).toHaveLength(1);
  });

  test("WooCommerce on top of WordPress, high when both are strong", () => {
    const d = detectPlatform([
      page({
        generators: ["WordPress 6.6", "WooCommerce 9.3.3"],
        wpRestLink: true,
        wpAssets: 3,
        wooAssets: 2,
      }),
    ]);
    expect(d).toMatchObject({ platform: "woocommerce", confidence: "high" });
  });

  test("WooCommerce with one family on two pages is medium", () => {
    const d = detectPlatform([
      page({ wpRestLink: true, wpAssets: 2, wooBodyClasses: ["woocommerce"] }),
      page({ wpAssets: 1, wooBodyClasses: ["woocommerce-page"] }),
    ]);
    expect(d).toMatchObject({ platform: "woocommerce", confidence: "medium" });
  });

  test("weak WooCommerce evidence leaves WordPress, with the signal listed", () => {
    const d = detectPlatform([
      page({ wpRestLink: true, wpAssets: 2, wooBodyClasses: ["woocommerce"] }),
      page({ wpAssets: 1 }),
    ]);
    expect(d).toMatchObject({ platform: "wordpress", confidence: "high" });
    expect(d.signals.map((s) => s.kind)).toContain("woo-body-class");
  });

  test("WooCommerce implies WordPress: its generator counts as WordPress evidence", () => {
    const d = detectPlatform([
      page({ generators: ["WooCommerce 9.3.3"] }),
      page({ generators: ["WooCommerce 9.3.3"] }),
    ]);
    expect(d).toMatchObject({ platform: "woocommerce", confidence: "medium" });
  });

  test("WooCommerce body classes alone are not WordPress evidence", () => {
    const d = detectPlatform([
      page({ wooBodyClasses: ["woocommerce"] }),
      page({ wooBodyClasses: ["woocommerce"] }),
    ]);
    expect(d).toMatchObject({ platform: "unknown", reason: "no-signals" });
  });

  test("recorded signals with nothing in them: unknown, not 'another platform'", () => {
    expect(detectPlatform([page(), page()])).toMatchObject({
      platform: "unknown",
      confidence: null,
      reason: "no-signals",
      pagesWithSignals: 2,
      signals: [],
    });
  });

  test("WordPress evidence next to another platform's generator is a conflict", () => {
    const d = detectPlatform([
      page({ generators: ["WordPress 6.6"], wpRestLink: true }),
      page({ generators: ["Wix.com Website Builder"] }),
    ]);
    expect(d).toMatchObject({
      platform: "unknown",
      reason: "conflicting",
      otherPlatforms: ["Wix"],
    });
  });

  test("another platform's generator alone", () => {
    expect(
      detectPlatform([
        page({ generators: ["Drupal 10 (https://www.drupal.org)"] }),
      ]),
    ).toMatchObject({
      platform: "unknown",
      reason: "other-platform",
      otherPlatforms: ["Drupal"],
    });
  });

  test("WordPress plugins' generators neither prove nor contradict WordPress", () => {
    const d = detectPlatform([
      page({ generators: ["Elementor 3.24.0", "Site Kit by Google 1.1"] }),
      page({ generators: ["Elementor 3.24.0"] }),
    ]);
    expect(d).toMatchObject({ platform: "unknown", reason: "no-signals" });
  });

  test("historical crawls without signals are 'not recorded', never 'not WordPress'", () => {
    for (const pages of [
      [historical, historical],
      [{ result: null }, { result: "x" }, { result: [1] }],
      [],
    ])
      expect(detectPlatform(pages)).toMatchObject({
        platform: "unknown",
        reason: "not-recorded",
        pagesWithSignals: 0,
        malformed: 0,
      });
  });

  test("a mix of historical and new pages uses the new ones only", () => {
    const d = detectPlatform([
      historical,
      page({ wpRestLink: true, wpAssets: 1 }),
    ]);
    expect(d).toMatchObject({
      platform: "wordpress",
      pagesChecked: 2,
      pagesWithSignals: 1,
    });
  });

  test("malformed signals are counted and ignored", () => {
    const bad = [
      { result: { platform: "WordPress" } },
      { result: { platform: [] } },
      { result: { platform: { ...signals(), v: 2 } } },
      { result: { platform: { ...signals(), generators: "WordPress" } } },
      { result: { platform: { ...signals(), wpAssets: -1 } } },
      { result: { platform: { ...signals(), wpAssets: Number.NaN } } },
      { result: { platform: { ...signals(), wpRestLink: "yes" } } },
      { result: { platform: null } },
    ];
    expect(detectPlatform(bad)).toMatchObject({
      platform: "unknown",
      reason: "not-recorded",
      malformed: bad.length,
    });
    const d = detectPlatform([
      ...bad,
      page({ generators: ["WordPress 6.6"], wpAssets: 1 }),
    ]);
    expect(d).toMatchObject({
      platform: "wordpress",
      confidence: "high",
      malformed: bad.length,
      pagesWithSignals: 1,
    });
  });

  test("readPlatformSignals distinguishes absent from unreadable", () => {
    expect(readPlatformSignals(undefined)).toBeNull();
    expect(readPlatformSignals({ links: [] })).toBeNull();
    expect(readPlatformSignals({ platform: 1 })).toBe("malformed");
    expect(readPlatformSignals({ platform: signals() })).toEqual(signals());
  });

  test("signals stored by parsePage are read back by the detector", () => {
    const stored = parsePage(
      html(
        `<meta name="generator" content="WordPress 6.6.2"><link rel="https://api.w.org/" href="/wp-json/">`,
      ),
      `${SITE}/`,
    ).result;
    // Round trip through JSON, as crawl_pages.result is stored.
    const d = detectPlatform([{ result: JSON.parse(JSON.stringify(stored)) }]);
    expect(d).toMatchObject({ platform: "wordpress", confidence: "high" });
  });
});
