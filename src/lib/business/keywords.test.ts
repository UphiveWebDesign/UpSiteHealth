import { describe, expect, test } from "vitest";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import { analyzeCoverage } from "./coverage";
import type { Fact } from "./facts";
import {
  buildKeywordMap,
  MAX_CANDIDATES,
  type KeywordCandidate,
  type KeywordMap,
} from "./keywords";
import { buildTopicMap } from "./topics";

const SITE = "https://plumber.example/";
const NOW = new Date("2026-10-25T12:00:00Z");
const RECENT = new Date("2026-10-25T11:00:00Z");
const APPROVED = new Date("2026-10-20T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
const fact = (o: Partial<Fact> & Pick<Fact, "kind" | "value">): Fact => ({
  id: `f${String(n++).padStart(3, "0")}`,
  synonyms: [],
  source: "CLIENT",
  status: "APPROVED",
  reviewedAt: o.status === "PENDING" ? null : APPROVED,
  ...o,
});
type Spec = {
  path: string;
  title: string;
  h1: string;
  h2?: string[];
  words?: number;
  robots?: string;
  canonical?: string;
  blocks?: string[];
  skip?: EvidencePage["skipReason"];
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
  title: p.title,
  metaDescription: null,
  wordCount: p.words ?? 400,
  result: p.skip
    ? null
    : {
        headings: { h1: [p.h1], h2: p.h2 ?? [], h3: [] },
        links: [],
        structuredData: [],
        content: {
          v: 1,
          source: "main",
          words: p.words ?? 400,
          blocks: (p.blocks ?? [`All about ${p.h1}.`]).map((t) => ({
            t,
            w: t.split(" ").length,
          })),
        },
        contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
      },
});

const HOME: Spec = {
  path: "/",
  title: "Plumbers | Acme Plumbing",
  h1: "Local plumbers",
  blocks: ["A family firm of plumbers."],
};
const BOILER: Spec = {
  path: "/boiler-repair",
  title: "Boiler Repair | Acme Plumbing",
  h1: "Boiler repair",
  blocks: ["Our engineers handle boiler repair for every make and model."],
};
const YORK_BOILER: Spec = {
  path: "/boiler-repair-york",
  title: "Boiler Repair in York | Acme Plumbing",
  h1: "Boiler repair in York",
  blocks: ["Our York team handles boiler repair across the city."],
};

const build = (
  specs: Spec[] | null,
  facts: Fact[],
  o: { status?: "COMPLETED" | "PARTIAL" | "FAILED"; at?: Date } = {},
): KeywordMap => {
  const c = analyzeCoverage({
    websiteUrl: SITE,
    crawl: specs
      ? {
          id: "run-1",
          status: o.status ?? "COMPLETED",
          analyzedAt: o.at ?? RECENT,
          pages: specs.map(page),
        }
      : null,
    facts,
    now: NOW,
  });
  const map = buildTopicMap({
    facts,
    pages: c.pages,
    crawl: c.crawl,
    crawlId: specs ? "run-1" : null,
    now: NOW,
  });
  return buildKeywordMap({ facts, map, pages: c.pages });
};
const texts = (m: KeywordMap) => m.candidates.map((c) => c.text);
const cand = (m: KeywordMap, text: string): KeywordCandidate => {
  const c = m.candidates.find((x) => x.text === text);
  expect(c, text).toBeDefined();
  return c!;
};

