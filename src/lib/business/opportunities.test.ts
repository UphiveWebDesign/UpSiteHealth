import { describe, expect, test } from "vitest";
import { parsePage } from "@/lib/crawler/html";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { heldReason } from "@/lib/recommendations/generate";
import { businessKey } from "@/lib/recommendations/identity";
import {
  analyzeCoverage,
  coverageDrafts,
  coverageMeta,
  offeringOfTitle,
  rekeyScore,
  rekeyTasks,
  type CoverageResult,
} from "./coverage";
import type { Fact } from "./facts";
import { siteNameSegments } from "./pages";
import {
  MAX_CONFIRMED,
  offeringsOf,
  type ExistingTasks,
  type PageOpportunity,
} from "./opportunities";

const SITE = "https://mohmaya.example/";
const NOW = new Date("2026-10-22T12:00:00Z");
const RECENT = new Date("2026-10-22T11:56:00Z");

let n = 0;
const fact = (o: Partial<Fact> & Pick<Fact, "kind" | "value">): Fact => ({
  id: `f${n++}`,
  synonyms: [],
  source: "CLIENT",
  status: "APPROVED",
  ...o,
});
type Spec = {
  path: string;
  title?: string;
  h1?: string[];
  h2?: string[];
  words?: number | null;
  robots?: string;
  links?: Array<{ to: string; text: string }>;
  skip?: EvidencePage["skipReason"];
  /** Main-content text (defaults to the headings plus filler words). */
  main?: string;
  /** Main-content passages, one block each (overrides `main`). */
  blocks?: string[];
  /** JSON-LD blocks (valid). */
  schema?: unknown[];
  /** Meta description. */
  meta?: string;
  /** Contact signals on the page (defaults to none). */
  contact?: Partial<{
    tel: number;
    mailto: number;
    whatsapp: number;
    forms: number;
  }>;
  /** A page stored before main-content and contact detection. */
  legacy?: boolean;
};
const page = (p: Spec): EvidencePage => ({
  url: new URL(p.path, SITE).href,
  status: p.skip ? "SKIPPED" : "CRAWLED",
  httpStatus: p.skip ? null : 200,
  resourceType: "HTML",
  finalUrl: null,
  canonicalUrl: null,
  robotsMetaRaw: p.robots ?? null,
  depth: 1,
  skipReason: p.skip ?? null,
  title: p.title ?? null,
  metaDescription: p.meta ?? null,
  wordCount: p.words === undefined ? 400 : p.words,
  result: p.skip
    ? null
    : {
        headings: { h1: p.h1 ?? [], h2: p.h2 ?? [], h3: [] },
        links: (p.links ?? []).map((l) => ({
          url: new URL(l.to, SITE).href,
          anchorText: l.text,
          type: "internal",
        })),
        structuredData: (p.schema ?? []).map((data) => ({
          valid: true,
          data,
          error: null,
        })),
        ...(p.legacy ? {} : newEvidence(p)),
      },
});
/** The main-content and contact evidence a current crawl stores. */
function newEvidence(p: Spec) {
  const text =
    p.main ??
    [p.title, ...(p.h1 ?? []), ...(p.h2 ?? [])].filter(Boolean).join(". ");
  const words = p.words === undefined ? 400 : (p.words ?? 0);
  return {
    content: {
      v: 1,
      source: "main",
      words,
      // Headings, then a body sentence about the page's topic.
      blocks: p.blocks
        ? p.blocks.map((t) => ({ t, w: t.split(" ").length }))
        : [
            { t: text, w: Math.min(words, text.split(" ").length) },
            ...(p.main === undefined && p.title
              ? [{ t: `More about ${p.title} for our guests.`, w: 6 }]
              : []),
          ],
    },
    contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0, ...p.contact },
  };
}
const cover = (
  pages: Spec[],
  facts: Fact[],
  o: {
    status?: "COMPLETED" | "PARTIAL" | "FAILED";
    at?: Date;
    existing?: ExistingTasks;
  } = {},
) =>
  analyzeCoverage({
    websiteUrl: SITE,
    crawl: {
      status: o.status ?? "COMPLETED",
      analyzedAt: o.at ?? RECENT,
      pages: pages.map(page),
    },
    facts,
    now: NOW,
    existing: o.existing,
  });
const byKey = (c: CoverageResult, code: string) =>
  c.opportunities.filter((x) => x.key.endsWith(`(${code})`));
const one = (c: CoverageResult, code: string): PageOpportunity => {
  const found = byKey(c, code);
  expect(found, code).toHaveLength(1);
  return found[0];
};

// The approved facts entered for Moh Maya Cottages & Cafe (local fixture).
const MOH_MAYA = () => [
  fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
  fact({
    kind: "SERVICE",
    value: "Cottages and Cafe",
    synonyms: ["Rooms", "Hotel", "Cottages", "Resort", "Camping", "Trekking"],
  }),
  fact({
    kind: "LOCATION",
    value:
      "Katagla Village, Manikaran Road (Near Shani Mandir), Kasol, Kullu, Himachal Pradesh 175105",
    synonyms: ["Kasol", "Kullu", "Parvati Valley"],
  }),
  fact({
    kind: "SERVICE_AREA",
    value: "Kasol",
    synonyms: ["Kullu", "Parvati Valley", "Katagla"],
  }),
  fact({
    kind: "AUDIENCE",
    value:
      "All kind of audience except childrens. Family, couple all are welcome",
  }),
  fact({ kind: "GOAL", value: "bookings" }),
  fact({ kind: "GOAL", value: "calls" }),
  fact({ kind: "GOAL", value: "visits" }),
];
// Names the cottages only in its title; its main content is about the valley.
const HOME: Spec = {
  path: "/",
  title: "Cottages Near Kasol | MOH MAYA Cottages & Cafe",
  h1: ["MOH MAYA Cottages & Cafe"],
  words: 619,
  main: "Welcome to the Parvati valley, a quiet place among the mountains.",
};
const PRIVACY: Spec = {
  path: "/privacy-policy/",
  title: "Privacy Policy - MOH MAYA COTTAGES & CAFE",
  h1: ["Privacy Policy"],
  words: 1371,
};

describe("Moh Maya: homepage and privacy policy only", () => {
  const c = cover(
    [
      HOME,
      PRIVACY,
      {
        path: "/hello-world/",
        title: "Hello world! - MOH MAYA COTTAGES & CAFE",
        words: 201,
      },
    ],
    MOH_MAYA(),
  );

  test("accommodation is a confirmed opportunity, explained by the approved goals", () => {
    const o = one(c, "BIZ_ACCOMMODATION_PAGE");
    expect(o.key).toBe(
      "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)",
    );
    expect(o).toMatchObject({
      state: "confirmed",
      priority: "HIGH",
      slug: "/cottages/",
      recommend: true,
      category: "accommodation",
    });
    expect(o.goals).toEqual(["bookings", "calls", "visits"]);
    expect(o.why).toMatch(
      /approved goals: bookings or appointments, phone calls and visits to the premises/,
    );
    expect(o.topic).toBe("Cottages in the Kasol area");
    // The home page names the cottages but is about the whole business;
    // the privacy policy is never a candidate.
    const verdicts = Object.fromEntries(
      o.considered.map((p) => [new URL(p.url).pathname, p.verdict]),
    );
    expect(verdicts["/"]).toMatch(
      /Home page: mentions it, but does not discuss it/,
    );
    expect(verdicts["/privacy-policy/"]).toBe("Legal page: not considered.");
    // The outline uses approved facts only and asks for the rest.
    expect(o.outline.join(" ")).toMatch(
      /Who it is for \(approved\): “All kind of audience except childrens/,
    );
    expect(o.outline.join(" ")).toMatch(/Katagla Village, Manikaran Road/);
    expect(o.outline.join(" ")).toMatch(/How to book/);
    expect(o.assumptions[0]).toMatch(
      /types, capacity, amenities, rates and availability are not in the approved facts/,
    );
  });

  test("the site name repeated in every title never counts as a page about the offering", () => {
    const o = one(c, "BIZ_ACCOMMODATION_PAGE");
    const hello = o.considered.find((p) => p.url.endsWith("/hello-world/"));
    expect(hello?.verdict).toBe("Does not name it.");
    expect(
      siteNameSegments(["A - Moh Maya", "B | MOH MAYA", "Moh Maya"]),
    ).toEqual(new Set(["moh maya"]));
    expect(siteNameSegments(["Only one - Brand"])).toEqual(new Set());
  });

  test("the cafe is considered, but needs review: it is part of “Cottages and Cafe”", () => {
    const o = one(c, "BIZ_FOOD_PAGE");
    expect(o).toMatchObject({
      state: "review",
      recommend: false,
      goals: ["visits", "calls"],
    });
    expect(o.stateReason).toMatch(
      /helps only if it serves visitors on its own/,
    );
  });

  test("a contact, booking and directions page supports calls, bookings and visits", () => {
    const o = one(c, "BIZ_CONTACT_PATH");
    expect(o).toMatchObject({
      state: "confirmed",
      recommend: true,
      slug: "/contact/",
    });
    expect(o.outline.join(" ")).toMatch(/How to book/);
    expect(o.outline.join(" ")).toMatch(/Add directions and a map/);
  });

  test("camping and trekking are not offerings: a clarification, never a page", () => {
    expect(c.opportunities.some((o) => /camp|trek/i.test(o.key))).toBe(false);
    expect(c.clarifications[0].title).toBe(
      "“Camping” and “Trekking” are entered as other wording for “Cottages and Cafe”",
    );
  });

  test("no page per audience, area or location; no second home page, policy or duplicate", () => {
    const codes = c.opportunities.map(
      (o) => o.key.match(/\((BIZ_[A-Z_]+)\)$/)![1],
    );
    expect(codes.sort()).toEqual([
      "BIZ_ACCOMMODATION_PAGE",
      "BIZ_CONTACT_PATH",
      "BIZ_FOOD_PAGE",
    ]);
    expect(c.opportunities.map((o) => o.slug)).not.toContain("/");
    expect(c.opportunities.map((o) => o.slug)).not.toContain(
      "/privacy-policy/",
    );
    // The location and area are named on the home page: covered, no page.
    expect(
      c.needs
        .filter(
          (x) => x.kind === "location-mention" || x.kind === "service-areas",
        )
        .map((x) => x.status),
    ).toEqual(["covered", "covered"]);
  });

  test("into the plan: only the confirmed opportunities, with proposal metadata", () => {
    expect(coverageDrafts(c).map((d) => d.title)).toEqual([
      "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)",
      "Make it easy to get in touch (BIZ_CONTACT_PATH)",
    ]);
    const m = coverageMeta(
      "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)",
      c,
    )!;
    expect(m.proposal).toMatchObject({
      slug: "/cottages/",
      topic: "Cottages in the Kasol area",
    });
    expect(m.limits.join(" ")).toMatch(/not in the approved facts/);
    expect(m.knowledgeVersion).toBe("o2");
  });

  test("nothing invented: no prices, room types, facilities or ratings in the proposal text", () => {
    const text = c.opportunities
      .flatMap((o) => [o.why, o.stateReason, o.topic, o.intent, ...o.outline])
      .join(" ");
    expect(text).not.toMatch(
      /₹|\$|\d+ ?%|per night|deluxe|wifi|pool|bonfire|star rating|guarantee/i,
    );
  });
});

