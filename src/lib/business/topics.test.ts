import { describe, expect, test } from "vitest";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import { analyzeCoverage } from "./coverage";
import type { Fact } from "./facts";
import { buildTopicMap, MAX_TOPICS, type Topic, type TopicMap } from "./topics";

const SITE = "https://plumber.example/";
const NOW = new Date("2026-10-24T12:00:00Z");
const RECENT = new Date("2026-10-24T11:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
const fact = (o: Partial<Fact> & Pick<Fact, "kind" | "value">): Fact => ({
  id: `f${String(n++).padStart(3, "0")}`,
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
  words?: number;
  robots?: string;
  canonical?: string;
  skip?: EvidencePage["skipReason"];
  /** Main-content passages (default: one sentence naming the title). */
  blocks?: string[];
};
const page = (p: Spec): EvidencePage => ({
  url: new URL(p.path, SITE).href,
  status: p.skip ? "SKIPPED" : "CRAWLED",
  httpStatus: p.skip ? null : 200,
  resourceType: "HTML",
  finalUrl: null,
  canonicalUrl: p.canonical ? new URL(p.canonical, SITE).href : null,
  robotsMetaRaw: p.robots ?? null,
  depth: 1,
  skipReason: p.skip ?? null,
  title: p.title ?? null,
  metaDescription: null,
  wordCount: p.words ?? 400,
  result: p.skip
    ? null
    : {
        headings: { h1: p.h1 ?? [], h2: p.h2 ?? [], h3: [] },
        links: [],
        structuredData: [],
        content: {
          v: 1,
          source: "main",
          words: p.words ?? 400,
          blocks: (
            p.blocks ?? [`Read about ${p.title ?? "us"} from our engineers.`]
          ).map((t) => ({ t, w: t.split(" ").length })),
        },
        contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
      },
});
const HOME: Spec = {
  path: "/",
  title: "Local plumbers | Acme Plumbing",
  h1: ["Your local plumbers"],
  blocks: ["We are a family firm of plumbers."],
};
const BOILER: Spec = {
  path: "/boiler-repair",
  title: "Boiler Repair | Acme Plumbing",
  h1: ["Boiler repair"],
  blocks: ["Our engineers handle boiler repair for every make and model."],
};

const map = (
  specs: Spec[] | null,
  facts: Fact[],
  o: {
    status?: "COMPLETED" | "PARTIAL" | "FAILED";
    at?: Date;
    crawlId?: string | null;
    brand?: string[];
    errorPages?: Array<{ url: string; httpStatus: number | null }>;
  } = {},
): TopicMap => {
  const c = analyzeCoverage({
    websiteUrl: SITE,
    crawl: specs
      ? {
          status: o.status ?? "COMPLETED",
          analyzedAt: o.at ?? RECENT,
          pages: specs.map(page),
        }
      : null,
    facts,
    now: NOW,
    brandNames: o.brand,
  });
  return buildTopicMap({
    facts,
    pages: c.pages,
    crawl: c.crawl,
    crawlId: o.crawlId === undefined ? "run-1" : o.crawlId,
    errorPages: o.errorPages,
    now: NOW,
  });
};
const topic = (m: TopicMap, label: string): Topic => {
  const t = m.topics.find((x) => x.label === label);
  expect(t, label).toBeDefined();
  return t!;
};
const labels = (m: TopicMap) => m.topics.map((t) => t.label);

describe("topics come from approved facts only", () => {
  test("pending, rejected and inferred facts create no topics", () => {
    const m = map(
      [HOME, BOILER],
      [
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "SERVICE", value: "Gas fitting", status: "PENDING" }),
        fact({ kind: "SERVICE", value: "Roofing", status: "REJECTED" }),
        fact({
          kind: "SERVICE",
          value: "Solar panels",
          source: "INFERENCE",
          status: "PENDING",
        }),
        // Unapproved locations and audiences add no variants or context.
        fact({ kind: "LOCATION", value: "Leeds", status: "PENDING" }),
        fact({ kind: "LOCATION", value: "York", status: "PENDING" }),
        fact({ kind: "AUDIENCE", value: "Landlords", status: "REJECTED" }),
      ],
    );
    expect(labels(m)).toEqual(["Boiler repair"]);
    expect(m.topics[0].audiences).toEqual([]);
    expect(m.locationNote).toBeNull();
  });

  test("an approved 'not offered' fact suppresses its topic; a pending one does not", () => {
    const m = map(
      [HOME, BOILER],
      [
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "SERVICE", value: "Drain unblocking" }),
        fact({ kind: "SERVICE", value: "Gas fitting" }),
        fact({ kind: "EXCLUDED", value: "Drain unblocking" }),
        fact({ kind: "EXCLUDED", value: "Gas fitting", status: "PENDING" }),
      ],
    );
    expect(labels(m)).toEqual(["Boiler repair", "Gas fitting"]);
    expect(m.suppressed).toEqual([
      { label: "Drain unblocking", by: "Drain unblocking" },
    ]);
  });

  test("no approved facts: no topics", () => {
    expect(map([HOME], []).topics).toEqual([]);
  });
});