describe("candidates come from approved wordings only", () => {
  test("service names, their other wordings, and service + location wordings; nothing else", () => {
    const facts = [
      fact({
        kind: "SERVICE",
        value: "Boiler repair",
        synonyms: ["Boiler servicing"],
      }),
      fact({ kind: "LOCATION", value: "York" }),
      fact({ kind: "LOCATION", value: "Leeds", synonyms: ["Headingley"] }),
      fact({ kind: "AUDIENCE", value: "Landlords" }),
    ];
    const m = build([HOME, BOILER], facts);
    expect(texts(m)).toEqual([
      "Boiler repair",
      "Boiler servicing",
      "Boiler repair Leeds",
      "Boiler repair Headingley",
      "Boiler servicing Leeds",
      "Boiler servicing Headingley",
      "Boiler repair York",
      "Boiler servicing York",
    ]);
    // Audiences are not part of any candidate, and nothing is measured.
    for (const c of m.candidates) {
      expect(c.text).not.toMatch(/Landlords|near me|best|cheap/i);
      expect(c.measured).toBe(false);
      expect(Object.keys(c).sort()).toEqual([
        "from",
        "key",
        "kind",
        "mapping",
        "measured",
        "text",
        "topicKey",
        "topicLabel",
      ]);
    }
  });

  test("pending, rejected, inferred and 'not offered' facts add no candidates", () => {
    const m = build(
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
        fact({ kind: "SERVICE", value: "Drain unblocking" }),
        fact({ kind: "EXCLUDED", value: "Drain unblocking" }),
        fact({ kind: "LOCATION", value: "York", status: "PENDING" }),
      ],
    );
    expect(texts(m)).toEqual(["Boiler repair"]);
  });

  test("an address is not combined; its shorter wordings are", () => {
    const m = build(
      [HOME],
      [
        fact({ kind: "SERVICE", value: "Cottages" }),
        fact({
          kind: "LOCATION",
          value: "Katagla Village, Manikaran Road, Kasol, Himachal Pradesh",
          synonyms: ["Kasol"],
        }),
        fact({ kind: "LOCATION", value: "Manali" }),
      ],
    );
    expect(texts(m)).toEqual(["Cottages", "Cottages Kasol", "Cottages Manali"]);
    expect(m.addresses).toEqual([
      "Katagla Village, Manikaran Road, Kasol, Himachal Pradesh",
    ]);
  });

  test("provenance: each wording names its approved fact, source and approval time", () => {
    const facts = [
      fact({
        kind: "SERVICE",
        value: "Boiler repair",
        synonyms: ["Boiler servicing"],
        source: "TEAM",
      }),
      fact({ kind: "LOCATION", value: "York" }),
      fact({ kind: "LOCATION", value: "Leeds" }),
    ];
    const m = build([HOME, BOILER], facts);
    expect(cand(m, "Boiler servicing York").from).toEqual([
      {
        factId: facts[0].id,
        kind: "SERVICE",
        wording: "Boiler servicing",
        isName: false,
        source: "TEAM",
        approvedAt: APPROVED,
      },
      {
        factId: facts[1].id,
        kind: "LOCATION",
        wording: "York",
        isName: true,
        source: "CLIENT",
        approvedAt: APPROVED,
      },
    ]);
    expect(m.crawl).toMatchObject({
      id: "run-1",
      analyzedAt: RECENT,
      freshness: { state: "fresh" },
    });
  });
});

describe("identity, determinism and the cap", () => {
  test("the same keys and output whatever the order of facts and wordings", () => {
    const facts = [
      fact({
        kind: "SERVICE",
        value: "Boiler repair",
        synonyms: ["Boilers", "Boiler servicing"],
      }),
      fact({ kind: "SERVICE", value: "Drain unblocking" }),
      fact({ kind: "LOCATION", value: "York", synonyms: ["Acomb"] }),
      fact({ kind: "LOCATION", value: "Leeds" }),
    ];
    const reordered = [...facts].reverse().map((f) => ({
      ...f,
      synonyms: [...f.synonyms].reverse(),
    }));
    const a = build([HOME, BOILER], facts);
    expect(build([BOILER, HOME], reordered)).toEqual(a);
    expect(cand(a, "Boiler repair York").key).toBe("kw:boiler repair york");
    expect(new Set(a.candidates.map((c) => c.key)).size).toBe(
      a.candidates.length,
    );
  });

  test(`at most ${MAX_CANDIDATES} candidates: services first`, () => {
    const facts = [
      ...Array.from({ length: 10 }, (_, i) =>
        fact({
          kind: "SERVICE",
          value: `Service ${String(i).padStart(2, "0")}`,
          synonyms: [`Work ${i}`],
        }),
      ),
      ...["Leeds", "York", "Hull", "Bradford"].map((v) =>
        fact({ kind: "LOCATION", value: v }),
      ),
    ];
    const m = build([HOME], facts);
    // 10 services × 2 wordings = 20; topics are capped at 50 (10 + 40).
    expect(m.candidates).toHaveLength(MAX_CANDIDATES);
    expect(m.candidates.slice(0, 20).every((c) => c.kind === "service")).toBe(
      true,
    );
    expect(m.omitted).toBe(20 + 40 * 2 - MAX_CANDIDATES);
    expect(build([HOME], [...facts].reverse())).toEqual(m);
  });
});