describe("crawl completeness: never confident on weak evidence", () => {
  test.each([
    ["partial", { status: "PARTIAL" as const }, [HOME]],
    ["failed", { status: "FAILED" as const }, [HOME]],
    ["stale", { at: new Date("2026-07-01T00:00:00Z") }, [HOME]],
    [
      "page-limited",
      {},
      [HOME, { path: "/more", skip: "BUDGET_EXCEEDED" as const }],
    ],
  ])(
    "%s crawl: review instead of a confirmed missing page",
    (_label, opts, pages) => {
      const c = cover(pages, MOH_MAYA(), opts);
      for (const o of c.opportunities)
        expect(o.state, o.key).not.toBe("confirmed");
      expect(one(c, "BIZ_ACCOMMODATION_PAGE").state).toBe("incomplete");
      expect(
        coverageDrafts(c).filter((d) => /PAGE|CONTACT/.test(d.title)),
      ).toEqual([]);
    },
  );

  test("no crawl at all: incomplete, nothing recommended", () => {
    const c = analyzeCoverage({
      websiteUrl: SITE,
      crawl: null,
      facts: MOH_MAYA(),
      now: NOW,
    });
    expect(
      c.opportunities.every((o) => o.state === "incomplete" && !o.recommend),
    ).toBe(true);
  });
});

describe("existing pages suppress duplicates; only a real page verifies", () => {
  const facts = MOH_MAYA();
  test("a substantial, indexable cottages page fulfils the purpose", () => {
    const c = cover(
      [HOME, { path: "/stay/", title: "Our cottages", h1: ["Stay with us"] }],
      facts,
    );
    expect(one(c, "BIZ_ACCOMMODATION_PAGE")).toMatchObject({
      state: "fulfilled",
      fulfilledBy: "https://mohmaya.example/stay/",
      recommend: false,
    });
  });
  test("other approved wording of the same kind counts (Rooms)", () => {
    const c = cover([HOME, { path: "/rooms/", title: "Rooms" }], facts);
    expect(one(c, "BIZ_ACCOMMODATION_PAGE").state).toBe("fulfilled");
  });
  test("a thin or noindex page is weak, not done; and is improved, not duplicated", () => {
    for (const spec of [
      { path: "/cottages/", title: "Cottages", words: 80 },
      { path: "/cottages/", title: "Cottages", robots: "noindex" },
      { path: "/cottages/", title: "Cottages", words: null },
    ]) {
      const o = one(cover([HOME, spec], facts), "BIZ_ACCOMMODATION_PAGE");
      expect(o.state).toBe("weak");
      expect(o.stateReason).toMatch(
        /improve (that page|it) rather than adding another/i,
      );
    }
  });
  test("a page already at the proposed URL is improved, not duplicated", () => {
    const o = one(
      cover([HOME, { path: "/cottages/", title: "Welcome" }], facts),
      "BIZ_ACCOMMODATION_PAGE",
    );
    expect(o.state).toBe("weak");
    expect(o.stateReason).toMatch(/A page already exists at/);
  });
});

describe("approved facts only", () => {
  test("pending, rejected and inferred services never suggest pages", () => {
    const facts = [
      fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
      fact({ kind: "SERVICE", value: "Cottages", status: "PENDING" }),
      fact({ kind: "SERVICE", value: "Restaurant", status: "REJECTED" }),
      fact({
        kind: "SERVICE",
        value: "Camping",
        status: "PENDING",
        source: "INFERENCE",
      }),
    ];
    expect(cover([HOME], facts).opportunities).toEqual([]);
  });
  test("an unapproved business type does not change the categories", () => {
    const c = cover(
      [HOME],
      [
        fact({
          kind: "BUSINESS_TYPE",
          value: "hospitality",
          status: "PENDING",
        }),
        fact({ kind: "SERVICE", value: "Cottages and Cafe" }),
      ],
    );
    expect(c.opportunities.map((o) => o.category)).toEqual(["service"]);
  });
  test("something marked as not offered is unsupported, never planned", () => {
    const c = cover(
      [HOME],
      [
        fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
        fact({ kind: "SERVICE", value: "Camping" }),
        fact({ kind: "EXCLUDED", value: "Camping" }),
      ],
    );
    expect(one(c, "BIZ_ACCOMMODATION_PAGE")).toMatchObject({
      state: "unsupported",
      recommend: false,
    });
  });
});

describe("business types and safeguards", () => {
  test("local service: the existing service-page identity is kept", () => {
    const c = cover(
      [HOME],
      [fact({ kind: "SERVICE", value: "Boiler repair" })],
    );
    expect(one(c, "BIZ_SERVICE_PAGE")).toMatchObject({
      key: "Add a page for “Boiler repair” (BIZ_SERVICE_PAGE)",
      state: "confirmed",
      category: "service",
    });
  });
  test("ecommerce offerings become product or category pages", () => {
    const c = cover(
      [HOME],
      [
        fact({ kind: "BUSINESS_TYPE", value: "ecommerce" }),
        fact({ kind: "SERVICE", value: "Hiking boots" }),
      ],
    );
    expect(one(c, "BIZ_SERVICE_PAGE").category).toBe("product");
  });
  test("compound values split only when every part is an offering type", () => {
    const hosp = ["hospitality" as const];
    expect(
      offeringsOf(
        fact({ kind: "SERVICE", value: "Bed and breakfast" }),
        hosp,
      ).offerings.map((o) => o.label),
    ).toEqual(["Bed and breakfast"]);
    expect(
      offeringsOf(
        fact({ kind: "SERVICE", value: "Rooms, Restaurant & Spa" }),
        hosp,
      ).offerings.map((o) => o.category),
    ).toEqual(["accommodation", "food", "facilities"]);
    expect(
      offeringsOf(fact({ kind: "SERVICE", value: "Cottages and Cafe" }), [
        "local-service",
      ]).offerings,
    ).toHaveLength(1);
  });
  test("facilities are grouped into one page, and it is never a confirmed gap", () => {
    const base = [
      fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
      fact({ kind: "SERVICE", value: "Rooms" }),
    ];
    const two = cover(
      [HOME],
      [
        ...base,
        fact({ kind: "SERVICE", value: "Bonfire" }),
        fact({ kind: "SERVICE", value: "Parking" }),
      ],
    );
    expect(byKey(two, "BIZ_FACILITIES_PAGE")).toHaveLength(1);
    // Two or more facilities: a decision for a person, not an automatic task.
    expect(one(two, "BIZ_FACILITIES_PAGE")).toMatchObject({
      state: "review",
      recommend: false,
    });
    expect(one(two, "BIZ_FACILITIES_PAGE").stateReason).toMatch(
      /Facilities usually belong on the accommodation page/,
    );
    const single = cover(
      [HOME],
      [...base, fact({ kind: "SERVICE", value: "Bonfire" })],
    );
    expect(one(single, "BIZ_FACILITIES_PAGE").state).toBe("review");
  });
  test("many audiences or service areas never create pages", () => {
    const c = cover(
      [HOME],
      [
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        ...["Landlords", "Homeowners", "Schools"].map((value) =>
          fact({ kind: "AUDIENCE", value }),
        ),
        ...["Otley", "Ilkley", "Leeds"].map((value) =>
          fact({ kind: "SERVICE_AREA", value }),
        ),
      ],
    );
    expect(c.opportunities.map((o) => o.category)).toEqual(["service"]);
  });
  test(`at most ${MAX_CONFIRMED} confirmed new pages at a time; the rest wait for review`, () => {
    const services = Array.from({ length: 7 }, (_, i) =>
      fact({
        kind: "SERVICE",
        value: `Service ${String.fromCharCode(65 + i)}`,
      }),
    );
    const c = cover([HOME], services);
    expect(c.opportunities.filter((o) => o.state === "confirmed")).toHaveLength(
      MAX_CONFIRMED,
    );
    expect(
      c.opportunities
        .filter((o) => o.state === "review")
        .every((o) => /at most 5 new pages/.test(o.stateReason)),
    ).toBe(true);
  });
  test("a price constraint is carried into the proposal", () => {
    const c = cover(
      [HOME],
      [
        ...MOH_MAYA(),
        fact({ kind: "CONSTRAINT", value: "No prices published on the site" }),
      ],
    );
    const o = one(c, "BIZ_ACCOMMODATION_PAGE");
    expect(o.assumptions).toContain(
      "Do not publish prices (approved constraint).",
    );
    expect(o.outline.join(" ")).toMatch(/Respect this approved constraint/);
  });
});