describe("service and service × location topics", () => {
  const services = () => [
    fact({ kind: "SERVICE", value: "Boiler repair" }),
    fact({ kind: "SERVICE", value: "Drain unblocking" }),
  ];

  test("one approved location is context, not a variant", () => {
    const m = map(
      [HOME, BOILER],
      [...services(), fact({ kind: "LOCATION", value: "Leeds" })],
    );
    expect(labels(m)).toEqual(["Boiler repair", "Drain unblocking"]);
    expect(m.locationNote).toMatch(/One approved location/);
  });

  test("several approved locations: each service is mapped per location", () => {
    const m = map(
      [HOME, BOILER],
      [
        ...services(),
        fact({ kind: "LOCATION", value: "York" }),
        fact({ kind: "LOCATION", value: "Leeds" }),
      ],
    );
    expect(labels(m)).toEqual([
      "Boiler repair",
      "Drain unblocking",
      "Boiler repair in Leeds",
      "Boiler repair in York",
      "Drain unblocking in Leeds",
      "Drain unblocking in York",
    ]);
    expect(topic(m, "Boiler repair in York")).toMatchObject({
      key: "service:boiler repair|location:york",
      service: "Boiler repair",
      location: "York",
    });
    expect(topic(m, "Boiler repair in York").facts.map((f) => f.value)).toEqual(
      ["Boiler repair", "York"],
    );
  });

  test("the approved multi-location type with one location adds variants", () => {
    const m = map(
      [HOME],
      [
        fact({ kind: "BUSINESS_TYPE", value: "multi-location" }),
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "LOCATION", value: "Leeds" }),
      ],
    );
    expect(labels(m)).toEqual(["Boiler repair", "Boiler repair in Leeds"]);
  });

  test("audience is an attribute of every topic, never a topic", () => {
    const m = map(
      [HOME, BOILER],
      [
        ...services(),
        fact({ kind: "LOCATION", value: "Leeds" }),
        fact({ kind: "LOCATION", value: "York" }),
        fact({ kind: "AUDIENCE", value: "Landlords", source: "TEAM" }),
        fact({ kind: "AUDIENCE", value: "Homeowners" }),
      ],
    );
    expect(m.topics).toHaveLength(6);
    for (const t of m.topics) {
      expect(t.audiences.map((a) => a.value)).toEqual([
        "Homeowners",
        "Landlords",
      ]);
      expect(t.label).not.toMatch(/Landlords|Homeowners/);
    }
    expect(m.topics[0].audiences[1]).toMatchObject({ source: "TEAM" });
  });

  test("a 'not offered' place or pair suppresses only those variants", () => {
    const m = map(
      [HOME],
      [
        ...services(),
        fact({ kind: "LOCATION", value: "Leeds" }),
        fact({ kind: "LOCATION", value: "York" }),
        fact({ kind: "EXCLUDED", value: "Drain unblocking in York" }),
      ],
    );
    expect(labels(m)).not.toContain("Drain unblocking in York");
    expect(labels(m)).toContain("Boiler repair in York");
    expect(labels(m)).toContain("Drain unblocking");
  });

  test("hospitality: a compound offering splits as page opportunities do", () => {
    const m = map(
      [HOME],
      [
        fact({ kind: "BUSINESS_TYPE", value: "hospitality" }),
        fact({ kind: "SERVICE", value: "Cottages and Cafe" }),
      ],
    );
    expect(labels(m)).toEqual(["Cafe", "Cottages"]);
  });
});

