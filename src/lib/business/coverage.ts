import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import type { CrawlRunStatus } from "@/generated/prisma/enums";
import type { IntegrationEvidence } from "@/lib/integrations/evaluate";
import type { BusinessFact } from "@/lib/knowledge/priority";
import type { RecommendationPriority } from "@/generated/prisma/enums";
import { BENEFIT } from "@/lib/recommendations/benefits";
import type {
  Effort,
  RecommendationMeta,
} from "@/lib/recommendations/metadata";
import {
  approved,
  approvedTypes,
  CONTACT_GOALS,
  factLabel,
  factWithSource,
  GOAL_LABEL,
  unconfirmedFactsNote,
  type Fact,
  type Goal,
} from "./facts";
import {
  best,
  matchPage,
  phrases,
  type PageMatch,
  type Strength,
} from "./match";
import {
  classify,
  containsPhrase,
  readPages,
  words,
  type Confidence,
  type UnderstoodPage,
} from "./pages";

import {
  buildOpportunities,
  offeringParts,
  offeringType,
  OPPORTUNITY_VERSION,
  type ExistingTasks,
  type PageOpportunity,
} from "./opportunities";

export { matchPage, type PageMatch, type Strength };

/**
 * Business coverage: whether the pages the crawler found serve the approved
 * business facts. Deterministic and evidence-based:
 *
 * - Only APPROVED facts are matched or recommended on.
 * - A page found by the crawler is not a page indexed by Google.
 * - "Missing" is only recommended on when the latest analysed crawl
 *   completed without reaching its limits and is recent; otherwise a page
 *   may exist that was not checked, and the gap is shown for review only.
 * - No fixed page quotas: location pages are expected only for businesses
 *   with several locations; service areas only need naming somewhere.
 *
 * Bump COVERAGE_VERSION when a rule or threshold changes meaning.
 */
export const COVERAGE_VERSION = "c1";
/** Crawl evidence older than this cannot confirm a gap (scoring/freshness.ts). */
export const STALE_DAYS = EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO;

export type NeedStatus =
  | "covered"
  | "ambiguous"
  | "weak"
  | "missing"
  | "not-confirmed"
  | "not-checked";

export type NeedKind =
  | "service-page"
  | "location-page"
  | "location-mention"
  | "service-areas"
  | "contact-path";

export type CoverageNeed = {
  /** The recommendation title this need produces (its identity). */
  key: string;
  kind: NeedKind;
  /** Approved facts behind it. */
  facts: Array<Pick<Fact, "id" | "kind" | "value" | "source">>;
  status: NeedStatus;
  matches: PageMatch[];
  /** Plain-language explanation of the status. */
  note: string;
  /** True only when the evidence supports recommending work. */
  recommend: boolean;
};

export type CoverageCrawl = {
  analyzedAt: Date;
  status: CrawlRunStatus;
  analysedPages: number;
  /** Completed without reaching its page or depth limit. */
  complete: boolean;
  ageDays: number;
  /** Why "missing" cannot be confirmed (null when it can). */
  gap: string | null;
  /** Every reason the crawl did not inspect the whole site. */
  limits: string[];
  /**
   * Known URLs the crawl could not inspect: blocked by robots.txt or not
   * fetched. An opportunity whose name matches one is never "confirmed".
   */
  unchecked: Array<{ url: string; reason: "robots-blocked" | "fetch-failed" }>;
};

export type CoverageReview = { title: string; detail: string; urls: string[] };

export type CoverageResult = {
  version: string;
  crawl: CoverageCrawl | null;
  pages: UnderstoodPage[];
  needs: CoverageNeed[];
  reviews: CoverageReview[];
  approvedFacts: Fact[];
  pendingFacts: number;
  /** Approved facts each page serves (strong or medium match), by URL. */
  pageFacts: Map<string, string[]>;
  /** Pages the business may be missing (business/opportunities.ts). */
  opportunities: PageOpportunity[];
  /** Questions about approved facts that block a suggestion. */
  clarifications: Array<{ title: string; detail: string }>;
};