describe("identity and lifecycle", () => {
  const ACC =
    "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)";
  const FOOD = "Add a page for the Cafe (BIZ_FOOD_PAGE)";
  test("keys are stable across refreshes and page order", () => {
    const a = cover([HOME, PRIVACY], MOH_MAYA()).opportunities.map(
      (o) => o.key,
    );
    const b = cover([PRIVACY, HOME], MOH_MAYA()).opportunities.map(
      (o) => o.key,
    );
    expect(b).toEqual(a);
    expect(a).toContain(FOOD);
  });
  test("dismissed stays out of the plan; accepted review items join it", () => {
    const existing: ExistingTasks = new Map([
      [ACC, "DISMISSED"],
      [FOOD, "PROPOSED"],
    ]);
    const c = cover([HOME], MOH_MAYA(), { existing });
    expect(one(c, "BIZ_ACCOMMODATION_PAGE")).toMatchObject({
      decision: "dismissed",
      recommend: false,
    });
    expect(one(c, "BIZ_FOOD_PAGE")).toMatchObject({
      decision: "accepted",
      state: "review",
      recommend: true,
    });
    expect(coverageDrafts(c).map((d) => d.title)).toContain(FOOD);
  });
  test("an accepted task survives an incomplete crawl and completes only on a real page", () => {
    const existing: ExistingTasks = new Map([[ACC, "PROPOSED"]]);
    const held = (c: CoverageResult) =>
      heldReason(
        { title: ACC, issueId: null },
        { issues: new Map(), remainingRules: new Map(), coverage: c },
      );
    const partial = cover([HOME], MOH_MAYA(), { status: "PARTIAL", existing });
    expect(one(partial, "BIZ_ACCOMMODATION_PAGE")).toMatchObject({
      state: "incomplete",
      recommend: true,
    });
    expect(held(partial)).toBe("unverified");
    expect(
      held(
        cover(
          [HOME, { path: "/cottages/", title: "Cottages", words: 60 }],
          MOH_MAYA(),
          { existing },
        ),
      ),
    ).toBe("unverified");
    expect(
      held(
        cover([HOME, { path: "/cottages/", title: "Cottages" }], MOH_MAYA(), {
          existing,
        }),
      ),
    ).toBeNull();
  });
});

// ─── Remediation: verification accuracy (H1) and contact signals (H2) ──────

/** A crawled page built by the real parser from HTML. */
const fromHtml = (path: string, html: string, words?: number): EvidencePage => {
  const url = new URL(path, SITE).href;
  const parsed = parsePage(html, url);
  return {
    ...page({ path, title: parsed.title ?? undefined }),
    wordCount: words ?? parsed.wordCount,
    result: parsed.result,
  };
};
const lots = (n: number, w = "x") =>
  Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const CHROME = `<header>${lots(120, "head")}</header><nav>${lots(150, "nav")} Cottages Cafe Contact</nav><div class="cookie-banner">${lots(60, "cookie")}</div><footer>${lots(150, "foot")} Cottages near Kasol</footer>`;
const htmlPage = (title: string, main: string) =>
  `<html><head><title>${title} - ${BRAND}</title></head><body>${CHROME}<main>${main}</main></body></html>`;
const BRAND = "MOH MAYA COTTAGES & CAFE";
const coverEvidence = (
  pages: EvidencePage[],
  facts = MOH_MAYA(),
  existing?: ExistingTasks,
) =>
  analyzeCoverage({
    websiteUrl: SITE,
    crawl: { status: "COMPLETED", analyzedAt: RECENT, pages },
    facts,
    now: NOW,
    existing,
  });
const HOME_HTML = fromHtml(
  "/",
  htmlPage("Cottages Near Kasol", `<h1>Welcome</h1><p>${lots(400)}</p>`),
);
const PRIVACY_HTML = fromHtml(
  "/privacy-policy/",
  htmlPage(
    "Privacy Policy",
    `<h1>Privacy Policy</h1><p>${lots(500, "law")}</p>`,
  ),
);

describe("verification needs relevant main content, not template text", () => {
  const ACC =
    "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)";
  const held = (c: CoverageResult) =>
    heldReason(
      { title: ACC, issueId: null },
      { issues: new Map(), remainingRules: new Map(), coverage: c },
    );

  test("a matching title with an empty main area and heavy navigation/footer does not verify", () => {
    const empty = fromHtml(
      "/cottages/",
      htmlPage("Cottages", "<h1>Cottages</h1>"),
    );
    expect(empty.wordCount).toBeGreaterThan(400); // the page-wide count is large…
    const c = coverEvidence(
      [HOME_HTML, PRIVACY_HTML, empty],
      MOH_MAYA(),
      new Map([[ACC, "PROPOSED"]]),
    );
    const o = one(c, "BIZ_ACCOMMODATION_PAGE");
    expect(o.state).toBe("weak"); // …but the main content is one word
    expect(o.stateReason).toMatch(
      /main content has only 1 words, not counting the header, navigation, footer/,
    );
    expect(held(c)).toBe("unverified");
  });

  test("200+ main-content words that never mention the offering do not verify", () => {
    const offTopic = fromHtml(
      "/cottages/",
      htmlPage("Cottages", `<h1>Cottages</h1><p>${lots(300, "weather")}</p>`),
    );
    const o = one(
      coverEvidence([HOME_HTML, offTopic]),
      "BIZ_ACCOMMODATION_PAGE",
    );
    expect(o.state).toBe("weak");
    expect(o.stateReason).toMatch(/main content does not mention “Cottages”/);
  });

  test("text repeated on every page's main content is not this page's content", () => {
    const cta = `<p>Book your cottages stay today ${lots(260, "cta")}</p>`;
    const home = fromHtml(
      "/",
      htmlPage("Cottages Near Kasol", `<h1>Welcome</h1>${cta}`),
    );
    const about = fromHtml(
      "/about/",
      htmlPage("About", `<h1>About us</h1>${cta}`),
    );
    const cottages = fromHtml(
      "/cottages/",
      htmlPage("Cottages", `<h1>Cottages</h1>${cta}`),
    );
    const o = one(
      coverEvidence([home, about, cottages]),
      "BIZ_ACCOMMODATION_PAGE",
    );
    expect(o.state).toBe("weak");
  });

  test("a genuinely relevant page verifies", () => {
    const real = fromHtml(
      "/cottages/",
      htmlPage(
        "Our Cottages",
        `<h1>Our cottages</h1><p>Our cottages sleep families and couples. ${lots(260)}</p>`,
      ),
    );
    const c = coverEvidence(
      [HOME_HTML, PRIVACY_HTML, real],
      MOH_MAYA(),
      new Map([[ACC, "PROPOSED"]]),
    );
    expect(one(c, "BIZ_ACCOMMODATION_PAGE")).toMatchObject({
      state: "fulfilled",
      fulfilledBy: real.url,
    });
    expect(held(c)).toBeNull();
  });

  test("an older crawl without main-content evidence can never verify", () => {
    const old = {
      ...fromHtml(
        "/cottages/",
        htmlPage(
          "Our Cottages",
          `<h1>Our cottages</h1><p>Our cottages ${lots(300)}</p>`,
        ),
      ),
    };
    const {
      content: _content,
      contact: _contact,
      ...legacyResult
    } = old.result as Record<string, unknown>;
    const c = coverEvidence(
      [HOME_HTML, { ...old, result: legacyResult }],
      MOH_MAYA(),
      new Map([[ACC, "PROPOSED"]]),
    );
    const o = one(c, "BIZ_ACCOMMODATION_PAGE");
    expect(o.state).toBe("weak");
    expect(o.stateReason).toMatch(/predates main-content detection/);
    expect(held(c)).toBe("unverified");
  });
});

