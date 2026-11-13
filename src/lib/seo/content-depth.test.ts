import { describe, expect, test } from "vitest";
import { analyzeCoverage } from "@/lib/business/coverage";
import type { Fact } from "@/lib/business/facts";
import { linkOpportunities } from "@/lib/business/links";
import { buildTopicMap, staleCrawlCaveat } from "@/lib/business/topics";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { describeEvidence } from "@/lib/insights/seo";
import { analyzeContent, LINK_RULE, NOT_DESCRIBED_RULE } from "./content";

/**
 * Content depth (a service page that never describes its service) and
 * internal-link opportunities (pages naming a covered service without a
 * link to its page), from realistic stored crawl pages.
 */

const SITE = "https://florist.example/";
const NOW = new Date("2026-11-12T12:00:00Z");
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
  title: string;
  h1: string;
  blocks: string[];
  /** Main-content words (default 400: above the thin limit). */
  words?: number;
  /** Internal link targets (paths). */
  links?: string[];
  linksOmitted?: number;
  finalPath?: string;
  noindex?: boolean;
  /** A redirect as stored: 3xx, the final URL, nothing parsed. */
  redirect?: boolean;
};
const url = (path: string) => new URL(path, SITE).href;
const page = (p: Spec): EvidencePage => ({
  url: url(p.path),
  status: "CRAWLED",
  httpStatus: p.redirect ? 301 : 200,
  resourceType: "HTML",
  finalUrl: p.finalPath ? url(p.finalPath) : null,
  canonicalUrl: null,
  robotsMetaRaw: p.noindex ? "noindex" : null,
  depth: 1,
  skipReason: null,
  title: p.title,
  metaDescription: null,
  wordCount: p.words ?? 400,
  result: p.redirect
    ? null
    : {
        headings: { h1: [p.h1], h2: [], h3: [] },
        links: (p.links ?? []).map((l) => ({
          url: url(l),
          anchorText: "link",
          type: "internal",
          rel: null,
          nofollow: false,
          sponsored: false,
          ugc: false,
        })),
        linksOmitted: p.linksOmitted ?? 0,
        structuredData: [],
        content: {
          v: 1,
          source: "main",
          words: p.words ?? 400,
          blocks: p.blocks.map((t) => ({ t, w: t.split(" ").length })),
        },
        contact: { tel: 0, mailto: 0, whatsapp: 0, forms: 0 },
      },
});

const HOME: Spec = {
  path: "/",
  title: "Florist | Bloom",
  h1: "Fresh flowers every day",
  blocks: ["We arrange wedding flowers and bouquets for every occasion."],
};
const WEDDING: Spec = {
  path: "/wedding-flowers",
  title: "Wedding flowers | Bloom",
  h1: "Wedding flowers",
  blocks: ["Our wedding flowers are designed with each couple."],
};
const ABOUT: Spec = {
  path: "/about",
  title: "About us | Bloom",
  h1: "About us",
  blocks: ["A family florist since 1990, known for our sympathy wreaths."],
};

const services = () => [fact({ kind: "SERVICE", value: "Wedding flowers" })];

function analyse(specs: Spec[], fs: Fact[] = services(), at?: Date) {
  const raw = specs.map(page);
  const coverage = analyzeCoverage({
    websiteUrl: SITE,
    crawl: {
      id: "run-9",
      status: "COMPLETED",
      analyzedAt: at ?? new Date(NOW.getTime() - 60_000),
      pages: raw,
    },
    facts: fs,
    now: NOW,
  });
  const map = buildTopicMap({
    facts: fs,
    pages: coverage.pages,
    crawl: coverage.crawl,
    crawlId: "run-9",
    now: NOW,
  });
  const links = linkOpportunities({ map, pages: coverage.pages, raw });
  return { map, links, content: analyzeContent({ coverage, map, links }) };
}
const rules = (a: ReturnType<typeof analyse>) =>
  a.content.drafts.map((d) => d.ruleId);