const DAY = 86_400_000;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function crawlEvidence(
  crawl: NonNullable<IntegrationEvidence["crawl"]>,
  analysedPages: number,
  now: Date,
): CoverageCrawl {
  const limited = crawl.pages.some(
    (p) =>
      p.skipReason === "BUDGET_EXCEEDED" || p.skipReason === "DEPTH_EXCEEDED",
  );
  // Pages the crawl reached but could not inspect: a fetch failure or a
  // server error says nothing about what the page contains.
  const failed = crawl.pages.filter(
    (p) =>
      p.status === "FAILED" ||
      (p.status === "CRAWLED" && (p.httpStatus ?? 0) >= 500),
  );
  // Discovery that really dropped candidates (recorded on the seed page's
  // parsed result and per page; see crawler/engine.ts and html.ts).
  // The start page: the seed, or the page it redirects to (both depth 0).
  const starts = crawl.pages.filter(
    (p) =>
      (p.depth === 0 || p.discoverySource === "SEED") &&
      p.status === "CRAWLED" &&
      !!p.result &&
      typeof p.result === "object",
  );
  const seed =
    starts.find((p) => (p.result as { discovery?: unknown }).discovery) ??
    starts[0];
  const discovery = seed
    ? (seed.result as { discovery?: unknown }).discovery
    : undefined;
  const d =
    discovery && typeof discovery === "object"
      ? (discovery as {
          sitemapFilesOmitted?: unknown;
          sitemapUrlsCapped?: unknown;
          sitemaps?: {
            failed?: { count?: unknown };
            unprocessed?: { count?: unknown };
          };
        })
      : null;
  const ledgerCount = (n: unknown) => (typeof n === "number" ? n : 0);
  const sitemapsFailed = ledgerCount(d?.sitemaps?.failed?.count);
  const sitemapsUnread = ledgerCount(d?.sitemaps?.unprocessed?.count);
  const linksOmitted = crawl.pages.filter((p) => {
    const n = (p.result as { linksOmitted?: unknown } | null)?.linksOmitted;
    return typeof n === "number" && n > 0;
  }).length;
  // The crawler stops recording new URLs once it holds this many.
  const capped =
    !!crawl.maxDiscoveredUrls && crawl.pages.length >= crawl.maxDiscoveredUrls;
  const sitemapFilesOmitted =
    typeof d?.sitemapFilesOmitted === "number" ? d.sitemapFilesOmitted : 0;
  const discoveryCut =
    sitemapFilesOmitted > 0 ||
    d?.sitemapUrlsCapped === true ||
    linksOmitted > 0;
  // No evidence although the crawl has a start page: an older crawl, or a
  // start page that was never parsed (e.g. it redirected somewhere blocked).
  const hasSeedRow = crawl.pages.some((p) => p.discoverySource === "SEED");
  const discoveryUnknown = !d && (!!seed || hasSeedRow);
  const complete =
    crawl.status === "COMPLETED" &&
    !limited &&
    !failed.length &&
    !capped &&
    !discoveryCut &&
    !discoveryUnknown;
  const ageDays = Math.floor(
    (now.getTime() - crawl.analyzedAt.getTime()) / DAY,
  );
  const limits = [
    crawl.status !== "COMPLETED"
      ? `The latest crawl is ${crawl.status.toLowerCase()}, so pages it did not reach were not checked.`
      : null,
    limited
      ? "The latest crawl reached its page or depth limit, so some pages were not checked."
      : null,
    failed.length
      ? `${plural(failed.length, "page")} could not be fetched or returned a server error, so ${failed.length === 1 ? "it was" : "they were"} not checked.`
      : null,
    capped
      ? `The latest crawl reached its limit of ${crawl.maxDiscoveredUrls} discovered URLs, so further URLs were not recorded.`
      : null,
    sitemapFilesOmitted > 0
      ? d?.sitemaps
        ? `${plural(sitemapFilesOmitted, "sitemap file")} listed by the site could not be read (${[
            sitemapsFailed ? `${sitemapsFailed} failed` : null,
            sitemapsUnread
              ? `${sitemapsUnread} beyond the crawl's limits`
              : null,
          ]
            .filter(Boolean)
            .join(", ")}), so pages listed only there were not checked.`
        : `${plural(sitemapFilesOmitted, "sitemap file")} listed by the site ${sitemapFilesOmitted === 1 ? "was" : "were"} not read (the crawl reads at most 3).`
      : null,
    d?.sitemapUrlsCapped === true
      ? "A sitemap listed more URLs than the crawl records."
      : null,
    linksOmitted > 0
      ? `${plural(linksOmitted, "page")} had more links than the crawl follows (500 per page), so some linked pages were not discovered.`
      : null,
    discoveryUnknown
      ? "This crawl predates recording of sitemap and link limits, so it cannot tell whether discovery was cut short; crawl again to confirm missing pages."
      : null,
    ageDays > STALE_DAYS
      ? `The latest crawl is ${ageDays} days old; crawl again to confirm.`
      : null,
  ].filter((x): x is string => !!x);
  return {
    analyzedAt: crawl.analyzedAt,
    status: crawl.status,
    analysedPages,
    complete,
    ageDays,
    gap: limits[0] ?? null,
    limits,
    unchecked: [
      ...crawl.pages
        .filter((p) => p.skipReason === "ROBOTS_DISALLOWED")
        .map((p) => ({ url: p.url, reason: "robots-blocked" as const })),
      ...failed.map((p) => ({ url: p.url, reason: "fetch-failed" as const })),
    ],
  };
}

/**
 * Every page that matches a fact, best first, with the page-type rules of
 * coverage applied: a legal page only ever mentions something, and a blog
 * post or the home page of a multi-service business mentions a service
 * rather than being the page about it. Shared with the topic map.
 */
export function factMatches(
  pages: UnderstoodPage[],
  f: Pick<Fact, "kind" | "value" | "synonyms">,
  serviceCount: number,
  opts: { fullTitle?: boolean; body?: boolean } = {},
): PageMatch[] {
  return best(
    pages.flatMap((p) => {
      // A legal page's text (a privacy policy listing what guests book)
      // is no evidence that the business covers an offering.
      const m = matchPage(
        p,
        f,
        p.type === "legal" ? { ...opts, body: false } : opts,
      );
      if (!m) return [];
      // A legal page that names an offering or place (a privacy policy
      // with the business address) mentions it; it is never the page
      // about it.
      if (m.strength === "strong" && p.type === "legal")
        return [
          {
            ...m,
            strength: "medium" as const,
            note: "A legal page names it.",
          },
        ];
      // A blog post or the home page of a multi-service business mentions
      // a service; it is not a page about it.
      if (
        m.strength === "strong" &&
        f.kind === "SERVICE" &&
        (p.type === "article" || (p.isHome && serviceCount > 1))
      )
        return [
          {
            ...m,
            strength: "medium" as const,
            note: p.isHome
              ? "The home page names it, but the business offers several services."
              : "A blog post or article names it.",
          },
        ];
      return [m];
    }),
  );
}

/**
 * A location's own page: classified as a location page, or unclassified and
 * naming it in the title or H1. The home, contact and service pages that
 * mention a place are not pages about that place.
 */
export function isLocationPage(pages: UnderstoodPage[], m: PageMatch): boolean {
  const p = pages.find((x) => x.url === m.url);
  return (
    p?.type === "location" ||
    (p?.type === "unknown" &&
      m.where.some((w) => w === "title" || w === "main heading"))
  );
}

/** Analyses one website's coverage from its latest crawl and its facts. */
export function analyzeCoverage(input: {
  websiteUrl: string;
  crawl: IntegrationEvidence["crawl"];
  facts: Fact[];
  now?: Date;
  /** Existing business tasks by title: what people accepted or dismissed. */
  existing?: ExistingTasks;
  /** The business's own names (profile), stripped from titles as the site name. */
  brandNames?: string[];
}): CoverageResult {
  const now = input.now ?? new Date();
  const ok = approved(input.facts);
  const of = (kind: Fact["kind"]) => ok.filter((f) => f.kind === kind);
  const services = of("SERVICE");
  const locations = of("LOCATION");
  const areas = of("SERVICE_AREA");
  const excluded = of("EXCLUDED");
  const goals = of("GOAL").map((f) => f.value as Goal);
  const types = approvedTypes(input.facts);
  const pendingFacts = input.facts.filter((f) => f.status === "PENDING").length;

  const base = input.crawl
    ? readPages(input.crawl.pages, input.websiteUrl, input.brandNames ?? [])
    : [];
  const termIn = (p: (typeof base)[number], facts: Fact[]) =>
    facts.some((f) =>
      phrases(f).some((ph) =>
        [p.title, ...p.h1].some((t) => containsPhrase(words(t), ph)),
      ),
    );
  const pages: UnderstoodPage[] = base.map((p) => ({
    ...p,
    ...classify(p, {
      service: termIn(p, services),
      location: termIn(p, locations),
    }),
  }));
  const crawl = input.crawl
    ? crawlEvidence(input.crawl, pages.length, now)
    : null;
  const canRecommend = !!crawl && !crawl.gap;
  const errorPages = (input.crawl?.pages ?? []).filter(
    (p) => p.status === "CRAWLED" && (p.httpStatus ?? 0) >= 400,
  );

  const matchesFor = (
    f: Fact,
    opts: { fullTitle?: boolean; body?: boolean } = {},
  ) => factMatches(pages, f, services.length, opts);

  const needs: CoverageNeed[] = [];
  const missingNote = () =>
    crawl
      ? `Not found in the titles, headings, descriptions, link text or structured data of the ${plural(crawl.analysedPages, "analysed page")}.`
      : "No analysed crawl yet.";
  const statusOf = (
    matches: PageMatch[],
    dedicated: (m: PageMatch) => boolean,
  ): { status: NeedStatus; note: string } => {
    if (!crawl)
      return { status: "not-checked", note: "No analysed crawl yet." };
    const strong = matches.filter(
      (m) => m.strength === "strong" && dedicated(m),
    );
    if (strong.length === 1)
      return { status: "covered", note: `Covered by ${strong[0].url}.` };
    if (strong.length > 1)
      return {
        status: "ambiguous",
        note: `${strong.length} pages are about it; check they do not compete with each other.`,
      };
    if (matches.length)
      return {
        status: "weak",
        note: `Mentioned on ${plural(matches.length, "page")}, but no page is clearly about it.`,
      };
    return crawl.gap
      ? { status: "not-confirmed", note: `${missingNote()} ${crawl.gap}` }
      : { status: "missing", note: missingNote() };
  };
  const locationPage = (m: PageMatch) => isLocationPage(pages, m);

  for (const f of services) {
    // Body mentions count as mentions here: this check never creates a task
    // or completes one (page opportunities do), so they can only turn
    // "missing" into "mentioned".
    const matches = matchesFor(f, { body: true });
    let { status, note } = statusOf(matches, () => true);
    const broken =
      status === "missing" || status === "not-confirmed"
        ? errorPages.find((p) =>
            phrases(f).some((ph) =>
              containsPhrase(
                words(new URL(p.url).pathname.replace(/[-_/.]+/g, " ")),
                ph,
              ),
            ),
          )
        : undefined;
    if (broken) {
      status = "weak";
      note = `A page at ${broken.url} returns HTTP ${broken.httpStatus}; fix it first (see the page error task).`;
    }
    needs.push({
      key: `Add a page for “${f.value}” (BIZ_SERVICE_PAGE)`,
      kind: "service-page",
      facts: [f],
      status,
      matches: matches.slice(0, 5),
      note,
      recommend: status === "missing" && canRecommend,
    });
  }

  const locationPages =
    types.includes("multi-location") || locations.length > 1;
  for (const f of locations) {
    const matches = matchesFor(f);
    if (locationPages) {
      // Several locations: each usually has its own page. One stable key
      // per location, whatever its status, so the task can be verified.
      const s = statusOf(matches, locationPage);
      needs.push({
        key: `Add a page for the ${f.value} location (BIZ_LOCATION_PAGE)`,
        kind: "location-page",
        facts: [f],
        status: s.status,
        matches: matches.slice(0, 5),
        note:
          s.status === "weak"
            ? `${s.note} With several locations, each usually has its own page.`
            : s.note,
        recommend:
          canRecommend && (s.status === "missing" || s.status === "weak"),
      });
    } else {
      // One location: being named anywhere is enough, the site name included
      // (a brand such as "Kasol Cottages" does name Kasol).
      const named = matchesFor(f, { fullTitle: true });
      const s = statusOf(named, () => true);
      // Named on one page or several: either way it is named.
      let status: NeedStatus =
        s.status === "weak" || s.status === "ambiguous" ? "covered" : s.status;
      let note =
        status === "covered" && named.length
          ? `Named on ${named[0].url}.`
          : s.note;
      // Named only in the main text: not a gap to fix with a new task, but
      // not "covered" either, so a keyword in the body never completes one.
      const inBody =
        status === "missing" || status === "not-confirmed"
          ? matchesFor(f, { fullTitle: true, body: true })
          : [];
      if (inBody.length) {
        status = "weak";
        note = `Named only in the main text of ${inBody[0].url}; consider showing it in a heading, the contact details or the business's structured data.`;
      }
      needs.push({
        key: `Show the ${f.value} location on the website (BIZ_LOCATION_MENTION)`,
        kind: "location-mention",
        facts: [f],
        status,
        matches: (inBody.length ? inBody : named).slice(0, 5),
        note,
        recommend: canRecommend && status === "missing",
      });
    }
  }

  if (areas.length) {
    // Named anywhere counts, the site name included.
    const unnamed = areas.filter(
      (f) => !matchesFor(f, { fullTitle: true }).length,
    );
    const status: NeedStatus = !crawl
      ? "not-checked"
      : !unnamed.length
        ? "covered"
        : crawl.gap
          ? "not-confirmed"
          : "missing";
    needs.push({
      key: "Name the areas you serve on the website (BIZ_SERVICE_AREAS)",
      kind: "service-areas",
      facts: unnamed.length ? unnamed : areas,
      status,
      matches: [],
      note: !crawl
        ? "No analysed crawl yet."
        : unnamed.length
          ? `${unnamed.map((f) => f.value).join(", ")} ${unnamed.length === 1 ? "is" : "are"} not named on any analysed page.${crawl.gap ? ` ${crawl.gap}` : ""}`
          : "Every approved service area is named on the site.",
      recommend: status === "missing",
    });
  }

  if (goals.some((g) => CONTACT_GOALS.includes(g))) {
    const contact = pages.filter((p) => p.type === "contact");
    const linked = pages.filter((p) =>
      p.inbound.some((t) =>
        /\b(contact|get in touch|book|enquir|quote|call us)/i.test(t),
      ),
    );
    const found = best(
      [...contact, ...linked].map((p) => ({
        url: p.url,
        strength: (p.type === "contact" ? "strong" : "medium") as Strength,
        where: [p.type === "contact" ? "contact page" : "contact link text"],
        note: null,
      })),
    ).filter((m, i, all) => all.findIndex((x) => x.url === m.url) === i);
    const status: NeedStatus = !crawl
      ? "not-checked"
      : found.length
        ? "covered"
        : crawl.gap
          ? "not-confirmed"
          : "missing";
    const goalFacts = of("GOAL").filter((f) =>
      CONTACT_GOALS.includes(f.value as Goal),
    );
    needs.push({
      key: "Make it easy to get in touch (BIZ_CONTACT_PATH)",
      kind: "contact-path",
      facts: goalFacts,
      status,
      matches: found.slice(0, 5),
      note: !crawl
        ? "No analysed crawl yet."
        : found.length
          ? `Contact found on ${found[0].url}.`
          : `No contact page or contact link found among the ${plural(crawl.analysedPages, "analysed page")}.${crawl.gap ? ` ${crawl.gap}` : ""}`,
      recommend: status === "missing",
    });
  }

  const reviews: CoverageReview[] = [];
  for (const n of needs.filter((x) => x.status === "ambiguous"))
    reviews.push({
      title: `Several pages are about “${n.facts[0].value}”`,
      detail:
        "They may compete in search; consider one main page and link the others to it.",
      urls: n.matches.filter((m) => m.strength === "strong").map((m) => m.url),
    });
  for (const f of excluded) {
    const m = matchesFor(f).filter((x) => x.strength !== "weak");
    if (m.length)
      reviews.push({
        title: `Pages mention “${f.value}”, marked as not offered`,
        detail: "Check whether these pages should still promote it.",
        urls: m.map((x) => x.url).slice(0, 10),
      });
  }

  const pageFacts = new Map<string, string[]>();
  for (const f of [...services, ...locations, ...areas])
    for (const m of matchesFor(f))
      if (m.strength !== "weak")
        pageFacts.set(m.url, [...(pageFacts.get(m.url) ?? []), factLabel(f)]);

  const { opportunities, clarifications } = buildOpportunities({
    facts: ok,
    types,
    goals,
    pages,
    crawl,
    needs,
    errorPages,
    matchesFor: (f, opts) =>
      matchesFor({ id: "", source: "CLIENT", status: "APPROVED", ...f }, opts),
    existing: input.existing ?? new Map(),
  });

  return {
    version: COVERAGE_VERSION,
    crawl,
    pages,
    needs,
    reviews,
    approvedFacts: ok,
    pendingFacts,
    pageFacts,
    opportunities,
    clarifications,
  };
}