describe("contact signals and the contact-page opportunity", () => {
  const withHome = (homeMain: string) =>
    one(
      coverEvidence([
        fromHtml(
          "/",
          htmlPage(
            "Cottages Near Kasol",
            `<h1>Welcome</h1>${homeMain}<p>${lots(300)}</p>`,
          ),
        ),
        PRIVACY_HTML,
      ]),
      "BIZ_CONTACT_PATH",
    );
  test.each([
    ["a phone link", `<a href="tel:+911234567890">Call us</a>`],
    ["an email link", `<a href="mailto:stay@mohmaya.example">Email</a>`],
    ["a WhatsApp link", `<a href="https://wa.me/911234567890">WhatsApp</a>`],
    [
      "a contact form",
      `<form><input type="email" name="email"><textarea name="msg"></textarea></form>`,
    ],
  ])(
    "home page with %s: needs review, never a confirmed missing page",
    (label, html) => {
      const o = withHome(html);
      expect(o.state).toBe("review");
      expect(o.recommend).toBe(false);
      expect(o.stateReason).toContain(`The home page already has ${label}`);
    },
  );
  test("no contact signals anywhere: still a confirmed missing page", () => {
    const o = withHome("<p>No way to reach us here.</p>");
    expect(o).toMatchObject({ state: "confirmed", recommend: true });
    expect(o.confidenceReason).toMatch(
      /No contact page, contact link, phone, email or WhatsApp link, or contact form/,
    );
  });
  test("an older crawl without contact detection asks for review", () => {
    const c = cover(
      [HOME, PRIVACY].map((p) => ({ ...p, legacy: true })),
      MOH_MAYA(),
    );
    const o = one(c, "BIZ_CONTACT_PATH");
    expect(o.state).toBe("review");
    expect(o.stateReason).toMatch(
      /predates detection of phone, email and WhatsApp links and contact forms/,
    );
  });
  test("an accepted contact task stays planned when signals appear; it is never silently dropped", () => {
    const key = "Make it easy to get in touch (BIZ_CONTACT_PATH)";
    const c = coverEvidence(
      [
        fromHtml(
          "/",
          htmlPage(
            "Cottages Near Kasol",
            `<h1>Welcome</h1><a href="tel:+91">Call</a><p>${lots(300)}</p>`,
          ),
        ),
      ],
      MOH_MAYA(),
      new Map([[key, "PROPOSED"]]),
    );
    expect(one(c, "BIZ_CONTACT_PATH")).toMatchObject({
      state: "review",
      decision: "accepted",
      recommend: true,
    });
  });
});

describe("the home page is judged by its main content (audit M1)", () => {
  const discussing: Spec = {
    ...HOME,
    main: undefined,
  };
  const homeWith = (blocks: string[], words = 619): EvidencePage => {
    const p = page({ ...discussing, main: blocks[0] ?? "" });
    const r = p.result as Record<string, unknown>;
    return {
      ...p,
      result: {
        ...r,
        content: {
          v: 1,
          source: "main",
          words,
          blocks: blocks.map((t) => ({ t, w: t.split(" ").length })),
        },
      },
    };
  };
  const run = (home: EvidencePage, facts = MOH_MAYA()) =>
    analyzeCoverage({
      websiteUrl: SITE,
      crawl: {
        status: "COMPLETED",
        analyzedAt: RECENT,
        pages: [home, page(PRIVACY)],
      },
      facts,
      now: NOW,
    });
  const COTTAGE_TALK = [
    "Our cottages sit above the river in Katagla.",
    "Each of the cottages has a balcony and mountain views.",
    "Breakfast is served in the cafe every morning.",
  ];

  test("Moh Maya: the home page already discusses the cottages and there is also a cafe: review, not a confirmed gap", () => {
    const o = one(run(homeWith(COTTAGE_TALK)), "BIZ_ACCOMMODATION_PAGE");
    expect(o).toMatchObject({ state: "review", recommend: false });
    expect(o.stateReason).toMatch(
      /home page already discusses “Cottages” in its main content \(2 passages\)/,
    );
    expect(o.considered[0].verdict).toMatch(
      /Home page: its main content discusses it \(2 passages\)/,
    );
  });

  test("a home page that only names it in its title and H1 does not cover it", () => {
    expect(one(run(page(HOME)), "BIZ_ACCOMMODATION_PAGE").state).toBe(
      "confirmed",
    );
  });

  test("one mention or a thin main content is a mention, not coverage", () => {
    expect(
      one(
        run(homeWith([COTTAGE_TALK[0], "The valley is quiet."])),
        "BIZ_ACCOMMODATION_PAGE",
      ).state,
    ).toBe("confirmed");
    expect(
      one(run(homeWith(COTTAGE_TALK, 120)), "BIZ_ACCOMMODATION_PAGE").state,
    ).toBe("confirmed");
  });

  test("a single-offering business whose home page discusses it is covered by the home page", () => {
    const single = [
      fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
      fact({ kind: "SERVICE", value: "Cottages" }),
      fact({ kind: "GOAL", value: "bookings" }),
    ];
    const o = one(
      run(homeWith(COTTAGE_TALK), single),
      "BIZ_ACCOMMODATION_PAGE",
    );
    expect(o).toMatchObject({ state: "fulfilled", fulfilledBy: SITE });
  });

  test("an older crawl without the home page's content asks for review instead of a confident gap", () => {
    const o = one(
      run(page({ ...HOME, legacy: true })),
      "BIZ_ACCOMMODATION_PAGE",
    );
    expect(o.state).toBe("review");
    expect(o.stateReason).toMatch(
      /cannot tell whether the home page already covers it/,
    );
  });
});

describe("crawl completeness is explicit (audit M2)", () => {
  const ACC = "BIZ_ACCOMMODATION_PAGE";
  const run = (pages: EvidencePage[], maxDiscoveredUrls?: number) =>
    analyzeCoverage({
      websiteUrl: SITE,
      crawl: {
        status: "COMPLETED",
        analyzedAt: RECENT,
        pages,
        maxDiscoveredUrls,
      },
      facts: MOH_MAYA(),
      now: NOW,
    });
  const failed = (path: string): EvidencePage => ({
    ...page({ path }),
    status: "FAILED",
    httpStatus: null,
    result: null,
  });
  const serverError = (path: string): EvidencePage => ({
    ...page({ path }),
    httpStatus: 503,
    result: null,
  });
  const blocked = (path: string): EvidencePage =>
    page({ path, skip: "ROBOTS_DISALLOWED" });

  test("a normal complete crawl confirms the missing page", () => {
    const c = run([page(HOME), page(PRIVACY)], 2000);
    expect(c.crawl).toMatchObject({ complete: true, gap: null, limits: [] });
    expect(one(c, ACC).state).toBe("confirmed");
  });

  test.each([
    [
      "a failed fetch",
      failed("/somewhere/"),
      /could not be fetched or returned a server error/,
    ],
    [
      "a server error",
      serverError("/broken/"),
      /could not be fetched or returned a server error/,
    ],
  ])("%s makes the crawl incomplete: nothing is confirmed", (_l, bad, why) => {
    const c = run([page(HOME), page(PRIVACY), bad]);
    expect(c.crawl!.complete).toBe(false);
    expect(c.crawl!.limits.join(" ")).toMatch(why);
    expect(c.opportunities.some((o) => o.state === "confirmed")).toBe(false);
  });

  test("reaching the discovery cap makes the crawl incomplete", () => {
    const c = run([page(HOME), page(PRIVACY)], 2);
    expect(c.crawl!.limits.join(" ")).toMatch(/limit of 2 discovered URLs/);
    expect(one(c, ACC).state).toBe("incomplete");
  });

  test("a robots-blocked URL that looks like the page: incomplete for that page only", () => {
    const c = run([page(HOME), page(PRIVACY), blocked("/cottages/")]);
    expect(c.crawl!.complete).toBe(true); // robots blocks are not site-wide gaps…
    const o = one(c, ACC);
    expect(o.state).toBe("incomplete"); // …but this page may exist
    expect(o.stateReason).toMatch(/cottages\/ is blocked by robots.txt/);
    expect(one(c, "BIZ_CONTACT_PATH").state).toBe("confirmed");
  });

  test("an unrelated robots-blocked URL (e.g. /wp-admin/) does not block a confirmation", () => {
    expect(
      one(run([page(HOME), page(PRIVACY), blocked("/wp-admin/")]), ACC).state,
    ).toBe("confirmed");
  });
});

const movesOf = (...a: Parameters<typeof rekeyTasks>) => rekeyTasks(...a).moves;
/** The Stage 2 re-key rules (D2, D2-b), as used where every capability is present. */
const STRICT = { strict: true } as const;