describe("service page that does not describe the service", () => {
  test("adequate coverage: the page's main content names it, nothing to do", () => {
    const a = analyse([HOME, WEDDING]);
    expect(a.map.topics[0]).toMatchObject({ state: "covered", weakPage: null });
    expect(rules(a)).not.toContain(NOT_DESCRIBED_RULE);
  });

  test("the heading names it but the main content does not: one finding with the page, words and where", () => {
    const vague = {
      ...WEDDING,
      blocks: ["Every couple is different, and so is every day we design."],
    };
    const a = analyse([HOME, vague]);
    expect(a.map.topics[0]).toMatchObject({
      state: "partial",
      weakPage: { url: url("/wedding-flowers"), kind: "not-described" },
    });
    const d = a.content.drafts.find((x) => x.ruleId === NOT_DESCRIBED_RULE)!;
    expect(d.fingerprint).toBe(
      `${NOT_DESCRIBED_RULE}::site:${a.map.topics[0].key}`,
    );
    expect(d.evidence).toMatchObject({
      url: url("/wedding-flowers"),
      mainWords: 400,
      crawlRunId: "run-9",
      wordings: ["Wedding flowers"],
    });
    expect(describeEvidence(NOT_DESCRIBED_RULE, d.evidence)).toMatch(
      /^\/wedding-flowers names it in its .+, but its main content \(400 words\) does not · crawl of /,
    );
  });

  test("a thin page is the technical rule's (TECH_THIN_CONTENT), not this one", () => {
    const thin = { ...WEDDING, blocks: ["Coming soon."], words: 20 };
    const a = analyse([HOME, thin]);
    expect(a.map.topics[0].weakPage?.kind).toBe("thin");
    expect(rules(a)).not.toContain(NOT_DESCRIBED_RULE);
  });

  test("a genuinely missing topic is a page opportunity, never a content-depth or link finding", () => {
    const a = analyse(
      [HOME, ABOUT],
      [fact({ kind: "SERVICE", value: "Funeral flowers" })],
    );
    expect(a.map.topics[0].state).toBe("none");
    expect(rules(a)).toEqual([]);
    expect(a.links).toEqual([]);
  });

  test("resolved only when a later complete crawl finds the topic covered", () => {
    const f = {
      ruleId: NOT_DESCRIBED_RULE,
      evidence: { topic: analyse([HOME, WEDDING]).map.topics[0].key },
    };
    expect(analyse([HOME, WEDDING]).content.resolves(f)).toBe(true);
    const thin = { ...WEDDING, blocks: ["Coming soon."], words: 20 };
    expect(analyse([HOME, thin]).content.resolves(f)).toBe(false);
    // A stale crawl concludes nothing.
    expect(
      analyse(
        [HOME, WEDDING],
        services(),
        new Date(NOW.getTime() - 90 * DAY),
      ).content.resolves(f),
    ).toBe(false);
  });
});