/** Needs that ask for a page are handled as page opportunities. */
export const PAGE_NEEDS: NeedKind[] = [
  "service-page",
  "location-page",
  "contact-path",
];

// ─── Recommendations ────────────────────────────────────────────────────────

type NeedText = {
  priority: RecommendationPriority;
  explanation: (n: CoverageNeed) => string;
  action: string;
  effort: Effort;
  effortReason: string;
  confidence: Confidence;
  confidenceReason: string;
  verification: (n: CoverageNeed) => string;
};

const NOT_BODY =
  "Pages are judged from their titles, headings, descriptions, link text and structured data; body text is not stored, so a mention in the body is not seen.";
const NOT_INDEX = "A page on the site is not necessarily indexed by Google.";
const names = (n: CoverageNeed) =>
  n.facts.map((f) => `“${f.value}”`).join(", ");

export const NEED_TEXT: Record<NeedKind, NeedText> = {
  "service-page": {
    priority: "MEDIUM",
    explanation: (n) =>
      `${names(n)} is an approved service, but no page about it was found.`,
    action:
      "Publish a page about this service: name it in the title and main heading, explain what is included and who it is for, and link to it from related pages.",
    effort: "large",
    effortReason: "Needs a new page with real content.",
    confidence: "medium",
    confidenceReason: NOT_BODY,
    verification: (n) =>
      `Confirmed when a later crawl finds a page whose title or main heading names ${names(n)} (or another wording entered for it).`,
  },
  "location-page": {
    priority: "MEDIUM",
    explanation: (n) =>
      `${names(n)} is an approved location, but has no page of its own.`,
    action:
      "Publish a page for this location with its address, opening hours and what is offered there, and link to it from the contact page.",
    effort: "large",
    effortReason: "Needs a new page with real, location-specific content.",
    confidence: "medium",
    confidenceReason: NOT_BODY,
    verification: (n) =>
      `Confirmed when a later crawl finds a page other than the home page whose title, main heading or structured address names ${names(n)}.`,
  },
  "location-mention": {
    priority: "LOW",
    explanation: (n) =>
      `${names(n)} is an approved location, but it is not named on the analysed pages.`,
    action:
      "Name the location (and its address) on the contact page, and in the structured data (LocalBusiness address) if you use it.",
    effort: "small",
    effortReason: "Usually a short addition to an existing page.",
    confidence: "low",
    confidenceReason: `${NOT_BODY} Check the footer and contact page first.`,
    verification: (n) =>
      `Confirmed when a later crawl finds ${names(n)} in a title, heading, description, link text or structured data.`,
  },
  "service-areas": {
    priority: "LOW",
    explanation: (n) =>
      `These approved service areas are not named on the analysed pages: ${names(n)}.`,
    action:
      "Name the areas you serve, for example in a short “Areas we cover” section on the relevant service or contact page. A separate page per area is not needed.",
    effort: "small",
    effortReason: "A short addition to an existing page.",
    confidence: "low",
    confidenceReason: `${NOT_BODY} Check the footer and contact page first.`,
    verification: () =>
      "Confirmed when a later crawl finds every listed area in a title, heading, description, link text or structured data.",
  },
  "contact-path": {
    priority: "MEDIUM",
    explanation: () =>
      "The business wants calls, enquiries or bookings, but no contact page or clearly labelled contact link was found.",
    action:
      "Add a contact page (phone, email or form, and booking if offered) and link to it from the main navigation with a clear label such as “Contact”.",
    effort: "medium",
    effortReason: "A new page or a navigation change.",
    confidence: "medium",
    confidenceReason:
      "Detected from page types and link text; a contact form embedded on other pages is not recognised.",
    verification: () =>
      "Confirmed when a later crawl finds a contact page or a link labelled “Contact”, “Book” or similar.",
  },
};