describe("stable identity when facts or the business type change (audit M3)", () => {
  const services = (hospitality: boolean) => [
    ...(hospitality
      ? [fact({ kind: "BUSINESS_TYPE", value: "hospitality" })]
      : []),
    fact({ kind: "SERVICE", value: "Cottages and Cafe" }),
    fact({ kind: "GOAL", value: "bookings" }),
  ];
  const COMBINED = "Add a page for “Cottages and Cafe” (BIZ_SERVICE_PAGE)";
  const ACC =
    "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)";
  const FOOD = "Add a page for the Cafe (BIZ_FOOD_PAGE)";
  const task = (title: string, status = "PROPOSED") => ({
    id: title,
    title,
    status,
  });

  test("approving “hospitality”: the combined task becomes the accommodation task, not a second one", () => {
    const c = cover([HOME], services(true));
    expect(movesOf([task(COMBINED)], c)).toEqual([
      { id: COMBINED, from: COMBINED, to: ACC },
    ]);
  });

  // Stage 2, D2-b (approved): a split is automatic only when exactly one part
  // shares the task's category. A service task splitting into accommodation
  // and food has none, so it is held for a person to choose. The test above
  // pins today's tie-break and is replaced when this lands.
  // Step C1b: the Stage 2 rules run only where every capability is present
  // (option A), so these pass them in; the tests above pin today's moves,
  // which still apply everywhere else.
  test("D2-b: approving “hospitality” holds the combined task for review, listing both parts", () => {
    const c = cover([HOME], services(true));
    const plan = rekeyTasks([task(COMBINED)], c, STRICT);
    expect(plan.moves).toEqual([]);
    expect(plan.ambiguous).toEqual([
      {
        id: COMBINED,
        title: COMBINED,
        candidates: expect.arrayContaining([ACC, FOOD]),
      },
    ]);
  });

  test("withdrawing “hospitality”: the accommodation task takes the combined page when it is planned", () => {
    // No page names the offering, so the combined page is a confirmed gap.
    const c = cover(
      [{ ...HOME, title: "Welcome", h1: ["Welcome"] }],
      services(false),
    );
    expect(one(c, "BIZ_SERVICE_PAGE")).toMatchObject({
      key: COMBINED,
      state: "confirmed",
    });
    expect(movesOf([task(FOOD), task(ACC)], c)).toEqual([
      { id: ACC, from: ACC, to: COMBINED },
    ]);
  });

  // Stage 2, D2-b (approved): a merge is automatic only when exactly one part
  // task competes for the whole. Two do here, so both are held and listed.
  test("D2-b: withdrawing “hospitality” with two part tasks holds both for review", () => {
    const c = cover(
      [{ ...HOME, title: "Welcome", h1: ["Welcome"] }],
      services(false),
    );
    const plan = rekeyTasks([task(FOOD), task(ACC)], c, STRICT);
    expect(plan.moves).toEqual([]);
    expect(plan.ambiguous.map((a) => a.id).sort()).toEqual([ACC, FOOD].sort());
  });

  test("D2-b (C1b, strict): exactly one part task for the whole is unambiguous, so it moves, keyed to the fact", () => {
    const c = cover(
      [{ ...HOME, title: "Welcome", h1: ["Welcome"] }],
      services(false),
    );
    const whole = one(c, "BIZ_SERVICE_PAGE");
    expect(rekeyTasks([task(ACC)], c, STRICT)).toEqual({
      moves: [
        {
          id: ACC,
          from: ACC,
          to: COMBINED,
          toKey: `biz:offering-page:${whole.facts[0].id}`,
        },
      ],
      ambiguous: [],
      suggestions: [],
    });
  });

  test("D2-b (C1b, strict): a part opportunity's key names its fact and part, never its wording", () => {
    const c = cover([HOME], services(true));
    const acc = c.opportunities.find((o) => o.key === ACC)!;
    expect(acc.part).toBe("Cottages");
    expect(businessKey(acc)).toBe(
      `biz:offering-page:${acc.facts[0].id}:cottages`,
    );
  });

  test("a partial match never quietly accepts an opportunity awaiting review; the task waits instead", () => {
    const c = cover([HOME], services(false)); // the home page names it: review
    expect(one(c, "BIZ_SERVICE_PAGE").state).toBe("review");
    expect(movesOf([task(FOOD), task(ACC)], c)).toEqual([]);
    // A dismissal may move onto it (it only suppresses).
    expect(movesOf([task(ACC, "DISMISSED")], c)).toEqual([
      { id: ACC, from: ACC, to: COMBINED },
    ]);
  });

  test("a dismissed task moves and stays dismissed; completed work is never moved", () => {
    const c = cover([HOME], services(true));
    expect(movesOf([task(COMBINED, "DISMISSED")], c)).toEqual([
      { id: COMBINED, from: COMBINED, to: ACC },
    ]);
    expect(movesOf([task(COMBINED, "COMPLETED")], c)).toEqual([]);
  });

  // Stage 2, D2-b (approved): the same split held for review applies to a
  // dismissed task; completed work is still never moved.
  test("D2-b: a dismissed combined task is held for review on a split, not moved", () => {
    const c = cover([HOME], services(true));
    expect(movesOf([task(COMBINED, "DISMISSED")], c, STRICT)).toEqual([]);
    expect(movesOf([task(COMBINED, "COMPLETED")], c, STRICT)).toEqual([]);
  });

  test("never two tasks for one purpose: an opportunity that already has a task is not claimed", () => {
    const c = cover([HOME], services(true));
    expect(movesOf([task(COMBINED), task(ACC)], c)).toEqual([]);
  });

  test("a task whose offering is gone stays as it is (shown as needing review)", () => {
    const c = cover(
      [HOME],
      [fact({ kind: "SERVICE", value: "Boiler repair" })],
    );
    expect(movesOf([task(ACC)], c)).toEqual([]);
    expect(offeringOfTitle(FOOD)).toBe("Cafe");
    expect(offeringOfTitle(ACC)).toBe("Cottages");
  });

  test("re-keying is deterministic regardless of task order", () => {
    const c = cover([HOME], services(false));
    expect(movesOf([task(ACC), task(FOOD)], c)).toEqual(
      movesOf([task(FOOD), task(ACC)], c),
    );
  });
});

describe("site-name text is not page content", () => {
  test("a brand-only H1 inside <main> is not a passage about the offering", () => {
    const brand = "MOH MAYA COTTAGES & CAFE";
    const html = (title: string, main: string) =>
      `<html><head><title>${title} - ${brand}</title></head><body><main>${main}</main></body></html>`;
    const home = fromHtml(
      "/",
      html(
        "Cottages Near Kasol",
        `<h1>${brand}</h1><p>Our cottages sit above the river.</p><p>${lots(300)}</p>`,
      ),
    );
    const privacy = fromHtml(
      "/privacy-policy/",
      html(
        "Privacy Policy",
        `<h1>Privacy Policy</h1><p>${lots(400, "law")}</p>`,
      ),
    );
    const o = one(coverEvidence([home, privacy]), "BIZ_ACCOMMODATION_PAGE");
    // One real passage only: a mention, not a discussion.
    expect(o.considered[0].verdict).toBe(
      "Home page: mentions it, but does not discuss it.",
    );
    expect(o.state).toBe("confirmed");
  });
});