describe("internal-link opportunities", () => {
  test("a page naming the service in its main content without a link: a source with its passage", () => {
    const a = analyse([HOME, WEDDING]);
    expect(a.links).toEqual([
      expect.objectContaining({
        target: url("/wedding-flowers"),
        inboundPages: 0,
        poorlyConnected: true,
        sources: [
          {
            url: url("/"),
            passage:
              "We arrange wedding flowers and bouquets for every occasion.",
          },
        ],
        sourcesTotal: 1,
      }),
    ]);
    const d = a.content.drafts.find((x) => x.ruleId === LINK_RULE)!;
    expect(d.evidence).toMatchObject({
      target: url("/wedding-flowers"),
      url: url("/"),
      urls: [url("/")],
      count: 1,
    });
    expect(describeEvidence(LINK_RULE, d.evidence)).toMatch(
      /^1 page\(s\) name it without linking to \/wedding-flowers · crawl of /,
    );
  });

  test("no defensible opportunity: the naming page already links (directly or through a redirect)", () => {
    const linked = { ...HOME, links: ["/wedding-flowers"] };
    expect(analyse([linked, WEDDING]).links).toEqual([
      expect.objectContaining({ sources: [], inboundPages: 1 }),
    ]);
    // Linking to an old URL the crawl saw redirect to the page counts.
    const old: Spec = {
      ...WEDDING,
      path: "/weddings",
      finalPath: "/wedding-flowers",
      redirect: true,
    };
    const viaRedirect = { ...HOME, links: ["/weddings"] };
    expect(
      analyse([viaRedirect, WEDDING, old]).links.flatMap((o) => o.sources),
    ).toEqual([]);
    expect(rules(analyse([linked, WEDDING]))).not.toContain(LINK_RULE);
  });

  test("pages that do not name it, legal pages and noindex pages are never sources; a naming page is", () => {
    const legal: Spec = {
      path: "/privacy-policy",
      title: "Privacy policy | Bloom",
      h1: "Privacy policy",
      blocks: ["We process wedding flowers orders under this policy."],
    };
    const hidden: Spec = {
      ...ABOUT,
      path: "/old",
      noindex: true,
      blocks: HOME.blocks,
    };
    const a = analyse([
      { ...HOME, links: ["/wedding-flowers"] },
      WEDDING,
      ABOUT,
      legal,
      hidden,
    ]);
    expect(a.links.flatMap((o) => o.sources)).toEqual([]);
    // The same pages plus one that names it: only that one is a source.
    const blog: Spec = {
      path: "/blog/our-year",
      title: "Our year | Bloom",
      h1: "Our year",
      blocks: ["This spring we arranged wedding flowers for forty couples."],
    };
    const b = analyse([
      { ...HOME, links: ["/wedding-flowers"] },
      WEDDING,
      ABOUT,
      legal,
      hidden,
      blog,
    ]);
    expect(b.links.flatMap((o) => o.sources.map((s) => s.url))).toEqual([
      url("/blog/our-year"),
    ]);
  });

  test("a page whose link list was cut makes the crawl inconclusive: nothing is suggested", () => {
    const cut: Spec = {
      ...ABOUT,
      path: "/blog",
      blocks: HOME.blocks,
      linksOmitted: 3,
    };
    const a = analyse([{ ...HOME, links: ["/wedding-flowers"] }, WEDDING, cut]);
    expect(a.map.crawl?.gap).toMatch(/more links than the crawl follows/);
    expect(a.links).toEqual([]);
    expect(rules(a)).toEqual([]);
  });

  test("a page linked from menus everywhere is neither a source nor poorly connected", () => {
    const menu = ["/wedding-flowers", "/about"];
    const a = analyse([
      { ...HOME, links: menu },
      { ...WEDDING, links: menu },
      { ...ABOUT, links: menu },
    ]);
    expect(a.links).toEqual([]);
  });

  test("a stale or partial crawl suggests nothing, and resolves nothing", () => {
    const old = new Date(NOW.getTime() - 90 * DAY);
    const a = analyse([HOME, WEDDING], services(), old);
    expect(a.links).toEqual([]);
    expect(rules(a)).toEqual([]);
    const key = analyse([HOME, WEDDING]).map.topics[0].key;
    expect(
      a.content.resolves({ ruleId: LINK_RULE, evidence: { topic: key } }),
    ).toBe(false);
  });

  test("resolved when the page now links, not while a naming page still lacks the link", () => {
    const key = analyse([HOME, WEDDING]).map.topics[0].key;
    const f = { ruleId: LINK_RULE, evidence: { topic: key } };
    expect(analyse([HOME, WEDDING]).content.resolves(f)).toBe(false);
    expect(
      analyse([
        { ...HOME, links: ["/wedding-flowers"] },
        WEDDING,
      ]).content.resolves(f),
    ).toBe(true);
  });
});

describe("source, date and confidence wording", () => {
  test("one caveat for conclusions resting on pages of a crawl that is not fresh", () => {
    expect(staleCrawlCaveat("fresh", true)).toBeNull();
    expect(staleCrawlCaveat("stale", false)).toBeNull();
    expect(staleCrawlCaveat(null, true)).toBeNull();
    expect(staleCrawlCaveat("stale", true)).toBe(
      "From a crawl that is out of date: the page may have changed since.",
    );
    expect(staleCrawlCaveat("incomplete", true)).toMatch(/incomplete/);
    expect(staleCrawlCaveat("unknown", true)).toMatch(/of unknown age/);
  });

  test("the existing location-gap description is unchanged", () => {
    expect(
      describeEvidence("CONTENT_SERVICE_LOCATION_GAP", {
        servicePage: "https://x.example/boiler",
        locationPages: ["https://x.example/leeds"],
        crawlAnalyzedAt: "2026-11-01T10:00:00.000Z",
      }),
    ).toMatch(
      /^No analysed page names both · service page \/boiler · location page \/leeds · crawl of /,
    );
  });
});
