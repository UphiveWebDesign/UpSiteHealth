import type {
  RecommendationPriority,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import { SEO_LIMITS, type BusinessType } from "@/lib/knowledge/catalogue";
import type { Effort } from "@/lib/recommendations/metadata";
import type { CoverageCrawl, CoverageNeed } from "./coverage";
import {
  GOAL_LABEL,
  unconfirmedFactsNote,
  type Fact,
  type Goal,
} from "./facts";
import { phrases, type PageMatch } from "./match";
import {
  containsPhrase,
  withoutPhrases,
  words,
  type Confidence,
  type UnderstoodPage,
} from "./pages";

/**
 * Page opportunities: pages a business website may be missing, worked out
 * deterministically from APPROVED business facts and the latest crawl.
 *
 * - Only approved facts suggest pages. Pending, rejected and inferred facts,
 *   and other wordings that name a different offering, never do.
 * - A page is "confirmed" missing only when the latest analysed crawl is
 *   complete and recent; otherwise the opportunity needs review.
 * - No page per audience, keyword or service area; facilities are grouped;
 *   at most MAX_CONFIRMED new pages are suggested at a time.
 * - A page counts as fulfilling the purpose only when it is about it (named
 *   in its title, main heading or structured data, and not the home page of
 *   a business with several offerings), indexable, and its main content
 *   (without header, navigation, footer or text repeated across the site)
 *   has at least 200 words AND mentions the offering. The word count is a
 *   minimum, never proof on its own; crawls stored before main-content
 *   detection cannot verify anything.
 * - Nothing here invents rates, facilities, room types or availability: the
 *   outline names approved facts and asks for the rest to be confirmed.
 *
 * Bump OPPORTUNITY_VERSION when a rule changes meaning.
 */
export const OPPORTUNITY_VERSION = "o2";
export const MAX_CONFIRMED = 5;

export type OpportunityCategory =
  | "accommodation"
  | "food"
  | "facilities"
  | "experience"
  | "service"
  | "product"
  | "location"
  | "contact";

export type OpportunityState =
  /** No page serves it, on complete and recent evidence. */
  | "confirmed"
  /** May be worth a page, but needs a person to decide. */
  | "review"
  /** A page exists but does not fulfil the purpose yet. */
  | "weak"
  /** The crawl was partial, limited, failed or stale: cannot tell. */
  | "incomplete"
  /** An existing page already fulfils the purpose. */
  | "fulfilled"
  /** Not supported by approved facts (e.g. marked as not offered). */
  | "unsupported";

export type ConsideredPage = { url: string; verdict: string };

export type PageOpportunity = {
  /** Recommendation title (its identity), ending in a BIZ_ code. */
  key: string;
  category: OpportunityCategory;
  /** What the page is for, in plain words. */
  name: string;
  state: OpportunityState;
  stateReason: string;
  why: string;
  facts: Array<Pick<Fact, "id" | "kind" | "value" | "source">>;
  goals: Goal[];
  considered: ConsideredPage[];
  /** A proposal only; the business chooses the real URL. */
  slug: string;
  topic: string;
  intent: string;
  outline: string[];
  assumptions: string[];
  priority: RecommendationPriority;
  priorityReason: string;
  confidence: Confidence;
  confidenceReason: string;
  effort: Effort;
  effortReason: string;
  verification: string;
  /** The page that fulfils it, when state is "fulfilled". */
  fulfilledBy: string | null;
  /** What a person decided before (an existing task), if anything. */
  decision: "accepted" | "dismissed" | null;
  /** True when it becomes (or stays) a recommendation in the plan. */
  recommend: boolean;
};

export type ExistingTasks = Map<string, RecommendationStatus>;

// ─── Offerings ──────────────────────────────────────────────────────────────

/** Single-word offering types (matched on singularised words). */
const TYPE_WORDS: Record<string, string[]> = {
  stay: [
    "cottage",
    "room",
    "hotel",
    "resort",
    "villa",
    "homestay",
    "hostel",
    "suite",
    "chalet",
    "lodge",
    "cabin",
    "guesthouse",
    "apartment",
    "accommodation",
    "stay",
    "bungalow",
  ],
  camping: ["camp", "camping", "tent", "glamping", "campsite"],
  food: [
    "cafe",
    "restaurant",
    "menu",
    "bar",
    "bistro",
    "bakery",
    "dining",
    "coffee",
    "eatery",
    "canteen",
  ],
  facility: [
    "bonfire",
    "parking",
    "wifi",
    "pool",
    "spa",
    "garden",
    "terrace",
    "laundry",
    "gym",
    "bbq",
    "barbecue",
    "playground",
  ],
  // Things guests do or events they book during a stay, and attractions:
  // worth mentioning, rarely worth a page of their own.
  experience: [
    "party",
    "celebration",
    "birthday",
    "wedding",
    "anniversary",
    "event",
    "dj",
    "music",
    "karaoke",
    "photography",
    "photo",
    "photoshoot",
    "viewpoint",
    "trek",
    "trekking",
    "hike",
    "hiking",
    "tour",
    "excursion",
    "activity",
    "adventure",
    "yoga",
    "sightseeing",
    "rafting",
    "paragliding",
    "stargazing",
  ],
};
const CATEGORY_OF_TYPE: Record<string, OpportunityCategory> = {
  stay: "accommodation",
  camping: "accommodation",
  food: "food",
  facility: "facilities",
  experience: "experience",
};

/** The offering type of a phrase, or null when no word is recognised. */
export function offeringType(text: string): string | null {
  const ws = words(text);
  for (const [type, list] of Object.entries(TYPE_WORDS))
    if (ws.some((w) => list.includes(w))) return type;
  return null;
}

/** The parts of a compound offering value ("Cottages and Cafe" → 2). */
export function offeringParts(value: string): string[] {
  return value
    .split(/\s*(?:,|&|\+|\/|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

type Offering = {
  fact: Fact;
  label: string;
  type: string | null;
  category: OpportunityCategory;
  /** Wordings used for matching (label plus same-type synonyms). */
  wordings: string[];
  /** Part of a compound fact such as "Cottages and Cafe". */
  component: boolean;
};

/**
 * The offerings an approved service fact names. For hospitality, a compound
 * value ("Cottages and Cafe") is split only when every part is a recognised
 * offering type, so "Bed and breakfast" stays one offering.
 */
export function offeringsOf(
  fact: Fact,
  types: BusinessType[],
): { offerings: Offering[]; unclear: string[] } {
  const hospitality = types.includes("hospitality");
  const ecommerce = types.includes("ecommerce");
  const parts = offeringParts(fact.value);
  const split =
    hospitality && parts.length > 1 && parts.every((p) => offeringType(p));
  const labels = split ? parts : [fact.value];
  const offerings = labels.map((label) => {
    const type = hospitality ? offeringType(label) : null;
    const category: OpportunityCategory = type
      ? CATEGORY_OF_TYPE[type]
      : ecommerce
        ? "product"
        : "service";
    // Other wordings count only when they name the same kind of offering;
    // outside hospitality every wording a person entered counts.
    const wordings = [
      label,
      ...fact.synonyms.filter((s) => !hospitality || offeringType(s) === type),
    ];
    return { fact, label, type, category, wordings, component: split };
  });
  const unclear = hospitality
    ? fact.synonyms.filter(
        (s) => !offerings.some((o) => o.type && offeringType(s) === o.type),
      )
    : [];
  return { offerings, unclear };
}

// ─── Wording helpers ────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const quote = (s: string) => `“${s}”`;
const listOf = (xs: string[]) =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const goalNames = (g: Goal[]) =>
  listOf(g.map((x) => GOAL_LABEL[x].toLowerCase()));

export function slugify(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page"
  );
}

const GOALS_FOR: Record<OpportunityCategory, Goal[]> = {
  accommodation: ["bookings", "calls", "visits"],
  food: ["visits", "calls"],
  facilities: ["bookings", "visits"],
  experience: ["bookings", "calls"],
  service: ["leads", "calls", "bookings", "sales"],
  product: ["sales"],
  location: ["visits", "calls"],
  contact: ["calls", "leads", "bookings", "visits"],
};

/** A short place name from approved facts, for the topic (never invented). */
function placeName(of: (k: Fact["kind"]) => Fact[]): string | null {
  const area = of("SERVICE_AREA")[0];
  if (area) return area.value;
  const loc = of("LOCATION")[0];
  if (!loc) return null;
  return loc.synonyms[0] ?? loc.value.split(",")[0].trim();
}

function contactSummary(c: NonNullable<UnderstoodPage["contact"]>): string {
  const parts = [
    c.tel ? "a phone link" : null,
    c.mailto ? "an email link" : null,
    c.whatsapp ? "a WhatsApp link" : null,
    c.forms ? "a contact form" : null,
  ].filter((x): x is string => !!x);
  return listOf(parts);
}

/**
 * How the home page covers an offering, from its main content (without
 * chrome, site-wide text, its title or H1): it "discusses" it when at least
 * two passages mention it and the main content has at least 200 words.
 */
export function homeCoverage(
  home: UnderstoodPage | undefined,
  wordings: string[][],
): {
  home: UnderstoodPage | undefined;
  level: "discusses" | "mentions" | "unknown";
  passages: number;
} {
  if (!home) return { home, level: "mentions", passages: 0 };
  if (!home.content) return { home, level: "unknown", passages: 0 };
  const heading = new Set(
    [home.title, home.fullTitle, ...home.h1].map((h) => words(h).join(" ")),
  );
  const passages = home.content.blocks.filter(
    (b) =>
      !heading.has(words(b).join(" ")) &&
      wordings.some((ph) =>
        containsPhrase(withoutPhrases(words(b), home.siteNames), ph),
      ),
  ).length;
  return {
    home,
    level:
      passages >= 2 && home.content.words >= SEO_LIMITS.thinContentWords
        ? "discusses"
        : "mentions",
    passages,
  };
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export type OpportunityInput = {
  facts: Fact[];
  types: BusinessType[];
  goals: Goal[];
  pages: UnderstoodPage[];
  crawl: CoverageCrawl | null;
  needs: CoverageNeed[];
  errorPages: Array<{ url: string; httpStatus: number | null }>;
  matchesFor: (
    f: Pick<Fact, "kind" | "value" | "synonyms">,
    opts?: { body?: boolean },
  ) => PageMatch[];
  existing: ExistingTasks;
};

/**
 * Why a page about the purpose does not fulfil it yet, or null when it does.
 * Main-content words are a minimum signal; the main content must also
 * mention the offering (one of its approved wordings).
 */
export function sufficiency(
  p: UnderstoodPage,
  opts: { contact?: boolean; wordings?: string[][]; label?: string },
): string | null {
  if (p.noindex) return "it asks search engines not to index it";
  if (p.canonicalElsewhere) return "its canonical points at a different URL";
  if (opts.contact) return null; // contact pages are legitimately short
  if (!p.content)
    return "this crawl predates main-content detection, so its content cannot be checked; crawl again to verify";
  if (p.content.words < SEO_LIMITS.thinContentWords)
    return `its main content has only ${p.content.words} words, not counting the header, navigation, footer or text repeated across the site`;
  const ws = opts.wordings ?? [];
  // The title and H1 already matched; the mention must be in the content.
  const heading = new Set(
    [p.title, p.fullTitle, ...p.h1].map((h) => words(h).join(" ")),
  );
  const body = p.content.blocks.filter((b) => !heading.has(words(b).join(" ")));
  if (
    ws.length &&
    !body.some((b) =>
      ws.some((ph) =>
        containsPhrase(withoutPhrases(words(b), p.siteNames), ph),
      ),
    )
  )
    return `its main content does not mention ${opts.label ? quote(opts.label) : "it"}`;
  return null;
}

/**
 * The approved "not offered" fact that names one of these wordings, if any.
 * Checked against every approved wording of an offering (its name and the
 * other wordings stored for it), never against inferred synonyms.
 */
export function excludedBy<F extends Pick<Fact, "value" | "synonyms">>(
  excluded: F[],
  wordings: string[],
): F | undefined {
  return excluded.find((e) =>
    phrases(e).some((ph) => wordings.some((w) => containsPhrase(words(w), ph))),
  );
}

export function buildOpportunities(input: OpportunityInput): {
  opportunities: PageOpportunity[];
  clarifications: Array<{ title: string; detail: string }>;
} {
  const { crawl, pages, goals } = input;
  const of = (k: Fact["kind"]) => input.facts.filter((f) => f.kind === k);
  const audiences = of("AUDIENCE");
  const constraints = of("CONSTRAINT");
  const locations = of("LOCATION");
  const excluded = of("EXCLUDED");
  const place = placeName(of);
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const noPrices = constraints.some((c) =>
    /\b(price|pricing|rate|cost)/i.test(c.value),
  );

  const clarifications: Array<{ title: string; detail: string }> = [];
  const offerings: Offering[] = [];
  for (const f of of("SERVICE")) {
    const { offerings: o, unclear } = offeringsOf(f, input.types);
    offerings.push(...o);
    if (unclear.length)
      clarifications.push({
        title: `${listOf(unclear.map(quote))} ${unclear.length === 1 ? "is" : "are"} entered as other wording for ${quote(f.value)}`,
        detail:
          "If these are separate offerings, add them as their own services and approve them; no page is suggested for them until then.",
      });
  }
  const totalOfferings = offerings.length;

  const supported = (cat: OpportunityCategory) =>
    GOALS_FOR[cat].filter((g) => goals.includes(g));
  const audienceLine = audiences.length
    ? `Who it is for (approved): ${audiences.map((a) => quote(a.value)).join("; ")}.`
    : null;
  const locationLine = locations.length
    ? `Where it is (approved): ${locations.map((l) => l.value).join("; ")}.`
    : null;
  const constraintLines = constraints.map(
    (c) => `Respect this approved constraint: ${quote(c.value)}.`,
  );
  const bookLine = (g: Goal[]) =>
    g.some((x) => x === "bookings" || x === "calls" || x === "leads")
      ? `How to ${g.includes("bookings") ? "book" : "get in touch"}: a clear phone number${g.includes("bookings") ? " and booking link or form" : " or enquiry form"} near the top.`
      : null;

  const opportunities: PageOpportunity[] = [];
  const decisionOf = (key: string): PageOpportunity["decision"] => {
    const s = input.existing.get(key);
    return s === undefined
      ? null
      : s === "DISMISSED"
        ? "dismissed"
        : "accepted";
  };

  /** Shared state logic for a page that should be about one offering. */
  const assess = (
    matches: PageMatch[],
    dedicated: (m: PageMatch, p: UnderstoodPage) => boolean,
    opts: {
      contact?: boolean;
      mentionIsGap: boolean;
      slug: string;
      /** Approved wordings the main content must mention. */
      wordings?: string[][];
      label?: string;
      /** Judge the home page by its main content (offering pages). */
      homeRule?: boolean;
    },
  ): {
    state: OpportunityState;
    reason: string;
    considered: ConsideredPage[];
    fulfilledBy: string | null;
  } => {
    const considered: ConsideredPage[] = [];
    if (!crawl)
      return {
        state: "incomplete",
        reason:
          "No analysed crawl yet, so existing pages could not be checked.",
        considered,
        fulfilledBy: null,
      };
    const matched = new Set(matches.map((m) => m.url));
    let fulfilledBy: string | null = null;
    let weak: string | null = null;
    let weakWhy: string | null = null;
    for (const m of matches) {
      const p = byUrl.get(m.url);
      if (!p) continue;
      if (opts.homeRule && p.isHome) continue; // judged below, by its content
      if (p.type === "legal") {
        considered.push({ url: m.url, verdict: "Legal page: not considered." });
        continue;
      }
      if (!dedicated(m, p)) {
        considered.push({
          url: m.url,
          verdict: `${p.isHome ? "Home page" : "Page"} mentions it (${m.where.join(", ")}) but is not about it.`,
        });
        continue;
      }
      const lacking = sufficiency(p, opts);
      if (lacking) {
        if (!weak) {
          weak = m.url;
          weakWhy = lacking;
        }
        considered.push({
          url: m.url,
          verdict: `About it, but does not fulfil the purpose yet: ${lacking}.`,
        });
      } else {
        fulfilledBy ??= m.url;
        considered.push({ url: m.url, verdict: "Fulfils the purpose." });
      }
    }
    for (const p of pages)
      if (!matched.has(p.url) && considered.length < 8)
        considered.push({
          url: p.url,
          verdict:
            p.type === "legal"
              ? "Legal page: not considered."
              : p.isHome
                ? "Home page: does not name it."
                : "Does not name it.",
        });
    const atSlug = pages.find(
      (p) => p.path.replace(/\/$/, "") === opts.slug.replace(/\/$/, ""),
    );
    // The home page, judged by what its main content says (never by its
    // title or H1 alone, and never just by how many offerings exist).
    const homeAssessment = opts.homeRule
      ? homeCoverage(
          pages.find((p) => p.isHome),
          opts.wordings ?? [],
        )
      : null;
    if (homeAssessment && homeAssessment.home) {
      const home = homeAssessment.home;
      considered.unshift({
        url: home.url,
        verdict:
          homeAssessment.level === "unknown"
            ? "Home page: this crawl predates main-content detection, so what it says could not be checked."
            : homeAssessment.level === "discusses"
              ? `Home page: its main content discusses it (${plural(homeAssessment.passages, "passage")}).`
              : homeAssessment.passages || matched.has(home.url)
                ? "Home page: mentions it, but does not discuss it."
                : "Home page: does not name it.",
      });
      // Avoid listing the home page twice.
      const i = considered.findIndex((c, n) => n > 0 && c.url === home.url);
      if (i > 0) considered.splice(i, 1);
    }
    // Known URLs the crawl could not inspect that look like this page.
    const unchecked = crawl.unchecked.find((u) =>
      (opts.wordings ?? []).some((ph) =>
        containsPhrase(
          words(new URL(u.url).pathname.replace(/[-_/.]+/g, " ")),
          ph,
        ),
      ),
    );
    if (fulfilledBy)
      return {
        state: "fulfilled",
        reason: `Already fulfilled by ${fulfilledBy}.`,
        considered,
        fulfilledBy,
      };
    if (weak)
      return {
        state: "weak",
        reason: `${weak} is about it but does not fulfil the purpose yet: ${weakWhy}. Improve that page rather than adding another.`,
        considered,
        fulfilledBy: null,
      };
    if (atSlug && !atSlug.isHome)
      return {
        state: "weak",
        reason: `A page already exists at ${atSlug.url}; improve it rather than adding another.`,
        considered,
        fulfilledBy: null,
      };
    if (homeAssessment?.level === "discusses") {
      const home = homeAssessment.home!;
      return totalOfferings <= 1
        ? {
            state: "fulfilled",
            reason: `The home page is about it: its main content discusses ${opts.label ? quote(opts.label) : "it"} in ${plural(homeAssessment.passages, "passage")}.`,
            considered,
            fulfilledBy: home.url,
          }
        : {
            state: "review",
            reason: `The home page already discusses ${opts.label ? quote(opts.label) : "it"} in its main content (${plural(homeAssessment.passages, "passage")}), so a dedicated page is optional: consider one if it needs its own details, photos or booking information.`,
            considered,
            fulfilledBy: null,
          };
    }
    if (unchecked)
      return {
        state: "incomplete",
        reason: `${unchecked.url} ${unchecked.reason === "robots-blocked" ? "is blocked by robots.txt" : "could not be fetched"}, so a page about it may already exist but could not be checked.`,
        considered,
        fulfilledBy: null,
      };
    if (crawl.gap)
      return {
        state: "incomplete",
        reason: `No page about it among the ${plural(crawl.analysedPages, "analysed page")}, but ${crawl.gap.charAt(0).toLowerCase()}${crawl.gap.slice(1)}`,
        considered,
        fulfilledBy: null,
      };
    if (homeAssessment?.level === "unknown")
      return {
        state: "review",
        reason:
          "This crawl predates main-content detection, so it cannot tell whether the home page already covers it. Crawl again to check.",
        considered,
        fulfilledBy: null,
      };
    if (matches.length && !opts.mentionIsGap)
      return {
        state: "review",
        reason: `Mentioned on ${plural(matches.length, "page")}, but no page is about it. Decide whether a dedicated page is useful.`,
        considered,
        fulfilledBy: null,
      };
    return {
      state: "confirmed",
      reason: matches.length
        ? `Only mentioned, on ${plural(matches.length, "page")}; no page among the ${plural(crawl.analysedPages, "analysed page")} is about it.`
        : `No page among the ${plural(crawl.analysedPages, "analysed page")} names it in its title, headings, description, links, structured data or main content.`,
      considered,
      fulfilledBy: null,
    };
  };

  // The home page is judged separately (homeCoverage), so it is never a
  // dedicated page here, whatever the number of offerings.
  const notHomeUnlessOnly = (m: PageMatch, p: UnderstoodPage) =>
    m.strength === "strong" &&
    p.type !== "article" &&
    p.type !== "contact" &&
    !p.isHome;

  // "Not offered" is checked against every approved wording of the
  // offering (its name and the other wordings stored for it), never
  // against inferred synonyms.
  const isExcluded = (o: Offering) => excludedBy(excluded, o.wordings);

  const services = pages.some((p) => /^\/services?\//.test(p.path));
  const facilityOfferings = offerings.filter(
    (o) => o.category === "facilities",
  );

  for (const o of offerings.filter((x) => x.category !== "facilities")) {
    const ex = isExcluded(o);
    const cat = o.category;
    const slug =
      cat === "service" && services
        ? `/services/${slugify(o.label)}/`
        : `/${slugify(o.label)}/`;
    const key =
      cat === "accommodation"
        ? `Add an accommodation page for ${quote(o.label)} (BIZ_ACCOMMODATION_PAGE)`
        : cat === "food"
          ? `Add a page for the ${o.label} (BIZ_FOOD_PAGE)`
          : `Add a page for ${quote(o.label)} (BIZ_SERVICE_PAGE)`;
    const g = supported(cat);
    // Main-content mentions count as mentions (weak): an offering the site
    // already talks about is a decision to review, not a confirmed gap.
    const matches = input.matchesFor(
      { kind: "SERVICE", value: o.label, synonyms: o.wordings.slice(1) },
      { body: true },
    );
    let a = assess(matches, notHomeUnlessOnly, {
      mentionIsGap: cat === "accommodation",
      wordings: o.wordings.flatMap((w) => phrases({ value: w, synonyms: [] })),
      label: o.label,
      homeRule: true,
      slug,
    });
    // A broken URL for it: fix that page (its own task) instead.
    const broken = input.errorPages.find((p) =>
      phrases({ value: o.label, synonyms: [] }).some((ph) =>
        containsPhrase(
          words(new URL(p.url).pathname.replace(/[-_/.]+/g, " ")),
          ph,
        ),
      ),
    );
    if (broken && (a.state === "confirmed" || a.state === "incomplete"))
      a = {
        ...a,
        state: "weak",
        reason: `A page at ${broken.url} returns HTTP ${broken.httpStatus}; fix it first (see the page error task).`,
      };
    // A food outlet that is only part of a compound offering may not need
    // its own page (e.g. a cafe for guests only): ask first.
    if (cat === "food" && o.component && a.state === "confirmed")
      a = {
        ...a,
        state: "review",
        reason: `${a.reason} The ${o.label.toLowerCase()} is part of ${quote(o.fact.value)}; a separate page helps only if it serves visitors on its own.`,
      };
    // An experience, event or attraction is worth mentioning, but a page of
    // its own needs distinct content and search interest a person judges.
    if (cat === "experience" && a.state === "confirmed")
      a = {
        ...a,
        state: "review",
        reason: `${a.reason} It is an experience or event: mention it where guests choose their stay, and consider a page of its own only if it has distinct details (what it includes, when it runs, how to book) that people look for.`,
      };
    if (ex)
      a = {
        ...a,
        state: "unsupported",
        reason: `${quote(ex.value)} is marked as not offered.`,
      };

    const name =
      cat === "accommodation"
        ? `Accommodation: ${o.label}`
        : cat === "food"
          ? `${o.label} (food and drink)`
          : cat === "experience"
            ? `${o.label} (experience or event)`
            : o.label;
    const outline =
      cat === "accommodation"
        ? [
            `What ${quote(o.label)} offers: describe only what is actually available, with your own photos.`,
            audienceLine,
            locationLine,
            bookLine(goals),
            ...constraintLines,
            "Link to it from the home page and the contact page.",
          ]
        : cat === "food"
          ? [
              `What the ${o.label.toLowerCase()} serves and when, once confirmed.`,
              "Whether visitors who are not staying are welcome.",
              locationLine,
              ...constraintLines,
              "Link to it from the home page and the accommodation page.",
            ]
          : [
              `What ${quote(o.label)} includes, in the business's own words.`,
              audienceLine,
              place ? `Where it is offered (approved): ${place}.` : null,
              bookLine(goals),
              ...constraintLines,
              "Link to it from related pages.",
            ];
    const assumptions = [
      cat === "accommodation"
        ? "Room or cottage types, capacity, amenities, rates and availability are not in the approved facts; confirm them before writing."
        : cat === "food"
          ? "Opening hours, menu and whether non-guests are served are not in the approved facts."
          : "Details, prices and availability are not in the approved facts; confirm them before writing.",
      ...(noPrices ? ["Do not publish prices (approved constraint)."] : []),
    ];
    const priority: RecommendationPriority =
      cat === "accommodation" &&
      g.some((x) => x === "bookings" || x === "calls")
        ? "HIGH"
        : cat === "food"
          ? goals.includes("visits")
            ? "MEDIUM"
            : "LOW"
          : cat === "experience"
            ? "LOW"
            : "MEDIUM";
    opportunities.push({
      key,
      category: cat,
      name,
      state: a.state,
      stateReason: a.reason,
      why:
        cat === "accommodation"
          ? `${quote(o.label)} is what guests book. A page about it lets people see what they would book${g.length ? ` and supports the approved goals: ${goalNames(g)}` : ""}.`
          : cat === "food"
            ? `A page for the ${o.label.toLowerCase()} lets visitors find what it offers and when${g.length ? `, supporting ${goalNames(g)}` : ""}.`
            : cat === "experience"
              ? `${quote(o.label)} is an approved experience or event. Describing it clearly helps guests choose their stay${g.length ? `, supporting ${goalNames(g)}` : ""}.`
              : `${quote(o.label)} is an approved offering. A page about it lets people find and understand it${g.length ? `, supporting ${goalNames(g)}` : ""}.`,
      facts: [o.fact],
      goals: g,
      considered: a.considered,
      slug,
      topic: place ? `${o.label} in the ${place} area` : o.label,
      intent:
        cat === "accommodation"
          ? "People choosing and booking a place to stay."
          : cat === "food"
            ? "People looking for somewhere to eat or drink nearby."
            : cat === "experience"
              ? "Guests choosing what to do during their stay."
              : "People looking for this service and how to get it.",
      outline: outline.filter((x): x is string => !!x),
      assumptions,
      priority,
      priorityReason:
        priority === "HIGH"
          ? `The main offering, and it supports approved goals (${goalNames(g)}).`
          : cat === "food" && priority === "LOW"
            ? "Secondary offering; no approved goal of visits."
            : cat === "experience"
              ? "An experience or event: it supports a stay rather than being booked on its own."
              : `An approved offering${g.length ? ` supporting ${goalNames(g)}` : ""}.`,
      confidence: a.state === "confirmed" ? "medium" : "low",
      confidenceReason:
        a.state === "confirmed"
          ? "The crawl is complete and recent, and no analysed page names it in a title, heading, description, link, structured data or main content."
          : a.reason,
      effort: cat === "food" ? "medium" : "large",
      effortReason:
        cat === "food"
          ? "A short page with confirmed hours and what is served."
          : "A new page with real content and photos.",
      verification: `Confirmed when a later crawl finds an indexable page, other than the home page, whose title or main heading names ${quote(o.label)} and whose main content (without header, navigation or footer) has at least ${SEO_LIMITS.thinContentWords} words and mentions ${quote(o.label)}.`,
      fulfilledBy: a.fulfilledBy,
      decision: decisionOf(key),
      recommend: false,
    });
  }

  // Facilities: one page for several, never one page per facility.
  if (facilityOfferings.length) {
    const key = "Add a facilities page (BIZ_FACILITIES_PAGE)";
    const labels = facilityOfferings.map((o) => o.label);
    const matches = facilityOfferings.flatMap((o) =>
      input.matchesFor({
        kind: "SERVICE",
        value: o.label,
        synonyms: o.wordings.slice(1),
      }),
    );
    let a = assess(matches, notHomeUnlessOnly, {
      mentionIsGap: false,
      slug: "/facilities/",
      wordings: facilityOfferings.flatMap((o) =>
        o.wordings.flatMap((w) => phrases({ value: w, synonyms: [] })),
      ),
      label: "the facilities",
    });
    // Facilities help people decide, but rarely need a page of their own:
    // never a confirmed gap, always a decision for a person.
    if (a.state === "confirmed")
      a = {
        ...a,
        state: "review",
        reason:
          facilityOfferings.length < 2
            ? "Only one approved facility; mention it on the accommodation page instead of a page of its own."
            : `${a.reason} Facilities usually belong on the accommodation page; a page of its own helps only with enough distinct detail (what is included, when, any charges).`,
      };
    opportunities.push({
      key,
      category: "facilities",
      name: "Facilities",
      state: a.state,
      stateReason: a.reason,
      why: `Approved facilities (${listOf(labels.map(quote))}) help people decide before they book.`,
      facts: [...new Set(facilityOfferings.map((o) => o.fact))],
      goals: supported("facilities"),
      considered: a.considered,
      slug: "/facilities/",
      topic: place ? `Facilities in the ${place} area` : "Facilities",
      intent: "People checking what is available before they book.",
      outline: [
        `The approved facilities: ${listOf(labels.map(quote))}.`,
        ...constraintLines,
        "Link to it from the accommodation page.",
      ],
      assumptions: [
        "Only the approved facilities are listed; confirm details such as times or charges first.",
      ],
      priority: "LOW",
      priorityReason: "Supporting information, not the main offering.",
      confidence: a.state === "confirmed" ? "medium" : "low",
      confidenceReason:
        a.state === "confirmed"
          ? "The crawl is complete and recent; body text is not stored."
          : a.reason,
      effort: "medium",
      effortReason: "A short page listing the approved facilities.",
      verification:
        "Confirmed when a later crawl finds an indexable page, other than the home page, whose title or main heading names the facilities and whose main content has at least 200 words and mentions them.",
      fulfilledBy: a.fulfilledBy,
      decision: decisionOf(key),
      recommend: false,
    });
  }

  // Location pages and the contact path come from the coverage needs, so
  // they keep the identities they already have.
  for (const n of input.needs) {
    if (n.kind !== "location-page" && n.kind !== "contact-path") continue;
    const contact = n.kind === "contact-path";
    const cat: OpportunityCategory = contact ? "contact" : "location";
    const g = supported(cat);
    const label = contact ? null : n.facts[0].value;
    const slug = contact
      ? "/contact/"
      : `/locations/${slugify(label!.split(",")[0])}/`;
    const a = assess(
      n.matches,
      (m, p) =>
        contact
          ? p.type === "contact" || m.where.includes("contact page")
          : // A location's own page, not a home, contact or service page
            // that names the place (same rule as coverage).
            m.strength === "strong" &&
            (p.type === "location" ||
              (p.type === "unknown" &&
                m.where.some((w) => w === "title" || w === "main heading"))),
      {
        contact,
        mentionIsGap: !contact,
        slug,
        wordings: contact ? undefined : phrases(n.facts[0] as Fact),
        label: label ?? undefined,
      },
    );
    // A contact link to a real page counts as the path being there.
    const linked = contact && n.status === "covered" && a.state !== "fulfilled";
    let state: OpportunityState = linked ? "fulfilled" : a.state;
    let reason = linked ? n.note : a.reason;
    if (contact && state === "confirmed") {
      // Phone, email, WhatsApp links or a contact form already let people
      // get in touch; a separate page is then a choice, not a gap. Crawls
      // stored before these were detected cannot tell, so they ask too.
      const withSignals = pages.filter(
        (p) =>
          p.contact &&
          p.contact.tel +
            p.contact.mailto +
            p.contact.whatsapp +
            p.contact.forms >
            0,
      );
      if (withSignals.length) {
        const first = withSignals.find((p) => p.isHome) ?? withSignals[0];
        state = "review";
        reason = `${first.isHome ? "The home page" : first.url} already has ${contactSummary(first.contact!)}, so people can get in touch. A separate contact page is optional: consider it for booking details and directions.`;
      } else if (pages.length && pages.every((p) => p.contact === null)) {
        state = "review";
        reason =
          "This crawl predates detection of phone, email and WhatsApp links and contact forms, so it cannot tell whether the site already has a way to get in touch. Crawl again to check.";
      }
    }
    opportunities.push({
      key: n.key,
      category: cat,
      name: contact ? "Contact and booking" : `Location: ${label}`,
      state,
      stateReason: reason,
      why: contact
        ? `The approved goals (${goalNames(goals.filter((x) => GOALS_FOR.contact.includes(x)))}) need an obvious way to get in touch${goals.includes("visits") ? " and find the premises" : ""}.`
        : `${quote(label!)} is an approved location; with several locations each usually has its own page.`,
      facts: n.facts,
      goals: g,
      considered: a.considered,
      slug,
      topic: contact
        ? "Contact, booking and directions"
        : `${label!.split(",")[0]}`,
      intent: contact
        ? "People ready to call, book or visit."
        : "People looking for this location.",
      outline: (contact
        ? [
            "Phone number and email, written out (not only in images).",
            goals.includes("bookings")
              ? "How to book, and what happens next."
              : null,
            goals.includes("visits") && locationLine
              ? `${locationLine} Add directions and a map.`
              : null,
            ...constraintLines,
            "Link to it from the main navigation, labelled “Contact”.",
          ]
        : [
            locationLine,
            "What is offered at this location, and opening hours once confirmed.",
            ...constraintLines,
          ]
      ).filter((x): x is string => !!x),
      assumptions: contact
        ? [
            "Phone number, email and booking method are not stored as facts; use the business's real details.",
          ]
        : [
            "Opening hours and what is offered at this location are not in the approved facts.",
          ],
      priority: "MEDIUM",
      priorityReason: contact
        ? "Every approved goal depends on people being able to get in touch."
        : "An approved location of a multi-location business.",
      confidence: state === "confirmed" ? "medium" : "low",
      confidenceReason:
        state === "confirmed"
          ? contact
            ? "No contact page, contact link, phone, email or WhatsApp link, or contact form was found on the analysed pages; page body text is not stored."
            : "The crawl is complete and recent; body text is not stored."
          : linked
            ? n.note
            : a.reason,
      effort: contact ? "medium" : "large",
      effortReason: contact
        ? "A new page or a navigation change."
        : "A new page with location-specific content.",
      verification: contact
        ? "Confirmed when a later crawl finds a contact page or a link labelled “Contact”, “Book” or similar."
        : `Confirmed when a later crawl finds an indexable page, other than the home page, whose title, main heading or structured address names ${quote(label!)} and whose main content has at least ${SEO_LIMITS.thinContentWords} words and mentions it.`,
      fulfilledBy: linked ? (n.matches[0]?.url ?? null) : a.fulfilledBy,
      decision: decisionOf(n.key),
      recommend: false,
    });
  }

  // Too many new pages at once makes thin content likely: keep the most
  // important ones and hold the rest for review.
  const ORDER: RecommendationPriority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const confirmed = opportunities
    .filter((o) => o.state === "confirmed")
    .sort((a, b) => ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority));
  for (const o of confirmed.slice(MAX_CONFIRMED)) {
    o.state = "review";
    o.stateReason = `${o.stateReason} Held for review: at most ${MAX_CONFIRMED} new pages are suggested at a time.`;
  }
  for (const o of opportunities) {
    // Facts the client did not supply are our understanding of the business:
    // the first thing to confirm before writing a page that relies on them.
    const unconfirmed = unconfirmedFactsNote(o.facts);
    if (unconfirmed) o.assumptions.unshift(unconfirmed);
    o.recommend =
      o.decision !== "dismissed" &&
      (o.state === "confirmed" ||
        (o.decision === "accepted" &&
          o.state !== "fulfilled" &&
          o.state !== "unsupported"));
  }
  return { opportunities, clarifications };
}