describe("re-keying is conservative and explainable (sprint 3)", () => {
  const svc = (value: string, status: Fact["status"] = "APPROVED") =>
    fact({ kind: "SERVICE", value, status });
  const task = (title: string, status = "PROPOSED") => ({
    id: title,
    title,
    status,
  });
  const key = (label: string) => `Add a page for “${label}” (BIZ_SERVICE_PAGE)`;
  const opp = (c: CoverageResult, label: string) =>
    c.opportunities.find((o) => o.key === key(label))!;
  const blank = [{ ...HOME, title: "Welcome", h1: ["Welcome"] }]; // nothing named: gaps are confirmed

  test("“Boiler repair” never moves onto “Repair” (a single shared word)", () => {
    const c = cover(blank, [svc("Repair")]);
    expect(opp(c, "Repair").state).toBe("confirmed");
    expect(rekeyScore("Boiler repair", opp(c, "Repair"))).toBe(0);
    expect(rekeyTasks([task(key("Boiler repair"))], c)).toEqual({
      moves: [],
      ambiguous: [],
    });
  });

  test("an exact rename (same words, different casing or plural) moves, even onto review", () => {
    const c = cover(
      [HOME, { path: "/x/", h2: ["Boiler repairs"] }],
      [svc("Boiler Repairs")],
    );
    expect(opp(c, "Boiler Repairs").state).toBe("review");
    expect(rekeyTasks([task(key("boiler repair"))], c).moves).toEqual([
      {
        id: key("boiler repair"),
        from: key("boiler repair"),
        to: key("Boiler Repairs"),
      },
    ]);
  });

  test("a partial match needs two shared words and a confirmed target", () => {
    const c = cover(blank, [svc("Emergency boiler repair")]);
    expect(rekeyScore("Boiler repair", opp(c, "Emergency boiler repair"))).toBe(
      1,
    );
    expect(movesOf([task(key("Boiler repair"))], c)).toHaveLength(1);
    const review = cover(
      [HOME, { path: "/x/", h2: ["Emergency boiler repair"] }],
      [svc("Emergency boiler repair")],
    );
    expect(movesOf([task(key("Boiler repair"))], review)).toEqual([]);
  });

  // Stage 2, D2 (approved): a partial (score 1) match never moves a task by
  // itself; it becomes a suggestion a person confirms. The test above pins
  // today's automatic move and is replaced when this lands.
  test("D2: a narrower or broader wording (score 1) is a suggestion, not a move", () => {
    const c = cover(blank, [svc("Emergency boiler repair")]);
    const plan = rekeyTasks([task(key("Boiler repair"))], c, {
      strict: true,
    }) as ReturnType<typeof rekeyTasks> & {
      suggestions?: Array<{ id: string; to: string }>;
    };
    expect(plan.moves).toEqual([]);
    expect(plan.suggestions).toEqual([
      { id: key("Boiler repair"), to: key("Emergency boiler repair") },
    ]);
  });

  test("D2 (C1b, strict): an exact rename still moves by itself, carrying the new fact's key", () => {
    const c = cover(
      [HOME, { path: "/x/", h2: ["Boiler repairs"] }],
      [svc("Boiler Repairs")],
    );
    const factId = opp(c, "Boiler Repairs").facts[0].id;
    expect(rekeyTasks([task(key("boiler repair"))], c, STRICT)).toEqual({
      moves: [
        {
          id: key("boiler repair"),
          from: key("boiler repair"),
          to: key("Boiler Repairs"),
          toKey: `biz:offering-page:${factId}`,
        },
      ],
      ambiguous: [],
      suggestions: [],
    });
  });

  test("D2 (C1b, strict): two equally good candidates are held and listed, never picked", () => {
    const c = cover(blank, [
      svc("Emergency boiler repair"),
      svc("Boiler repair Leeds"),
    ]);
    const plan = rekeyTasks([task(key("Boiler repair"))], c, STRICT);
    expect(plan.moves).toEqual([]);
    expect(plan.suggestions).toEqual([]);
    expect(plan.ambiguous).toEqual([
      {
        id: key("Boiler repair"),
        title: key("Boiler repair"),
        candidates: expect.arrayContaining([
          key("Emergency boiler repair"),
          key("Boiler repair Leeds"),
        ]),
      },
    ]);
  });

  test("D2 (C1b, strict): a keyed task whose fact is still current is not re-keyed by its title", () => {
    const c = cover(blank, [svc("Emergency boiler repair")]);
    const o = opp(c, "Emergency boiler repair");
    const keyed = {
      ...task(key("Boiler repair")),
      identityKey: `biz:offering-page:${o.facts[0].id}`,
    };
    expect(rekeyTasks([keyed], c, STRICT)).toEqual({
      moves: [],
      ambiguous: [],
      suggestions: [],
    });
  });

  test("D2: the reverse wording (broader) is also never a silent move onto an opportunity awaiting review", () => {
    const review = cover(
      [HOME, { path: "/x/", h2: ["Boiler repair"] }],
      [svc("Boiler repair")],
    );
    expect(movesOf([task(key("Emergency boiler repair"))], review)).toEqual([]);
  });

  test("several equally good targets: left alone and reported as ambiguous", () => {
    const c = cover(blank, [
      svc("Emergency boiler repair"),
      svc("Boiler repair and servicing"),
    ]);
    const plan = rekeyTasks([task(key("Boiler repair"))], c);
    expect(plan.moves).toEqual([]);
    expect(plan.ambiguous).toEqual([
      {
        id: key("Boiler repair"),
        title: key("Boiler repair"),
        candidates: expect.arrayContaining([
          key("Emergency boiler repair"),
          key("Boiler repair and servicing"),
        ]),
      },
    ]);
  });

  test("a withdrawn fact: the task stays (no unrelated target), shown as needing review", () => {
    const c = cover(blank, [
      svc("Boiler repair", "PENDING"),
      svc("Bathroom fitting"),
    ]);
    expect(rekeyTasks([task(key("Boiler repair"), "IN_PROGRESS")], c)).toEqual({
      moves: [],
      ambiguous: [],
    });
  });

  test("repeated re-keying is a no-op once the task has its new title", () => {
    const c = cover(blank, [svc("Boiler Repairs")]);
    const first = movesOf([task(key("boiler repair"))], c);
    expect(first).toHaveLength(1);
    expect(
      movesOf([{ id: first[0].id, title: first[0].to, status: "PROPOSED" }], c),
    ).toEqual([]);
  });
});

describe("discovery truncation and coverage (sprint 3)", () => {
  const ACC = "BIZ_ACCOMMODATION_PAGE";
  const seed = (discovery?: object): EvidencePage => {
    const p = page(HOME);
    const r = p.result as Record<string, unknown>;
    return {
      ...p,
      discoverySource: "SEED",
      result: discovery === undefined ? r : { ...r, discovery },
    };
  };
  const withLinks = (n: number): EvidencePage => {
    const p = page(PRIVACY);
    return {
      ...p,
      discoverySource: "LINK",
      result: { ...(p.result as object), linksOmitted: n },
    };
  };
  const run = (pages: EvidencePage[]) =>
    analyzeCoverage({
      websiteUrl: SITE,
      crawl: {
        status: "COMPLETED",
        analyzedAt: RECENT,
        pages,
        maxDiscoveredUrls: 2000,
      },
      facts: MOH_MAYA(),
      now: NOW,
    });
  const none = { v: 1, sitemapFilesOmitted: 0, sitemapUrlsCapped: false };

  test("limits that dropped nothing: complete, the missing page is confirmed", () => {
    const c = run([seed(none), withLinks(0)]);
    expect(c.crawl).toMatchObject({ complete: true, limits: [] });
    expect(one(c, ACC).state).toBe("confirmed");
  });

  test.each([
    [
      "sitemap files not read",
      { ...none, sitemapFilesOmitted: 3 },
      /3 sitemap files listed by the site were not read/,
    ],
    [
      "a sitemap longer than the cap",
      { ...none, sitemapUrlsCapped: true },
      /listed more URLs than the crawl records/,
    ],
  ])("%s: incomplete, never a confirmed missing page", (_l, discovery, why) => {
    const c = run([seed(discovery), withLinks(0)]);
    expect(c.crawl!.limits.join(" ")).toMatch(why);
    expect(one(c, ACC).state).toBe("incomplete");
  });

  test("links beyond the per-page limit: incomplete", () => {
    const c = run([seed(none), withLinks(12)]);
    expect(c.crawl!.limits.join(" ")).toMatch(
      /1 page had more links than the crawl follows/,
    );
    expect(c.opportunities.some((o) => o.state === "confirmed")).toBe(false);
  });

  test("an older crawl whose seed page has no discovery evidence: cannot confirm missing pages", () => {
    const c = run([seed(undefined), withLinks(0)]);
    expect(c.crawl!.limits.join(" ")).toMatch(
      /predates recording of sitemap and link limits/,
    );
    expect(one(c, ACC).state).toBe("incomplete");
  });
});

describe("sitemap ledger (v2) and coverage", () => {
  const ACC = "BIZ_ACCOMMODATION_PAGE";
  const seed = (discovery: object): EvidencePage => {
    const p = page(HOME);
    return {
      ...p,
      discoverySource: "SEED",
      result: { ...(p.result as object), discovery },
    };
  };
  const run = (discovery: object) =>
    analyzeCoverage({
      websiteUrl: SITE,
      crawl: {
        status: "COMPLETED",
        analyzedAt: RECENT,
        pages: [seed(discovery), page(PRIVACY)],
        maxDiscoveredUrls: 2000,
      },
      facts: MOH_MAYA(),
      now: NOW,
    });
  const list = (urls: string[]) => ({ count: urls.length, urls });
  const ledger = (o: {
    skipped?: string[];
    failed?: string[];
    unprocessed?: string[];
  }) => {
    const failed = o.failed ?? [];
    const unprocessed = o.unprocessed ?? [];
    return {
      v: 2,
      sitemapFilesOmitted: failed.length + unprocessed.length,
      sitemapUrlsCapped: false,
      sitemaps: {
        discovered: 3,
        indexes: 1,
        processed: 2,
        skipped: list(o.skipped ?? []),
        failed: list(failed),
        unprocessed: list(unprocessed),
      },
    };
  };

  test("only an archive sitemap skipped on purpose: the crawl is complete (Moh Maya)", () => {
    const c = run(
      ledger({ skipped: ["https://mohmaya.example/category-sitemap.xml"] }),
    );
    expect(c.crawl).toMatchObject({ complete: true, limits: [] });
    expect(one(c, ACC).state).toBe("confirmed");
  });

  test("failed or unread sitemaps: incomplete, with what happened", () => {
    const c = run(
      ledger({
        failed: ["https://mohmaya.example/page-sitemap.xml"],
        unprocessed: ["https://mohmaya.example/x-sitemap.xml"],
      }),
    );
    expect(c.crawl!.limits).toContain(
      "2 sitemap files listed by the site could not be read (1 failed, 1 beyond the crawl's limits), so pages listed only there were not checked.",
    );
    expect(one(c, ACC).state).toBe("incomplete");
  });
});

