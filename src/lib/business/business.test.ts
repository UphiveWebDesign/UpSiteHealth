import { describe, expect, test } from "vitest";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { BENEFIT } from "@/lib/recommendations/benefits";
import {
  buildRecommendations,
  heldReason,
  matchDraft,
  recommendationBasis,
} from "@/lib/recommendations/generate";
import { buildPlan, type PlanInput } from "@/lib/workflow/plan";
import {
  analyzeCoverage,
  coverageDrafts,
  coverageMeta,
  matchPage,
  NEED_TEXT,
  relevantFacts,
  type CoverageResult,
} from "./coverage";
import { factInput, normalizeFactValue, type Fact } from "./facts";
import { classify, containsPhrase, readPages, words } from "./pages";
import { recommendationVisibility } from "./visibility";

const SITE = "https://plumb.example/";
const NOW = new Date("2026-10-22T12:00:00Z");
const RECENT = new Date("2026-10-20T12:00:00Z");

let n = 0;
const fact = (o: Partial<Fact> & Pick<Fact, "kind" | "value">): Fact => ({
  id: `f${n++}`,
  synonyms: [],
  source: "CLIENT",
  status: "APPROVED",
  ...o,
});

type PageSpec = {
  path: string;
  title?: string;
  h1?: string[];
  h2?: string[];
  meta?: string;
  links?: Array<{ to: string; text: string }>;
  schema?: unknown[];
  robots?: string;
  canonical?: string;
  httpStatus?: number;
  skip?: EvidencePage["skipReason"];
  /** Defaults to a substantial page; set low to test thin pages. */
  wordCount?: number | null;
  /** A page stored before main-content and contact detection. */
  legacy?: boolean;
};
const page = (p: PageSpec): EvidencePage => ({
  url: new URL(p.path, SITE).href,
  status: p.skip ? "SKIPPED" : "CRAWLED",
  httpStatus: p.skip ? null : (p.httpStatus ?? 200),
  resourceType: "HTML",
  finalUrl: null,
  canonicalUrl: p.canonical ?? null,
  robotsMetaRaw: p.robots ?? null,
  depth: 1,
  skipReason: p.skip ?? null,
  title: p.title ?? null,
  wordCount: p.wordCount === undefined ? 400 : p.wordCount,
  metaDescription: p.meta ?? null,
  result:
    p.skip || (p.httpStatus ?? 200) >= 400
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
          // The main content and contact evidence a current crawl stores.
          ...(p.legacy
            ? {}
            : {
                content: {
                  v: 1,
                  source: "main",
                  words: p.wordCount === undefined ? 400 : (p.wordCount ?? 0),
                  // Headings, then a body sentence about the page's topic.
                  blocks: [
                    {
                      t: [p.title, ...(p.h1 ?? []), ...(p.h2 ?? [])]
                        .filter(Boolean)
                        .join(". "),
                      w: 10,
                    },
                    ...(p.title
                      ? [{ t: `More about ${p.title} here.`, w: 5 }]
                      : []),
                  ],
                },
                contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
              }),
        },
});
const crawl = (
  pages: PageSpec[],
  o: { status?: "COMPLETED" | "PARTIAL"; at?: Date } = {},
) => ({
  status: o.status ?? ("COMPLETED" as const),
  analyzedAt: o.at ?? RECENT,
  pages: pages.map(page),
});
const cover = (pages: PageSpec[], facts: Fact[], o = {}) =>
  analyzeCoverage({
    websiteUrl: SITE,
    crawl: crawl(pages, o),
    facts,
    now: NOW,
  });
const HOME: PageSpec = {
  path: "/",
  title: "Plumb & Co",
  h1: ["Plumbers you can trust"],
};
const CONTACT: PageSpec = {
  path: "/contact",
  title: "Contact us",
  h1: ["Contact"],
};

describe("facts", () => {
  test("one fact per kind and wording; only people's sources; fixed lists checked", () => {
    expect(normalizeFactValue("  Boiler   Repair ")).toBe("boiler repair");
    const ok = (o: object) =>
      factInput.safeParse({
        kind: "SERVICE",
        value: "x",
        synonyms: [],
        source: "TEAM",
        approve: false,
        ...o,
      }).success;
    expect(ok({})).toBe(true);
    expect(ok({ source: "INFERENCE" })).toBe(false);
    expect(ok({ source: "IMPORT" })).toBe(false);
    expect(ok({ value: "  " })).toBe(false);
    expect(ok({ kind: "BUSINESS_TYPE", value: "multi-location" })).toBe(true);
    expect(ok({ kind: "BUSINESS_TYPE", value: "space agency" })).toBe(false);
    expect(ok({ kind: "GOAL", value: "calls" })).toBe(true);
    expect(ok({ kind: "GOAL", value: "fame" })).toBe(false);
    expect(ok({ kind: "AUDIENCE", value: "Landlords", synonyms: ["x"] })).toBe(
      false,
    );
  });
});