/** The recommendation a page opportunity becomes. */
export function opportunityDraft(o: PageOpportunity) {
  return {
    title: o.key,
    explanation: `${o.why} ${o.stateReason}`,
    priority: o.priority,
    expectedImpact: BENEFIT["business-coverage"].text,
    recommendedAction:
      o.state === "weak"
        ? "Improve the existing page so it fulfils this purpose (see why), rather than adding another page. The outline lists what it should cover."
        : `Publish a page about it, following the outline. Suggested URL: ${o.slug} (a proposal; use the site's own URL style).`,
    issueId: null,
  };
}

/** Recommendation drafts for the needs and opportunities the evidence supports. */
export function coverageDrafts(c: CoverageResult | null) {
  return [
    ...(c?.opportunities ?? [])
      .filter((o) => o.recommend)
      .map(opportunityDraft),
    ...(c?.needs ?? [])
      .filter((n) => n.recommend && !PAGE_NEEDS.includes(n.kind))
      .map((n) => ({
        title: n.key,
        explanation: NEED_TEXT[n.kind].explanation(n),
        priority: NEED_TEXT[n.kind].priority,
        expectedImpact: BENEFIT["business-coverage"].text,
        recommendedAction: NEED_TEXT[n.kind].action,
        issueId: null,
      })),
  ];
}