describe("final correctness pass (sprint 4)", () => {
  test("“not offered” matches an offering's approved other wordings; unrelated offerings are unaffected", () => {
    const c = cover(
      [{ ...HOME, title: "Welcome", h1: ["Welcome"] }],
      [
        fact({
          kind: "SERVICE",
          value: "Glamping pods",
          synonyms: ["Camping"],
        }),
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "EXCLUDED", value: "Camping" }),
      ],
    );
    expect(c.opportunities.find((o) => /Glamping/.test(o.key))?.state).toBe(
      "unsupported",
    );
    expect(
      c.opportunities.find((o) => /Boiler repair/.test(o.key))?.state,
    ).toBe("confirmed");
    // A synonym belonging to another part of a compound fact is not this offering's.
    const split = cover(
      [{ ...HOME, title: "Welcome", h1: ["Welcome"] }],
      [
        fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
        fact({
          kind: "SERVICE",
          value: "Cottages and Cafe",
          synonyms: ["Camping"],
        }),
        fact({ kind: "EXCLUDED", value: "Camping" }),
      ],
    );
    expect(one(split, "BIZ_ACCOMMODATION_PAGE").state).not.toBe("unsupported");
  });

  test("a one-page site: the business name from the profile is stripped from the title", () => {
    const home = page({
      path: "/",
      title: "Cottages Near Kasol | MOH MAYA Cottages & Cafe",
      h1: ["Welcome"],
    });
    const plain = analyzeCoverage({
      websiteUrl: SITE,
      crawl: { status: "COMPLETED", analyzedAt: RECENT, pages: [home] },
      facts: MOH_MAYA(),
      now: NOW,
    });
    expect(plain.pages[0].title).toBe(home.title); // one page: no repetition to learn from
    const withBrand = analyzeCoverage({
      websiteUrl: SITE,
      crawl: { status: "COMPLETED", analyzedAt: RECENT, pages: [home] },
      facts: MOH_MAYA(),
      now: NOW,
      brandNames: ["MOH MAYA Cottages & Cafe"],
    });
    expect(withBrand.pages[0].title).toBe("Cottages Near Kasol");
    expect(withBrand.pages[0].fullTitle).toBe(home.title);
  });

  test("a brand containing the town still names the town, but never makes a page about it", () => {
    const brand = "Kasol Cottages";
    const pages = [
      page({ path: "/", title: `Welcome | ${brand}`, h1: ["Welcome"] }),
      page({ path: "/about/", title: `About us | ${brand}`, h1: ["About us"] }),
    ];
    const facts = [
      fact({ kind: "LOCATION", value: "Kasol" }),
      fact({ kind: "SERVICE", value: "Cottages" }),
    ];
    const c = analyzeCoverage({
      websiteUrl: SITE,
      crawl: { status: "COMPLETED", analyzedAt: RECENT, pages },
      facts,
      now: NOW,
    });
    expect(c.needs.find((n) => n.kind === "location-mention")?.status).toBe(
      "covered",
    );
    // The brand does not make /about/ a page about the cottages.
    expect(one(c, "BIZ_SERVICE_PAGE").state).toBe("confirmed");
  });

  test("the canonical is checked against the page's final URL", () => {
    const at = (canonicalUrl: string): EvidencePage => ({
      ...page({ path: "/cottages", title: "Cottages" }),
      finalUrl: `${SITE}cottages/`,
      canonicalUrl,
    });
    const read = (p: EvidencePage) =>
      analyzeCoverage({
        websiteUrl: SITE,
        crawl: {
          status: "COMPLETED",
          analyzedAt: RECENT,
          pages: [page(HOME), p],
        },
        facts: MOH_MAYA(),
        now: NOW,
      }).pages[1];
    expect(read(at(`${SITE}cottages/`)).canonicalElsewhere).toBe(false);
    expect(read(at(`${SITE}rooms/`)).canonicalElsewhere).toBe(true);
  });
});