describe("page mapping and provenance", () => {
  const facts = () => [
    fact({
      kind: "SERVICE",
      value: "Boiler repair",
      synonyms: ["Boiler servicing"],
    }),
  ];

  test("covered: cites the crawled page, where it matched, the wording and the crawl", () => {
    const m = map([HOME, BOILER], facts(), { crawlId: "run-42" });
    const t = topic(m, "Boiler repair");
    expect(t.state).toBe("covered");
    expect(t.reason).toBe(`Covered by ${SITE}boiler-repair.`);
    expect(t.evidence[0]).toMatchObject({
      url: `${SITE}boiler-repair`,
      strength: "strong",
      matched: ["Boiler repair"],
      locationWhere: null,
    });
    expect(t.evidence[0].where).toEqual(
      expect.arrayContaining(["title", "main heading", "URL"]),
    );
    expect(m.crawl).toMatchObject({
      id: "run-42",
      analyzedAt: RECENT,
      status: "COMPLETED",
      complete: true,
      freshness: { state: "fresh", ageDays: 0 },
    });
  });

  test("a synonym a person entered matches, and is named as the wording", () => {
    const m = map(
      [
        HOME,
        {
          path: "/servicing",
          title: "Boiler Servicing | Acme Plumbing",
          h1: ["Boiler servicing"],
          blocks: ["Annual boiler servicing keeps your heating safe."],
        },
      ],
      facts(),
    );
    const t = topic(m, "Boiler repair");
    expect(t.state).toBe("covered");
    expect(t.evidence[0].matched).toEqual(["Boiler servicing"]);
  });

  test.each([
    [
      "only in a subheading",
      {
        ...BOILER,
        title: "Heating | Acme Plumbing",
        h1: ["Heating"],
        h2: ["Boiler repair"],
      },
      /^Mentions it \(subheading/,
    ],
    [
      "thin main content",
      { ...BOILER, words: 60 },
      /main content has only 60 words/,
    ],
    ["noindex", { ...BOILER, robots: "noindex" }, /not to index it/],
    [
      "canonicalised elsewhere",
      { ...BOILER, canonical: "/heating" },
      /canonical points at a different URL/,
    ],
  ])("partial: %s", (_label, spec, verdict) => {
    const t = topic(map([HOME, spec], facts()), "Boiler repair");
    expect(t.state).toBe("partial");
    expect(t.evidence[0].url).toBe(`${SITE}boiler-repair`);
    expect(t.evidence[0].verdict).toMatch(verdict);
    expect(t.evidence[0].matched).toContain("Boiler repair");
  });

  test("partial: the reason names the page about it and what it lacks", () => {
    const t = topic(
      map([HOME, { ...BOILER, words: 60 }], facts()),
      "Boiler repair",
    );
    expect(t.reason).toBe(
      `${SITE}boiler-repair is about it, but its main content has only 60 words, not counting the header, navigation, footer or text repeated across the site.`,
    );
  });

  test("a service page and its location page: covered, with no competition claimed", () => {
    const m = map(
      [
        HOME,
        BOILER,
        {
          path: "/boiler-repair-york",
          title: "Boiler Repair in York | Acme Plumbing",
          h1: ["Boiler repair in York"],
          blocks: ["Our boiler repair team covers all of York."],
        },
      ],
      [
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "LOCATION", value: "Leeds" }),
        fact({ kind: "LOCATION", value: "York" }),
      ],
    );
    expect(topic(m, "Boiler repair").reason).toBe(
      `Covered by ${SITE}boiler-repair and 1 other page.`,
    );
  });

  test("a reason lists the wordings only when they add something", () => {
    const m = map(
      [HOME],
      [
        fact({ kind: "SERVICE", value: "Drain unblocking" }),
        fact({
          kind: "SERVICE",
          value: "Boiler repair",
          synonyms: ["Boilers"],
        }),
      ],
    );
    expect(topic(m, "Drain unblocking").reason).toMatch(
      /^No analysed page names “Drain unblocking”\. /,
    );
    expect(topic(m, "Boiler repair").reason).toMatch(
      /names “Boiler repair” \(“Boiler repair”, “Boilers”\)\./,
    );
  });

  test("the site name is no match: a brand naming a place covers no variant", () => {
    const brand = ["Leeds Plumbing"];
    const m = map(
      [
        { ...HOME, title: "Local plumbers | Leeds Plumbing" },
        {
          ...BOILER,
          title: "Boiler Repair | Leeds Plumbing",
          blocks: ["Boiler repair by Leeds Plumbing engineers."],
        },
        {
          path: "/boiler-repair-york",
          title: "Boiler Repair in York | Leeds Plumbing",
          h1: ["Boiler repair in York"],
          blocks: ["Our boiler repair team covers all of York."],
        },
      ],
      [
        fact({ kind: "SERVICE", value: "Boiler repair" }),
        fact({ kind: "LOCATION", value: "Leeds" }),
        fact({ kind: "LOCATION", value: "York" }),
      ],
      { brand },
    );
    const leeds = topic(m, "Boiler repair in Leeds");
    expect(leeds.evidence).toEqual([]);
    expect(leeds.state).toBe("none");
    const york = topic(m, "Boiler repair in York");
    expect(york.state).toBe("covered");
    expect(york.evidence[0]).toMatchObject({
      url: `${SITE}boiler-repair-york`,
      matched: ["Boiler repair", "York"],
    });
    expect(york.evidence[0].locationWhere).toEqual(
      expect.arrayContaining(["title", "main heading"]),
    );
  });

  test("a URL that names it and returns an error is not checked, not none", () => {
    const t = topic(
      map([HOME], [fact({ kind: "SERVICE", value: "Drain unblocking" })], {
        errorPages: [{ url: `${SITE}drain-unblocking`, httpStatus: 404 }],
      }),
      "Drain unblocking",
    );
    expect(t.state).toBe("not-checked");
    expect(t.reason).toMatch(/returns HTTP 404/);
  });

  test("a URL blocked by robots.txt that names it is not checked, not none", () => {
    const m = map(
      [HOME, { path: "/drain-unblocking", skip: "ROBOTS_DISALLOWED" }],
      [fact({ kind: "SERVICE", value: "Drain unblocking" })],
    );
    const t = topic(m, "Drain unblocking");
    expect(t.state).toBe("not-checked");
    expect(t.reason).toMatch(/blocked by robots\.txt/);
  });
});