describe("text matching", () => {
  test("accents, case, plurals and stop words; phrases stay in order", () => {
    expect(words("Café Repairs & the Boilers")).toEqual([
      "cafe",
      "repair",
      "boiler",
    ]);
    expect(
      containsPhrase(
        words("Emergency boiler repairs in Leeds"),
        words("boiler repair"),
      ),
    ).toBe(true);
    expect(
      containsPhrase(words("Repair your boiler"), words("boiler repair")),
    ).toBe(false);
  });
});

describe("page classification", () => {
  const base = {
    title: null,
    h1: [],
    schemaTypes: [] as string[],
    isHome: false,
  };
  const none = { service: false, location: false };
  test("home, and clear signals with their confidence", () => {
    expect(classify({ ...base, path: "/", isHome: true }, none).type).toBe(
      "home",
    );
    expect(classify({ ...base, path: "/contact" }, none)).toMatchObject({
      type: "contact",
      confidence: "medium",
    });
    const c = classify(
      {
        ...base,
        path: "/contact",
        title: "Contact us",
        schemaTypes: ["ContactPage"],
      },
      none,
    );
    expect(c).toMatchObject({ type: "contact", confidence: "high" });
    expect(c.signals.join(" ")).toMatch(/Structured data says ContactPage/);
    expect(
      classify(
        { ...base, path: "/blog/tips", schemaTypes: ["BlogPosting"] },
        none,
      ).type,
    ).toBe("article");
    expect(
      classify(
        { ...base, path: "/services/boilers" },
        { service: true, location: false },
      ),
    ).toMatchObject({
      type: "service",
      confidence: "high",
    });
  });
  test("weak or conflicting signals stay unknown, never forced", () => {
    const index = classify({ ...base, path: "/services" }, none);
    expect(index).toMatchObject({ type: "unknown", candidate: "service" });
    expect(
      classify({ ...base, path: "/x", title: "About us" }, none).type,
    ).toBe("unknown");
    const tie = classify({ ...base, path: "/blog/contact" }, none);
    expect(tie).toMatchObject({ type: "unknown", candidate: null });
    expect(classify({ ...base, path: "/random-page" }, none).signals).toEqual([
      "No clear signal",
    ]);
  });
});

describe("page classification: generic plugin markup against legal evidence", () => {
  const none = { service: false, location: false };
  const page = (over: {
    path: string;
    title?: string | null;
    h1?: string[];
    schemaTypes?: string[];
  }) =>
    classify(
      { title: null, h1: [], schemaTypes: [], isHome: false, ...over },
      none,
    );

  test("a privacy policy with SEO-plugin Article markup is legal (Moh Maya)", () => {
    const c = page({
      path: "/privacy-policy/",
      title: "Privacy Policy - MOH MAYA COTTAGES & CAFE",
      h1: ["Privacy Policy"],
      schemaTypes: ["Article", "ImageObject", "Person", "WebPage", "WebSite"],
    });
    expect(c.type).toBe("legal");
    expect(c.signals.join(" ")).toMatch(/generic markup/);
    // WooCommerce's default refund page is legal too.
    expect(
      page({
        path: "/refund_returns/",
        title: "Refund and Returns Policy",
        schemaTypes: ["Article"],
      }).type,
    ).toBe("legal");
  });

  test("Article markup keeps its weight without both legal signals", () => {
    // A post about privacy: legal wording in the title only.
    expect(
      page({
        path: "/blog/our-privacy-policy-explained/",
        title: "Our privacy policy, explained",
        schemaTypes: ["Article"],
      }).type,
    ).toBe("article");
    // A legal-looking URL with a different title: markup still counts fully.
    expect(
      page({
        path: "/terms/",
        title: "Seasonal stay terms for groups",
        schemaTypes: ["Article"],
      }).type,
    ).toBe("article");
    // Explicit BlogPosting markup is never discounted.
    expect(
      page({
        path: "/hello-world/",
        title: "Hello world!",
        schemaTypes: ["BlogPosting"],
      }).type,
    ).toBe("article");
  });
});

