import { describe, expect, test } from "vitest";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { analyzeContent, CONTENT_GAP_RULE } from "@/lib/seo/content";
import { analyzeCoverage } from "./coverage";
import type { Fact } from "./facts";
import { buildTopicMap } from "./topics";

/**
 * Business coverage uses the same noindex test as the SEO rules: the robots
 * meta tag or an X-Robots-Tag header recorded with the page. A page that is
 * noindex only in its header is as weak as one with a meta noindex in
 * coverage, topics, opportunities and content gaps.
 */

const SITE = "https://plumber.example/";
const NOW = new Date("2026-11-15T12:00:00Z");
const RECENT = new Date(NOW.getTime() - 60_000);

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
  title: string;
  h1: string;
  block: string;
  robots?: string;
  /** X-Robots-Tag lines; null: the crawl recorded no headers (older crawl). */
  header?: string[] | null;
};
const page = (p: Spec): EvidencePage => ({
  url: new URL(p.path, SITE).href,
  status: "CRAWLED",
  httpStatus: 200,
  resourceType: "HTML",
  finalUrl: null,
  canonicalUrl: null,
  robotsMetaRaw: p.robots ?? null,
  depth: 1,
  skipReason: null,
  title: p.title,
  metaDescription: null,
  wordCount: 400,
  result: {
    headings: { h1: [p.h1], h2: [], h3: [] },
    links: [],
    structuredData: [],
    content: {
      v: 1,
      source: "main",
      words: 400,
      blocks: [{ t: p.block, w: p.block.split(" ").length }],
    },
    contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
    ...(p.header === null
      ? {}
      : { responseHeaders: { xRobotsTag: p.header ?? [] } }),
  },
});

const HOME: Spec = {
  path: "/",
  title: "Plumbers | Acme Plumbing",
  h1: "Local plumbers",
  block: "A family firm of plumbers.",
};
const BOILER: Spec = {
  path: "/boiler-repair",
  title: "Boiler Repair | Acme Plumbing",
  h1: "Boiler repair",
  block: "Our engineers handle boiler repair for every make and model.",
};
const LEEDS: Spec = {
  path: "/leeds",
  title: "Plumbers in Leeds | Acme Plumbing",
  h1: "Leeds",
  block: "Our Leeds team is based near the station.",
};
const YORK: Spec = {
  path: "/york",
  title: "Plumbers in York | Acme Plumbing",
  h1: "York",
  block: "Our York team covers the city centre.",
};
const facts = () => [
  fact({ kind: "SERVICE", value: "Boiler repair" }),
  fact({ kind: "LOCATION", value: "Leeds" }),
  fact({ kind: "LOCATION", value: "York" }),
];

function analyse(boiler: Partial<Spec>) {
  const fs = facts();
  const coverage = analyzeCoverage({
    websiteUrl: SITE,
    crawl: {
      id: "run-1",
      status: "COMPLETED",
      analyzedAt: RECENT,
      pages: [HOME, { ...BOILER, ...boiler }, LEEDS, YORK].map(page),
    },
    facts: fs,
    now: NOW,
  });
  const map = buildTopicMap({
    facts: fs,
    pages: coverage.pages,
    crawl: coverage.crawl,
    crawlId: "run-1",
    now: NOW,
  });
  return { coverage, map, content: analyzeContent({ coverage, map }) };
}

const CASES: Array<[string, Partial<Spec>, boolean]> = [
  ["indexable", {}, false],
  ["meta noindex only", { robots: "noindex, follow" }, true],
  ["X-Robots-Tag noindex only", { header: ["noindex"] }, true],
  ["Googlebot X-Robots-Tag none only", { header: ["googlebot: none"] }, true],
  ["both", { robots: "noindex", header: ["noindex"] }, true],
  [
    "another crawler's header directive",
    { header: ["otherbot: noindex"] },
    false,
  ],
  ["no header evidence (older crawl), meta indexable", { header: null }, false],
  [
    "no header evidence (older crawl), meta noindex",
    { header: null, robots: "noindex" },
    true,
  ],
];

describe("business coverage applies the shared noindex test", () => {
  test.each(CASES)("%s", (_label, spec, noindex) => {
    const { coverage, map, content } = analyse(spec);
    const boiler = coverage.pages.find((p) =>
      p.url.endsWith("/boiler-repair"),
    )!;
    // Coverage: the page's understood state.
    expect(boiler.noindex).toBe(noindex);

    // Topic coverage: a noindex service page covers the topic only partly.
    const topic = map.topics.find((t) => t.label === "Boiler repair")!;
    expect(topic.state).toBe(noindex ? "partial" : "covered");
    if (noindex) expect(topic.evidence[0].verdict).toMatch(/not to index it/);

    // Opportunities: the service page is weak (improve it), not fulfilled.
    const opportunity = coverage.opportunities.find((o) =>
      o.key.endsWith("(BIZ_SERVICE_PAGE)"),
    )!;
    expect(opportunity.state).toBe(noindex ? "weak" : "fulfilled");

    // Content gaps: only concluded once the service itself is covered by an
    // indexable page.
    const gaps = content.drafts.filter((d) => d.ruleId === CONTENT_GAP_RULE);
    expect(gaps).toHaveLength(noindex ? 0 : 2);
  });
});