/** Metadata for a coverage recommendation; null when its need is gone. */
export function coverageMeta(
  title: string,
  c: CoverageResult | null,
): RecommendationMeta | null {
  const o = c?.opportunities.find((x) => x.key === title);
  if (o && c?.crawl) {
    const facts = o.facts.map(factWithSource).join(", ");
    return {
      detected: o.stateReason,
      benefit: "business-coverage",
      confidence: c.crawl.gap ? "low" : o.confidence,
      confidenceReason: c.crawl.gap ?? o.confidenceReason,
      effort: o.effort,
      effortReason: o.effortReason,
      priorityRationale: `${o.priorityReason} Based on approved business facts: ${facts}.`,
      evidence: [
        `Checked ${plural(c.crawl.analysedPages, "analysed page")} from the crawl of ${c.crawl.analyzedAt.toISOString().slice(0, 10)}.`,
        ...o.considered.map((p) => `${p.url}: ${p.verdict}`),
      ],
      urls: o.considered.map((p) => p.url),
      coverage: null,
      likelyTemplate: false,
      verification: o.verification,
      // An unconfirmed fact is the first thing to check, before the crawl's limits.
      limits: (() => {
        const note = unconfirmedFactsNote(o.facts);
        const rest = o.assumptions.filter((a) => a !== note);
        return [...(note ? [note] : []), NOT_BODY, NOT_INDEX, ...rest];
      })(),
      knowledgeVersion: OPPORTUNITY_VERSION,
      proposal: {
        name: o.name,
        slug: o.slug,
        topic: o.topic,
        intent: o.intent,
        outline: o.outline,
        goals: o.goals.map((g) => GOAL_LABEL[g]),
      },
    };
  }
  const n = c?.needs.find((x) => x.key === title);
  if (!n || !c?.crawl) return null;
  const t = NEED_TEXT[n.kind];
  const stale = !!c.crawl.gap;
  return {
    detected: n.note,
    benefit: "business-coverage",
    confidence: stale ? "low" : t.confidence,
    confidenceReason: stale ? c.crawl.gap! : t.confidenceReason,
    effort: t.effort,
    effortReason: t.effortReason,
    priorityRationale: `Based on approved business facts: ${n.facts.map(factWithSource).join(", ")}.`,
    evidence: [
      `Checked ${plural(c.crawl.analysedPages, "analysed page")} from the crawl of ${c.crawl.analyzedAt.toISOString().slice(0, 10)}.`,
      ...n.matches.map(
        (m) =>
          `${m.url}: ${m.strength} match (${m.where.join(", ")})${m.note ? `. ${m.note}` : ""}`,
      ),
    ],
    urls: n.matches.map((m) => m.url),
    coverage: null,
    likelyTemplate: false,
    verification: t.verification(n),
    limits: [
      ...[unconfirmedFactsNote(n.facts)].filter((x): x is string => !!x),
      NOT_BODY,
      NOT_INDEX,
    ],
    knowledgeVersion: COVERAGE_VERSION,
  };
}