describe("legal pages never satisfy business coverage", () => {
  // Terms whose title names the service, with plugin Article markup.
  const TERMS: PageSpec = {
    path: "/terms-and-conditions/",
    title: "Terms and Conditions for Boiler repair",
    h1: ["Terms and Conditions"],
    schema: [{ "@type": "Article", name: "Terms and Conditions" }],
    wordCount: 1200,
  };
  const svc = fact({ kind: "SERVICE", value: "Boiler repair" });

  test("a terms page naming the service is classified legal and is not the service page", () => {
    const c = cover([HOME, CONTACT, TERMS], [svc]);
    const termsUrl = new URL(TERMS.path, SITE).href;
    expect(c.pages.find((p) => p.url === termsUrl)?.type).toBe("legal");
    const need = c.needs.find((n) => n.kind === "service-page")!;
    expect(need.status).not.toBe("covered");
    expect(need.matches.find((m) => m.url === termsUrl)).toMatchObject({
      strength: "medium",
      note: "A legal page names it.",
    });
    const o = c.opportunities.find((x) =>
      x.key.endsWith("(BIZ_SERVICE_PAGE)"),
    )!;
    expect(o.state).not.toBe("fulfilled");
    expect(o.considered.find((p) => p.url === termsUrl)?.verdict).toBe(
      "Legal page: not considered.",
    );
  });
});

describe("matching a fact to a page", () => {
  const svc = fact({
    kind: "SERVICE",
    value: "Boiler repair",
    synonyms: ["boiler fixes"],
  });
  const one = (p: PageSpec, inbound: PageSpec[] = []) => {
    const [read] = readPages([page(p), ...inbound.map(page)], SITE);
    return matchPage(
      { ...read, ...classify(read, { service: false, location: false }) },
      svc,
    );
  };
  test("strength follows where it is named", () => {
    expect(one({ path: "/a", title: "Boiler repair in Leeds" })?.strength).toBe(
      "strong",
    );
    expect(one({ path: "/a", h1: ["Boiler fixes"] })?.strength).toBe("strong");
    expect(one({ path: "/a", h2: ["Boiler repair"] })?.strength).toBe("medium");
    expect(one({ path: "/a", title: "Repair for your boiler" })?.strength).toBe(
      "medium",
    );
    expect(one({ path: "/a", meta: "We do boiler repair" })?.strength).toBe(
      "weak",
    );
    expect(one({ path: "/boiler-repair" })?.strength).toBe("weak"); // URL alone
    expect(one({ path: "/a", title: "Other" })).toBeNull();
  });
  test("link text from other pages counts; noindex and canonicalised pages count less", () => {
    const linker = { path: "/", links: [{ to: "/a", text: "Boiler repair" }] };
    const [target] = readPages(
      [page({ path: "/a" }), page(linker), page({ ...linker, path: "/b" })],
      SITE,
    );
    expect(target.inbound).toEqual(["Boiler repair", "Boiler repair"]);
    const m = one({ path: "/a", title: "Boiler repair", robots: "noindex" });
    expect(m).toMatchObject({ strength: "medium" });
    expect(m?.note).toMatch(/not to index/);
    expect(
      one({
        path: "/a",
        title: "Boiler repair",
        canonical: "https://plumb.example/other",
      })?.strength,
    ).toBe("medium");
  });
});