describe("conservative mapping", () => {
  const facts = () => [
    fact({
      kind: "SERVICE",
      value: "Boiler repair",
      synonyms: ["Boiler servicing"],
    }),
    fact({ kind: "SERVICE", value: "Drain unblocking" }),
  ];

  test("mapped only to the page that covers the topic, with where and whether the wording is on it", () => {
    const m = build([HOME, BOILER], facts());
    expect(cand(m, "Boiler repair").mapping).toMatchObject({
      state: "mapped",
      page: `${SITE}boiler-repair`,
      wordingOnPage: true,
    });
    expect(cand(m, "Boiler repair").mapping.where).toEqual(
      expect.arrayContaining(["title", "main heading"]),
    );
    // The topic's page serves the synonym too, but does not use it.
    expect(cand(m, "Boiler servicing").mapping).toMatchObject({
      state: "mapped",
      page: `${SITE}boiler-repair`,
      wordingOnPage: false,
    });
    expect(cand(m, "Drain unblocking").mapping).toMatchObject({
      state: "unmapped",
      page: null,
    });
  });

  test.each([
    [
      "a mention in the main content only",
      {
        ...HOME,
        path: "/about",
        title: "About | Acme Plumbing",
        h1: "About us",
        blocks: ["We also do boiler repair."],
      },
    ],
    ["a thin page about it", { ...BOILER, words: 60 }],
    ["a noindex page about it", { ...BOILER, robots: "noindex" }],
  ])("weak, not mapped: %s", (_label, spec) => {
    const c = cand(build([HOME, spec], facts()), "Boiler repair");
    expect(c.mapping.state).toBe("weak");
    expect(c.mapping.page).toBeNull();
    expect(c.mapping.mentions).toEqual([
      spec.path === "/" ? SITE : new URL(spec.path, SITE).href,
    ]);
  });

  const stale = new Date(
    NOW.getTime() - (EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO + 1) * DAY,
  );
  test.each([
    ["partial", [HOME, BOILER], { status: "PARTIAL" as const }],
    ["failed", [HOME, BOILER], { status: "FAILED" as const }],
    [
      "page-limited",
      [
        HOME,
        BOILER,
        { ...HOME, path: "/more", skip: "BUDGET_EXCEEDED" as const },
      ],
      {},
    ],
    ["stale", [HOME, BOILER], { at: stale }],
    [
      "dated in the future",
      [HOME, BOILER],
      { at: new Date(NOW.getTime() + 2 * DAY) },
    ],
  ])("%s crawl: never unmapped", (_label, specs, o) => {
    const m = build(specs, facts(), o);
    expect(cand(m, "Drain unblocking").mapping.state).toBe("not-checked");
    expect(m.candidates.some((c) => c.mapping.state === "unmapped")).toBe(
      false,
    );
  });

  test("reasons never quote an address, and say why a gap cannot be confirmed", () => {
    const fs = [
      fact({ kind: "SERVICE", value: "Drain unblocking" }),
      fact({ kind: "LOCATION", value: "York" }),
      fact({
        kind: "LOCATION",
        value: "Unit 4, Station Road Estate, Leeds",
        synonyms: ["Leeds"],
      }),
    ];
    expect(
      cand(build([HOME], fs), "Drain unblocking Leeds").mapping.reason,
    ).toBe(
      "No page names this service together with this location, on a complete, recent crawl.",
    );
    const partial = cand(
      build([HOME], fs, { status: "PARTIAL" }),
      "Drain unblocking Leeds",
    );
    expect(partial.mapping.reason).toMatch(
      /^No page found that names this service together with this location, but this crawl cannot confirm a gap: The latest crawl is partial/,
    );
    expect(partial.mapping.reason).not.toMatch(/Station Road/);
  });

  test("no crawl: every candidate is not checked", () => {
    const m = build(null, facts());
    expect(m.crawl).toBeNull();
    expect(new Set(m.candidates.map((c) => c.mapping.state))).toEqual(
      new Set(["not-checked"]),
    );
    expect(m.overlaps).toEqual([]);
  });
});