describe("fact provenance: what the client confirmed versus our understanding", () => {
  const pages = [HOME, PRIVACY];
  const ACCOMMODATION =
    "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)";
  const withSource = (source: Fact["source"]) =>
    MOH_MAYA().map((f) => (f.kind === "SERVICE" ? { ...f, source } : f));

  test("facts the client supplied need no confirmation note", () => {
    const c = cover(pages, MOH_MAYA());
    const o = one(c, "BIZ_ACCOMMODATION_PAGE");
    expect(o.assumptions.join(" ")).not.toMatch(/Not confirmed by the client/);
    const m = coverageMeta(ACCOMMODATION, c)!;
    expect(m.priorityRationale).toMatch(
      /“Cottages and Cafe” \(from the client\)/,
    );
    expect(m.limits.join(" ")).not.toMatch(/Not confirmed by the client/);
  });

  test("a fact our team entered is flagged first, but the gap itself is unchanged", () => {
    const c = cover(pages, withSource("TEAM"));
    const o = one(c, "BIZ_ACCOMMODATION_PAGE");
    // Provenance does not change what the crawl shows: still recommended.
    expect(o).toMatchObject({ state: "confirmed", recommend: true });
    expect(o.assumptions[0]).toBe(
      "Not confirmed by the client: “Cottages and Cafe” (entered by our team, not confirmed by the client). Check with the client that this is accurate before publishing anything based on it.",
    );
    const m = coverageMeta(ACCOMMODATION, c)!;
    expect(m.priorityRationale).toMatch(
      /“Cottages and Cafe” \(entered by our team, not confirmed by the client\)/,
    );
    expect(m.limits[0]).toMatch(/^Not confirmed by the client/);
    // Opportunities resting only on client-supplied facts are not flagged.
    const contact = one(c, "BIZ_CONTACT_PATH");
    expect(contact.assumptions.join(" ")).not.toMatch(
      /Not confirmed by the client/,
    );
  });

  test("imported facts are not treated as confirmed either", () => {
    const o = one(cover(pages, withSource("IMPORT")), "BIZ_ACCOMMODATION_PAGE");
    expect(o.assumptions[0]).toMatch(
      /“Cottages and Cafe” \(imported, not confirmed by the client\)/,
    );
  });

  test("coverage checks carry the note in their recommendation limits", () => {
    const facts = [
      ...MOH_MAYA(),
      fact({ kind: "SERVICE_AREA", value: "Manali", source: "IMPORT" }),
    ];
    const c = cover(pages, facts);
    const need = c.needs.find((x) => x.kind === "service-areas");
    expect(need?.recommend).toBe(true);
    const m = coverageMeta(need!.key, c)!;
    expect(m.priorityRationale).toMatch(
      /“Manali” \(imported, not confirmed by the client\)/,
    );
    expect(m.limits[0]).toMatch(
      /^Not confirmed by the client: “Manali” \(imported/,
    );
  });
});

describe("a task whose opportunity was replaced is held, never completed", () => {
  // "hospitality" splits “Cottages and Cafe” into accommodation and food
  // pages. If the re-key of the old task was skipped (an Accept created the
  // new title first), the old task matches no opportunity. A stale
  // service-page need for the old title is "covered" by the home page title,
  // but page needs never decide completion.
  const OLD = "Add a page for “Cottages and Cafe” (BIZ_SERVICE_PAGE)";
  const ACC_KEY =
    "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)";
  const c = cover([HOME, PRIVACY], MOH_MAYA(), {
    existing: new Map([[OLD, "IN_PROGRESS"]]),
  });

  test("the old title has no opportunity, only a page need the home page covers", () => {
    expect(c.opportunities.find((o) => o.key === OLD)).toBeUndefined();
    expect(c.needs.find((n) => n.key === OLD)).toMatchObject({
      kind: "service-page",
      status: "covered",
    });
  });

  test("heldReason holds it for review instead of completing it", () => {
    const ctx = { issues: new Map(), remainingRules: new Map(), coverage: c };
    expect(heldReason({ title: OLD, issueId: null }, ctx)).toBe("ignored");
    // Tasks with a live opportunity or a non-page need are unaffected.
    expect(heldReason({ title: ACC_KEY, issueId: null }, ctx)).toBe(
      "unverified",
    );
  });
});

describe("business coverage accuracy: Moh Maya's real page shapes", () => {
  const BRAND = "MOH MAYA COTTAGES & CAFE";
  const MM_HOME: Spec = {
    path: "/",
    title: "Cottages Near Kasol | MOH MAYA Cottages & Cafe",
    h1: ["Cottages Near Kasol for a Peaceful Mountain Stay"],
    h2: [
      "Explore Our Cottages Near Kasol",
      "Camping Stays",
      "Birthday Celebrations",
      "Weekend DJ Nights",
      "A Little Cafe Time in the Mountains",
    ],
    words: 514,
    blocks: [
      "Looking for cottages near Kasol? MOH MAYA Cottages & Cafe offers a peaceful mountain stay in Sosan.",
      "8 Cottages 4 Camping Tents Cafe & Restaurant",
      "Mountain Cottages: unwind in a cozy private room after a day exploring.",
      "Enquire About Cottages",
      "Camping Stays: enjoy an outdoor escape with mountain scenery and fresh air.",
      "Enquire About Camping",
      "Birthday Celebrations",
      "Ask about private group arrangements for your occasion.",
      "Weekend DJ Nights. Ask us about upcoming music nights and availability.",
      "Cafe & Restaurant. Breakfast package. Group dinner.",
    ],
    contact: { tel: 4, whatsapp: 11 },
    meta: "Discover cottages near Kasol at MOH MAYA Cottages & Cafe in Sosan, Himachal Pradesh. Enjoy mountain views, camping, bonfires and cafe dining.",
  };
  const MM_PRIVACY: Spec = {
    path: "/privacy-policy/",
    title: `Privacy Policy - ${BRAND}`,
    h1: ["Privacy Policy"],
    h2: ["3. WhatsApp and Telephone Enquiries", `13. Contact ${BRAND}`],
    words: 1266,
    blocks: [
      "We use your details to answer enquiries about cottages, camping and the cafe.",
    ],
  };
  const MM_HELLO: Spec = {
    path: "/hello-world/",
    title: `Hello world! - ${BRAND}`,
    h1: ["Hello world!"],
    words: 52,
    schema: [{ "@type": "BlogPosting", headline: "Hello world!" }],
    blocks: [
      "Welcome to WordPress. This is your first post. Edit or delete it, then start writing!",
    ],
  };
  const PAGES = [MM_HOME, MM_HELLO, MM_PRIVACY];
  const base = (groupSynonyms: string[] = []) => [
    fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
    fact({
      kind: "SERVICE",
      value: "Cottages",
      synonyms: ["Mountain cottages"],
    }),
    fact({ kind: "SERVICE", value: "Camping", synonyms: ["Camping stays"] }),
    fact({ kind: "SERVICE", value: "Cafe", synonyms: ["Restaurant"] }),
    fact({
      kind: "SERVICE",
      value: "Private group parties",
      synonyms: groupSynonyms,
    }),
    fact({ kind: "SERVICE", value: "Mountain photography spot" }),
    fact({ kind: "SERVICE", value: "Birthday celebrations" }),
    fact({
      kind: "SERVICE",
      value: "Weekend DJ nights",
      synonyms: ["DJ nights"],
    }),
    fact({
      kind: "LOCATION",
      value: "Sosan, Himachal Pradesh 175105",
      synonyms: ["Sosan"],
    }),
    fact({ kind: "GOAL", value: "bookings" }),
    fact({ kind: "GOAL", value: "calls" }),
  ];
  const PARTIES = "Add a page for “Private group parties” (BIZ_SERVICE_PAGE)";
  const PHOTO = "Add a page for “Mountain photography spot” (BIZ_SERVICE_PAGE)";
  const opp = (c: CoverageResult, key: string) =>
    c.opportunities.find((o) => o.key === key)!;
  const verdict = (o: PageOpportunity, path: string) =>
    o.considered.find((p) => new URL(p.url).pathname === path)?.verdict;

  test("1. private group arrangements on the home page: a mention to review, not a gap", () => {
    // With the alternate name configured, the home page's body mention is evidence.
    const c = cover(PAGES, base(["Private group arrangements"]));
    expect(opp(c, PARTIES)).toMatchObject({
      category: "experience",
      state: "review",
      recommend: false,
    });
    const need = c.needs.find((n) => n.key === PARTIES)!;
    expect(need.status).toBe("weak");
    expect(need.matches[0]).toMatchObject({
      strength: "weak",
      where: ["main content"],
    });
    // Without it, no fuzzy match ("parties" ≠ "arrangements"), but an
    // event is never a confirmed standalone-page gap either.
    const plain = opp(cover(PAGES, base()), PARTIES);
    expect(plain).toMatchObject({ state: "review", recommend: false });
    expect(plain.stateReason).toMatch(/It is an experience or event/);
  });

  test("2. a photography spot is an experience: optional, LOW, never automatic", () => {
    const o = opp(cover(PAGES, base()), PHOTO);
    expect(o).toMatchObject({
      category: "experience",
      name: "Mountain photography spot (experience or event)",
      state: "review",
      priority: "LOW",
      recommend: false,
    });
    expect(o.priorityReason).toMatch(/supports a stay/);
  });

  test("3. cottages: discussed on the home page, so a dedicated page is optional; alone, the home page fulfils it", () => {
    const c = cover(PAGES, base());
    const cottages = opp(
      c,
      "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)",
    );
    expect(cottages).toMatchObject({ state: "review", recommend: false });
    expect(verdict(cottages, "/")).toMatch(/main content discusses it/);
    const alone = cover(PAGES, [
      fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
      fact({ kind: "SERVICE", value: "Cottages" }),
      fact({ kind: "GOAL", value: "bookings" }),
    ]);
    expect(one(alone, "BIZ_ACCOMMODATION_PAGE")).toMatchObject({
      state: "fulfilled",
      fulfilledBy: new URL("/", SITE).href,
    });
  });

  test("4. camping: covered by home-page passages, a dedicated page is an option to review", () => {
    const camping = cover(PAGES, base()).opportunities.find((o) =>
      o.key.includes("“Camping”"),
    )!;
    expect(camping).toMatchObject({ state: "review", recommend: false });
    expect(camping.stateReason).toMatch(/dedicated page is optional/);
  });

  test("5. the privacy policy and the default WordPress post are never offering pages", () => {
    const c = cover(PAGES, base());
    const byPath = Object.fromEntries(
      c.pages.map((p) => [new URL(p.url).pathname, p.type]),
    );
    expect(byPath).toMatchObject({
      "/privacy-policy/": "legal",
      "/hello-world/": "article",
    });
    for (const o of c.opportunities) {
      expect(o.fulfilledBy ?? "").not.toMatch(/privacy-policy|hello-world/);
      if (o.considered.some((p) => p.url.includes("privacy-policy")))
        expect(verdict(o, "/privacy-policy/")).toBe(
          "Legal page: not considered.",
        );
    }
  });

  test("6. the business name in a heading is not evidence for its words", () => {
    const GALLERY: Spec = {
      path: "/gallery/",
      title: `Gallery - ${BRAND}`,
      h1: ["Gallery"],
      h2: [`Moments at ${BRAND}`],
    };
    const c = cover([...PAGES, GALLERY], base());
    for (const kind of ["Cottages", "Cafe"]) {
      const need = c.needs.find(
        (n) => n.kind === "service-page" && n.facts[0].value === kind,
      )!;
      const urls = need.matches.map((m) => new URL(m.url).pathname);
      expect(urls, kind).not.toContain("/privacy-policy/");
      expect(urls, kind).not.toContain("/gallery/");
    }
    // A heading that names the offering beside the brand still counts.
    const named = cover(
      [...PAGES, { ...GALLERY, h2: [`Our cottages at ${BRAND}`] }],
      base(),
    ).needs.find((n) => n.facts[0].value === "Cottages")!;
    expect(named.matches.map((m) => new URL(m.url).pathname)).toContain(
      "/gallery/",
    );
  });

  test("a location named only in body text: no task, and never counted as covered", () => {
    const c = cover(
      [{ ...MM_HOME, meta: undefined }, MM_HELLO, MM_PRIVACY],
      base(),
    );
    const need = c.needs.find((n) => n.kind === "location-mention")!;
    expect(need).toMatchObject({ status: "weak", recommend: false });
    expect(need.note).toMatch(/Named only in the main text/);
    const key = need.key;
    const ctx = { issues: new Map(), remainingRules: new Map(), coverage: c };
    expect(heldReason({ title: key, issueId: null }, ctx)).toBe("unverified");
  });

  test("7. nothing new is created automatically for Moh Maya", () => {
    expect(coverageDrafts(cover(PAGES, base())).map((d) => d.title)).toEqual(
      [],
    );
  });

  test("8. existing tasks keep their identity: kept, never completed or duplicated, and can be dismissed", () => {
    const existing: ExistingTasks = new Map([
      [PARTIES, "PROPOSED"],
      [PHOTO, "PROPOSED"],
    ]);
    const c = cover(PAGES, base(), { existing });
    for (const key of [PARTIES, PHOTO]) {
      // Same title (identity), still in the plan, now LOW and explained.
      expect(opp(c, key)).toMatchObject({
        decision: "accepted",
        recommend: true,
        priority: "LOW",
        state: "review",
      });
      const ctx = { issues: new Map(), remainingRules: new Map(), coverage: c };
      expect(heldReason({ title: key, issueId: null }, ctx)).toBe("unverified");
    }
    // Drafts update the same two titles; no new task appears.
    expect(
      coverageDrafts(c)
        .map((d) => d.title)
        .sort(),
    ).toEqual([PARTIES, PHOTO].sort());
    expect(coverageDrafts(c).map((d) => d.priority)).toEqual(["LOW", "LOW"]);
    expect(
      rekeyTasks(
        [PARTIES, PHOTO].map((title, i) => ({
          id: `t${i}`,
          title,
          status: "PROPOSED" as const,
          issueId: null,
          updatedAt: NOW,
        })),
        c,
      ).moves,
    ).toEqual([]);
    // A person's dismissal is kept.
    const dismissed = cover(PAGES, base(), {
      existing: new Map([[PHOTO, "DISMISSED"]]),
    });
    expect(opp(dismissed, PHOTO)).toMatchObject({
      decision: "dismissed",
      recommend: false,
    });
  });
});