describe("coverage", () => {
  const svc = fact({ kind: "SERVICE", value: "Boiler repair" });
  const svc2 = fact({ kind: "SERVICE", value: "Bathroom fitting" });

  test("only approved facts are used; pending, rejected and inferred ones never", () => {
    const facts = [
      fact({ kind: "SERVICE", value: "A", status: "PENDING" }),
      fact({ kind: "SERVICE", value: "B", status: "REJECTED" }),
      fact({
        kind: "SERVICE",
        value: "C",
        status: "PENDING",
        source: "INFERENCE",
      }),
    ];
    const c = cover([HOME], facts);
    expect(c.needs).toEqual([]);
    expect(c.pendingFacts).toBe(2);
    expect(coverageDrafts(c)).toEqual([]);
  });

  test("a missing service page is recommended only on complete, recent evidence", () => {
    const missing = cover([HOME, CONTACT], [svc, svc2]);
    expect(missing.needs.map((x) => [x.status, x.recommend])).toEqual([
      ["missing", true],
      ["missing", true],
    ]);
    expect(coverageDrafts(missing)[0].title).toBe(
      "Add a page for “Boiler repair” (BIZ_SERVICE_PAGE)",
    );
    for (const c of [
      cover([HOME], [svc], { status: "PARTIAL" }),
      cover([HOME, { path: "/deep", skip: "BUDGET_EXCEEDED" }], [svc]),
      cover([HOME, { path: "/deep", skip: "DEPTH_EXCEEDED" }], [svc]),
      cover([HOME], [svc], { at: new Date("2026-07-01T00:00:00Z") }),
    ]) {
      expect(c.needs[0]).toMatchObject({
        status: "not-confirmed",
        recommend: false,
      });
      expect(c.crawl?.gap).toBeTruthy();
      expect(coverageDrafts(c)).toEqual([]);
    }
    // Robots-blocked pages do not make the inventory incomplete.
    expect(
      cover([HOME, { path: "/x", skip: "ROBOTS_DISALLOWED" }], [svc]).needs[0]
        .status,
    ).toBe("missing");
  });

  test("covered, several pages, and weak mentions", () => {
    const covered = cover(
      [HOME, { path: "/boilers", title: "Boiler repair" }],
      [svc],
    );
    expect(covered.needs[0]).toMatchObject({
      status: "covered",
      recommend: false,
    });
    const two = cover(
      [
        HOME,
        { path: "/a", title: "Boiler repair" },
        { path: "/b", h1: ["Boiler repair"] },
      ],
      [svc],
    );
    expect(two.needs[0].status).toBe("ambiguous");
    expect(two.reviews[0].title).toMatch(/Several pages/);
    const weak = cover([HOME, { path: "/a", h2: ["Boiler repair"] }], [svc]);
    expect(weak.needs[0]).toMatchObject({ status: "weak", recommend: false });
    // The home page of a multi-service business mentions, it does not cover.
    const home = cover(
      [{ ...HOME, title: "Boiler repair and bathroom fitting" }],
      [svc, svc2],
    );
    expect(home.needs[0].status).toBe("weak");
    // ... but for a single-service business the home page is the service page.
    expect(
      cover([{ ...HOME, title: "Boiler repair Leeds" }], [svc]).needs[0].status,
    ).toBe("covered");
    // A blog post about it is not a service page.
    const blog = cover(
      [
        HOME,
        {
          path: "/blog/boiler-repair-tips",
          title: "Boiler repair tips",
          schema: [{ "@type": "BlogPosting" }],
        },
      ],
      [svc],
    );
    expect(blog.needs[0].status).toBe("weak");
  });

  test("a broken page for the service points at the error, not a new page", () => {
    const c = cover([HOME, { path: "/boiler-repair", httpStatus: 404 }], [svc]);
    expect(c.needs[0]).toMatchObject({ status: "weak", recommend: false });
    expect(c.needs[0].note).toMatch(/returns HTTP 404/);
  });

  test("locations: named anywhere for one location; own pages only with several", () => {
    const leeds = fact({ kind: "LOCATION", value: "Leeds" });
    const york = fact({ kind: "LOCATION", value: "York" });
    const contact = {
      ...CONTACT,
      schema: [{ "@type": "Plumber", address: { addressLocality: "Leeds" } }],
    };
    const single = cover([HOME, contact], [leeds]);
    expect(single.needs[0]).toMatchObject({
      kind: "location-mention",
      status: "covered",
    });
    expect(cover([HOME], [leeds]).needs[0]).toMatchObject({
      status: "missing",
      recommend: true,
    });

    const multi = cover(
      [
        { ...HOME, h2: ["Leeds", "York"] },
        { path: "/york", title: "Plumbers in York" },
      ],
      [leeds, york],
    );
    expect(multi.needs.map((x) => [x.key, x.status, x.recommend])).toEqual([
      ["Add a page for the Leeds location (BIZ_LOCATION_PAGE)", "weak", true],
      [
        "Add a page for the York location (BIZ_LOCATION_PAGE)",
        "covered",
        false,
      ],
    ]);
    // The contact page's address and a service page naming the town are
    // mentions, not pages about the location.
    const mentions = cover(
      [
        { ...HOME, title: "Plumbers in Leeds" },
        contact,
        { path: "/services/boilers", title: "Boiler repair in Leeds" },
        { path: "/york", title: "Plumbers in York" },
      ],
      [leeds, york, fact({ kind: "SERVICE", value: "Boiler repair" })],
    );
    expect(
      mentions.needs.find((x) => x.facts[0].value === "Leeds"),
    ).toMatchObject({ status: "weak", recommend: true });
    expect(mentions.reviews).toEqual([]);
    // An approved multi-location type expects a page even for one location.
    const typed = cover(
      [{ ...HOME, h2: ["Leeds"] }],
      [leeds, fact({ kind: "BUSINESS_TYPE", value: "multi-location" })],
    );
    expect(typed.needs[0].kind).toBe("location-page");
  });

  test("service areas are one grouped task, never a page per area", () => {
    const areas = ["Otley", "Ilkley", "Wetherby"].map((value) =>
      fact({ kind: "SERVICE_AREA", value }),
    );
    const c = cover(
      [{ ...HOME, meta: "Plumbers serving Otley and nearby" }],
      areas,
    );
    expect(c.needs).toHaveLength(1);
    expect(c.needs[0]).toMatchObject({
      kind: "service-areas",
      status: "missing",
      recommend: true,
    });
    expect(c.needs[0].facts.map((f) => f.value)).toEqual([
      "Ilkley",
      "Wetherby",
    ]);
    expect(NEED_TEXT["service-areas"].priority).toBe("LOW");
  });

  test("contact goals need a contact page or a contact link", () => {
    const goal = fact({ kind: "GOAL", value: "calls" });
    expect(cover([HOME], [goal]).needs[0]).toMatchObject({
      kind: "contact-path",
      status: "missing",
      recommend: true,
    });
    expect(cover([HOME, CONTACT], [goal]).needs[0].status).toBe("covered");
    const linked = cover(
      [
        { ...HOME, links: [{ to: "/talk", text: "Get in touch" }] },
        { path: "/talk" },
      ],
      [goal],
    );
    expect(linked.needs[0].status).toBe("covered");
    // Sales or visits alone do not ask for a contact page.
    expect(
      cover([HOME], [fact({ kind: "GOAL", value: "sales" })]).needs,
    ).toEqual([]);
  });

  test("pages promoting something marked as not offered are flagged for review only", () => {
    const c = cover(
      [HOME, { path: "/gas", title: "Gas fitting" }],
      [fact({ kind: "EXCLUDED", value: "Gas fitting" })],
    );
    expect(c.needs).toEqual([]);
    expect(c.reviews[0].title).toMatch(/marked as not offered/);
  });

  test("no crawl: nothing is checked or recommended", () => {
    const c = analyzeCoverage({
      websiteUrl: SITE,
      crawl: null,
      facts: [svc],
      now: NOW,
    });
    expect(c.needs[0]).toMatchObject({
      status: "not-checked",
      recommend: false,
    });
  });
});