describe("crawl evidence: never 'none' on incomplete or stale evidence", () => {
  const facts = () => [
    fact({ kind: "SERVICE", value: "Boiler repair" }),
    fact({ kind: "SERVICE", value: "Drain unblocking" }),
  ];
  const stale = new Date(
    NOW.getTime() - (EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO + 5) * DAY,
  );

  test("fresh, complete crawl: an unserved topic is none", () => {
    const t = topic(map([HOME, BOILER], facts()), "Drain unblocking");
    expect(t).toMatchObject({ state: "none", evidence: [], pagesMatched: 0 });
    expect(t.reason).toMatch(/The crawl completed within its limits/);
  });

  test.each([
    ["partial", { status: "PARTIAL" as const }, [HOME, BOILER], "incomplete"],
    ["failed", { status: "FAILED" as const }, [HOME, BOILER], "incomplete"],
    [
      "page-limited",
      {},
      [HOME, BOILER, { path: "/more", skip: "BUDGET_EXCEEDED" as const }],
      "fresh",
    ],
    ["stale", { at: stale }, [HOME, BOILER], "stale"],
    [
      "dated in the future",
      { at: new Date(NOW.getTime() + 2 * DAY) },
      [HOME, BOILER],
      "unknown",
    ],
  ])("%s crawl: not checked", (_label, opts, specs, freshness) => {
    const m = map(specs, facts(), opts);
    expect(topic(m, "Drain unblocking").state).toBe("not-checked");
    expect(m.topics.some((t) => t.state === "none")).toBe(false);
    expect(m.crawl?.freshness.state).toBe(freshness);
  });

  test("a page found on a stale crawl is still cited, with the crawl labelled stale", () => {
    const m = map([HOME, BOILER], facts(), { at: stale });
    expect(topic(m, "Boiler repair").state).toBe("covered");
    expect(m.crawl).toMatchObject({
      analyzedAt: stale,
      freshness: { state: "stale" },
    });
    expect(m.crawl?.gap).toMatch(/days old/);
  });

  test("no crawl: every topic is not checked, with no crawl, id or date", () => {
    const m = map(null, facts());
    expect(m.crawl).toBeNull();
    for (const t of m.topics) {
      expect(t.state).toBe("not-checked");
      expect(t.evidence).toEqual([]);
    }
  });

  test("a crawl id the loader did not provide stays null", () => {
    expect(map([HOME], facts(), { crawlId: null }).crawl?.id).toBeNull();
  });
});