/** Approved facts a recommendation affects, for the ranking's relevance factor. */
export function relevantFacts(
  r: { title: string },
  meta: RecommendationMeta | null,
  c: CoverageResult | null,
): BusinessFact[] {
  if (!c) return [];
  const need =
    c.opportunities.find((o) => o.key === r.title) ??
    c.needs.find((n) => n.key === r.title);
  const labels = need
    ? need.facts.map((f) => factLabel(f))
    : [...new Set((meta?.urls ?? []).flatMap((u) => c.pageFacts.get(u) ?? []))];
  return labels.map((label) => ({ label, approved: true }));
}

// ─── Stable identity across fact and business-type changes ─────────────────

/** Codes of opportunities for one offering (whose title names it). */
const OFFERING_CODES = [
  "BIZ_SERVICE_PAGE",
  "BIZ_ACCOMMODATION_PAGE",
  "BIZ_FOOD_PAGE",
] as const;
const codeOf = (title: string) => /\((BIZ_[A-Z_]+)\)$/.exec(title)?.[1] ?? null;

/** The offering a task title names: the quoted text, or "the X" for food pages. */
export function offeringOfTitle(title: string): string | null {
  const quoted = /“(.+)”/.exec(title)?.[1];
  if (quoted) return quoted;
  return /page for the (.+?) \(BIZ_/.exec(title)?.[1] ?? null;
}

const RANK_STATUS: Record<string, number> = {
  IN_PROGRESS: 0,
  PROPOSED: 1,
  DISMISSED: 2,
};

export type RekeyPlan = {
  moves: Array<{ id: string; from: string; to: string }>;
  /** Tasks with several equally good targets: left alone, for review. */
  ambiguous: Array<{ id: string; title: string; candidates: string[] }>;
};

const norm = (text: string) => words(text).join(" ");

/**
 * How surely a task's old offering and a current opportunity's offering are
 * the same purpose (0: not at all):
 * - 3: the same words after normalisation (a re-worded or re-typed title);
 * - 2: the same approved fact, split or merged ("Cottages and Cafe" and
 *   "Cottages"): the old wording equals the opportunity's fact value or one
 *   of that value's parts;
 * - 1: two or more significant words shared, one wording containing the
 *   other ("Emergency boiler repair" and "Boiler repair").
 * A single shared word ("Boiler repair" and "Repair") never matches.
 */
export function rekeyScore(oldLabel: string, o: PageOpportunity): number {
  const mine = words(oldLabel);
  const theirs = words(offeringOfTitle(o.key) ?? "");
  if (!mine.length || !theirs.length) return 0;
  if (norm(oldLabel) === theirs.join(" ")) return 3;
  const fact = o.facts[0]?.value ?? "";
  // Parts count only where the engine itself splits a value: every part a
  // recognised offering type ("Cottages and Cafe"), never "Boiler repair
  // and servicing".
  const parts = offeringParts(fact);
  const splittable = parts.length > 1 && parts.every((p) => offeringType(p));
  const sameFact =
    norm(fact) === norm(oldLabel) ||
    (splittable && parts.some((part) => norm(part) === norm(oldLabel)));
  if (sameFact) return 2;
  const shared = mine.filter((w) => theirs.includes(w));
  const contained =
    mine.every((w) => theirs.includes(w)) ||
    theirs.every((w) => mine.includes(w));
  return shared.length >= 2 && contained ? 1 : 0;
}

/**
 * Re-keys business tasks whose opportunity disappeared because its title
 * changed (business type approved or withdrawn, a compound offering split or
 * merged, an offering re-worded) to the current opportunity for the same
 * purpose, so it never becomes two tasks. The task keeps its id, status and
 * history; a dismissed one stays dismissed; completed tasks are history and
 * never move. A partial match (score below 3) moves an open task only onto a
 * confirmed opportunity, so nothing awaiting review is quietly accepted. A
 * task with several equally good targets is left alone and reported as
 * ambiguous; anything without a match stays as it is (shown as "no longer
 * approved; review"). Matching rules: rekeyScore.
 */
export function rekeyTasks(
  tasks: Array<{ id: string; title: string; status: string }>,
  c: CoverageResult | null | undefined,
): RekeyPlan {
  if (!c) return { moves: [], ambiguous: [] };
  // Page needs are superseded by opportunities (same purpose, newer key).
  const current = new Set([
    ...c.opportunities.map((o) => o.key),
    ...c.needs.filter((n) => !PAGE_NEEDS.includes(n.kind)).map((n) => n.key),
  ]);
  const taken = new Set(tasks.map((t) => t.title));
  const free = c.opportunities.filter(
    (o) =>
      !taken.has(o.key) &&
      (OFFERING_CODES as readonly string[]).includes(codeOf(o.key) ?? "") &&
      o.state !== "unsupported",
  );
  const orphans = tasks
    .filter(
      (t) =>
        t.status in RANK_STATUS &&
        !current.has(t.title) &&
        (OFFERING_CODES as readonly string[]).includes(codeOf(t.title) ?? ""),
    )
    .sort(
      (a, b) =>
        RANK_STATUS[a.status] - RANK_STATUS[b.status] ||
        a.title.localeCompare(b.title),
    );
  const MAIN: Record<string, number> = {
    BIZ_ACCOMMODATION_PAGE: 0,
    BIZ_SERVICE_PAGE: 1,
    BIZ_FOOD_PAGE: 2,
  };
  const ambiguous: RekeyPlan["ambiguous"] = [];
  // Each task's best target, if it is the only one at that score.
  const best = orphans.flatMap((t) => {
    const label = offeringOfTitle(t.title);
    if (!label) return [];
    const scored = free
      .map((o) => ({ o, score: rekeyScore(label, o) }))
      .filter(
        ({ o, score }) =>
          score === 3 ||
          (score > 0 && (o.state === "confirmed" || t.status === "DISMISSED")),
      )
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return [];
    let top = scored.filter((x) => x.score === scored[0].score);
    // Parts of one approved fact (a split): not ambiguous about the purpose,
    // so the main offering (accommodation, service, then food) takes it.
    const facts = new Set(top.map((x) => x.o.facts[0]?.id));
    if (top.length > 1 && top[0].score === 2 && facts.size === 1)
      top = [...top]
        .sort((a, b) => MAIN[codeOf(a.o.key)!] - MAIN[codeOf(b.o.key)!])
        .slice(0, 1);
    if (top.length > 1) {
      ambiguous.push({
        id: t.id,
        title: t.title,
        candidates: top.map((x) => x.o.key),
      });
      return [];
    }
    return [{ t, o: top[0].o, score: top[0].score }];
  });
  // One task per opportunity: the best score, then active before dismissed,
  // then the main offering; a task that loses here stays where it is.
  best.sort(
    (a, b) =>
      b.score - a.score ||
      RANK_STATUS[a.t.status] - RANK_STATUS[b.t.status] ||
      MAIN[codeOf(a.t.title)!] - MAIN[codeOf(b.t.title)!] ||
      a.t.title.localeCompare(b.t.title),
  );
  const moves: RekeyPlan["moves"] = [];
  const used = new Set<string>();
  for (const { t, o } of best) {
    if (used.has(o.key)) continue;
    used.add(o.key);
    moves.push({ id: t.id, from: t.title, to: o.key });
  }
  return { moves, ambiguous };
}