describe("coverage in recommendations and the plan", () => {
  const svc = fact({ kind: "SERVICE", value: "Boiler repair" });
  const title = "Add a page for “Boiler repair” (BIZ_SERVICE_PAGE)";
  const missing = cover([HOME, CONTACT], [svc]);
  const covered = cover(
    [HOME, { path: "/boilers", title: "Boiler repair" }],
    [svc],
  );
  const notConfirmed = cover([HOME], [svc], { status: "PARTIAL" });
  const none = {
    openIssues: [],
    findingGroups: [],
    performance: null,
    aiSearch: null,
  };
  const held = (coverage: CoverageResult | null | undefined) =>
    heldReason(
      { title, issueId: null },
      { issues: new Map(), remainingRules: new Map(), coverage },
    );

  test("identity: title with a BIZ_ code, its own basis, matched by title", () => {
    const [d] = buildRecommendations({ ...none, coverage: missing });
    expect(d).toMatchObject({ title, priority: "MEDIUM", issueId: null });
    expect(recommendationBasis(d)).toEqual({
      kind: "coverage",
      code: "BIZ_SERVICE_PAGE",
    });
    expect(matchDraft({ title, issueId: null }, [d])).toBe(d);
    expect(buildRecommendations({ ...none, coverage: notConfirmed })).toEqual(
      [],
    );
  });

  test("completed only when a crawl shows the need met; facts gone means it no longer applies", () => {
    expect(held(covered)).toBeNull();
    expect(held(notConfirmed)).toBe("unverified");
    expect(
      held(cover([HOME, { path: "/a", h2: ["Boiler repair"] }], [svc])),
    ).toBe("unverified");
    expect(held(cover([HOME], []))).toBe("ignored");
    expect(held(null)).toBe("ignored");
    expect(held(undefined)).toBe("unverified");
  });

  test("metadata is honest about what was checked", () => {
    const m = coverageMeta(title, missing)!;
    expect(m.knowledgeVersion).toBe("o2"); // page opportunity rules
    expect(m.proposal?.slug).toBe("/boiler-repair/");
    expect(m.benefit).toBe("business-coverage");
    expect(m.limits.join(" ")).toMatch(/not necessarily indexed by Google/);
    expect(m.limits.join(" ")).toMatch(/body text is not stored/);
    expect(m.evidence[0]).toMatch(/Checked 2 analysed pages/);
    expect(coverageMeta(title, notConfirmed)!.confidence).toBe("low");
    expect(coverageMeta("Gone (BIZ_SERVICE_PAGE)", missing)).toBeNull();
  });

  test("no invented numbers or promised outcomes in coverage wording", () => {
    const texts = [
      BENEFIT["business-coverage"].text,
      ...Object.values(NEED_TEXT).flatMap((t) => [
        t.action,
        t.effortReason,
        t.confidenceReason,
        t.explanation(missing.needs[0]),
        t.verification(missing.needs[0]),
      ]),
    ].join(" ");
    expect(texts).not.toMatch(
      /%|guarantee|boost|will (rank|improve|increase)/i,
    );
    for (const s of texts.split(/(?<=\.)\s+/))
      if (/\bindexed\b/i.test(s)) expect(s).toMatch(/\bnot\b/);
  });

  test("relevance: coverage tasks and technical tasks on matched pages; nothing from unapproved facts", () => {
    expect(relevantFacts({ title }, null, missing)).toEqual([
      { label: "Boiler repair", approved: true },
    ]);
    const meta = { urls: ["https://plumb.example/boilers"] } as Parameters<
      typeof relevantFacts
    >[1];
    expect(
      relevantFacts(
        { title: "Missing H1 heading (TECH_H1_MISSING)" },
        meta,
        covered,
      ),
    ).toEqual([{ label: "Boiler repair", approved: true }]);
    const pending = cover(
      [HOME, { path: "/boilers", title: "Boiler repair" }],
      [{ ...svc, status: "PENDING" }],
    );
    expect(
      relevantFacts({ title: "x (TECH_H1_MISSING)" }, meta, pending),
    ).toEqual([]);
  });

  test("the plan ranks approved relevance within a priority, keeps blockers first", () => {
    let i = 0;
    const input = (o: Partial<PlanInput>): PlanInput => ({
      id: `r${i++}`,
      title: `T${i}`,
      status: "PROPOSED",
      priority: "MEDIUM",
      explanation: "x",
      recommendedAction: "y",
      issueId: null,
      basis: { kind: "seo-rule", ruleId: "TECH_H1_MISSING" },
      state: { kind: "active" },
      meta: null,
      ...o,
    });
    const plan = buildPlan([
      input({ title: "A technical (TECH_A)" }),
      input({
        title,
        basis: { kind: "coverage", code: "BIZ_SERVICE_PAGE" },
        facts: relevantFacts({ title }, null, missing),
      }),
      input({ title: "High (TECH_B)", priority: "HIGH" }),
      input({
        title: "Down",
        basis: { kind: "issue", issueId: "i" },
        issueId: "i",
        priority: "LOW",
      }),
    ]);
    expect(plan["fix-first"].map((x) => x.title)).toEqual(["Down"]);
    expect(plan.next.map((x) => x.title)).toEqual([
      "High (TECH_B)",
      title,
      "A technical (TECH_A)",
    ]);
    const biz = plan.next[1];
    expect(biz.ranking).toContain(
      "Affects approved business focus: Boiler repair",
    );
    expect(biz.dependsOn).toEqual(["Down"]); // coverage is crawl-based work
  });
});

describe("visibility", () => {
  test("client members never receive business tasks; the team sees everything", () => {
    expect(recommendationVisibility("CLIENT")).toEqual({
      NOT: { title: { contains: "(BIZ_" } },
    });
    for (const role of ["MEMBER", "MANAGER", "ADMIN", "OWNER"] as const)
      expect(recommendationVisibility(role)).toEqual({});
  });
});