describe("determinism", () => {
  const many = () => [
    ...Array.from({ length: 12 }, (_, i) =>
      fact({ kind: "SERVICE", value: `Service ${String(i).padStart(2, "0")}` }),
    ),
    ...["Leeds", "York", "Hull", "Bradford", "Wakefield"].map((v) =>
      fact({ kind: "LOCATION", value: v }),
    ),
    fact({ kind: "AUDIENCE", value: "Landlords" }),
  ];

  test("the same keys and output whatever the order of the facts", () => {
    const facts = [
      fact({ kind: "SERVICE", value: "Boiler repair", synonyms: ["Boilers"] }),
      fact({ kind: "SERVICE", value: "Drain unblocking" }),
      fact({ kind: "LOCATION", value: "York" }),
      fact({ kind: "LOCATION", value: "Leeds" }),
      fact({ kind: "AUDIENCE", value: "Landlords" }),
      fact({ kind: "AUDIENCE", value: "Homeowners" }),
    ];
    const a = map([HOME, BOILER], facts);
    const b = map([BOILER, HOME], [...facts].reverse());
    expect(b).toEqual(a);
    expect(a.topics.map((t) => t.key)).toEqual([
      "service:boiler repair",
      "service:drain unblocking",
      "service:boiler repair|location:leeds",
      "service:boiler repair|location:york",
      "service:drain unblocking|location:leeds",
      "service:drain unblocking|location:york",
    ]);
  });

  test(`at most ${MAX_TOPICS} topics: services first, then variants, deterministically`, () => {
    const facts = many();
    const a = map([HOME], facts);
    expect(a.topics).toHaveLength(MAX_TOPICS);
    expect(a.omitted).toBe(12 + 12 * 5 - MAX_TOPICS);
    expect(a.topics.slice(0, 12).every((t) => t.location === null)).toBe(true);
    expect(map([HOME], [...facts].reverse())).toEqual(a);
    expect(map([HOME], facts)).toEqual(a);
  });
});