describe("possible overlap", () => {
  const facts = () => [
    fact({ kind: "SERVICE", value: "Boiler repair" }),
    fact({ kind: "LOCATION", value: "York" }),
    fact({ kind: "LOCATION", value: "Leeds" }),
  ];
  const SECOND: Spec = {
    path: "/services/boilers",
    title: "Boiler Repair Experts | Acme Plumbing",
    h1: "Boiler repair",
    blocks: ["Fast boiler repair from Gas Safe engineers."],
  };

  test("two pages each about the same candidate", () => {
    const m = build([HOME, BOILER, SECOND], facts());
    expect(m.overlaps).toEqual([
      {
        topicKey: "service:boiler repair",
        candidates: ["Boiler repair"],
        pages: [
          {
            url: `${SITE}boiler-repair`,
            where: expect.arrayContaining(["title", "main heading"]),
          },
          {
            url: `${SITE}services/boilers`,
            where: expect.arrayContaining(["title", "main heading"]),
          },
        ],
        reason: expect.stringMatching(/not measured/),
      },
    ]);
  });

  test("a service page and its location page are not an overlap", () => {
    expect(build([HOME, BOILER, YORK_BOILER], facts()).overlaps).toEqual([]);
  });

  test("two pages about the same service and location are", () => {
    const again = {
      ...YORK_BOILER,
      path: "/york/boilers",
      title: "York Boiler Repair | Acme Plumbing",
      blocks: ["Boiler repair in York from engineers who live locally."],
    };
    const m = build([HOME, BOILER, YORK_BOILER, again], facts());
    expect(
      m.overlaps.map((o) => [o.candidates, o.pages.map((p) => p.url)]),
    ).toEqual([
      [
        ["Boiler repair York"],
        [`${SITE}boiler-repair-york`, `${SITE}york/boilers`],
      ],
    ]);
  });

  test.each([
    [
      "the home page",
      {
        ...HOME,
        title: "Boiler Repair Specialists | Acme Plumbing",
        h1: "Boiler repair",
        blocks: ["Boiler repair is what we do."],
      },
    ],
    [
      "a page canonicalised to the other",
      { ...SECOND, canonical: "/boiler-repair" },
    ],
    ["a noindex page", { ...SECOND, robots: "noindex" }],
    ["a thin page", { ...SECOND, words: 60 }],
    [
      "a page that only mentions it in a subheading",
      {
        ...SECOND,
        title: "Heating | Acme Plumbing",
        h1: "Heating",
        h2: ["Boiler repair"],
      },
    ],
  ])("not an overlap: %s", (_label, other) => {
    const pages = other.path === "/" ? [other, BOILER] : [HOME, BOILER, other];
    expect(build(pages, facts()).overlaps).toEqual([]);
  });
});
