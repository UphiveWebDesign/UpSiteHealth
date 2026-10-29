import type { BusinessType } from "@/lib/knowledge/catalogue";
import {
  dimensionFreshness,
  type DimensionFreshness,
} from "@/lib/scoring/freshness";
import { factMatches, type CoverageCrawl } from "./coverage";
import {
  approved,
  approvedTypes,
  normalizeFactValue,
  type Fact,
} from "./facts";
import {
  matchPage,
  phrases,
  RANK,
  type PageMatch,
  type Strength,
} from "./match";
import { excludedBy, offeringsOf, sufficiency } from "./opportunities";
import { containsPhrase, words, type UnderstoodPage } from "./pages";

/**
 * Topic map: the topics a business's approved facts call for, and which
 * crawled page (if any) serves each one. Deterministic and read-only: it
 * creates no findings, tasks or score changes.
 *
 * - Only APPROVED facts are used. A topic per approved service (compound
 *   hospitality offerings split as page opportunities split them), and a
 *   service × location variant only when the business has its own page per
 *   location (several approved locations, or the multi-location type), as
 *   coverage expects. One location is context, not a variant.
 * - Audiences are listed on every topic; they never create topics (the data
 *   model does not link an audience to a service).
 * - An approved "not offered" fact naming a topic suppresses it.
 * - Matching is coverage's (`factMatches`): approved wordings only, the site
 *   name removed, legal pages, blog posts and a multi-service home page only
 *   ever mention a service, noindex and canonicalised pages one level lower.
 * - "none" only on a complete, recent, fresh crawl that could not have
 *   missed the page; otherwise "not-checked". Covered and partial mappings
 *   always cite a page of the analysed crawl.
 *
 * Bump TOPIC_VERSION when a rule changes meaning.
 */
export const TOPIC_VERSION = "t1";
export const MAX_TOPICS = 50;
/** Pages cited per topic. */
const MAX_EVIDENCE = 5;

export type TopicState =
  /** A page is about it (strong match), indexable, with enough main content. */
  | "covered"
  /** Pages mention it, or a page about it is thin, noindex or canonicalised. */
  | "partial"
  /** No page serves it, on complete, recent evidence. */
  | "none"
  /** The evidence cannot tell (no crawl, or partial, limited or stale). */
  | "not-checked";

export type TopicEvidence = {
  /** A page of the analysed crawl. */
  url: string;
  strength: Strength;
  /** Where the service matched ("title", "main heading" …). */
  where: string[];
  /** Where the location matched, for service × location topics. */
  locationWhere: string[] | null;
  /** The approved wordings found on the page. */
  matched: string[];
  /** Why it covers the topic or only partly. */
  verdict: string;
};

type FactRef = Pick<Fact, "id" | "kind" | "value" | "source">;

export type Topic = {
  /** Stable identity: normalised service (and location) wording. */
  key: string;
  label: string;
  service: string;
  location: string | null;
  /** Approved facts behind it. */
  facts: FactRef[];
  /** The service's approved wordings searched for: its name, then the others sorted. */
  wordings: string[];
  /** The location's approved wordings (empty for a service topic). */
  locationWordings: string[];
  /** Approved audiences, as context for the topic. */
  audiences: FactRef[];
  state: TopicState;
  reason: string;
  /** Best pages first; empty when nothing matched. */
  evidence: TopicEvidence[];
  /** Pages that matched in all (evidence lists at most 5). */
  pagesMatched: number;
};

export type TopicCrawl = Pick<
  CoverageCrawl,
  "analyzedAt" | "status" | "analysedPages" | "complete" | "gap" | "limits"
> & {
  /** The crawl run's id; null when the loader did not provide it. */
  id: string | null;
  /** The crawl's age against EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO. */
  freshness: DimensionFreshness;
};

export type TopicMap = {
  version: string;
  crawl: TopicCrawl | null;
  topics: Topic[];
  /** Topics beyond MAX_TOPICS, not mapped. */
  omitted: number;
  /** Topics an approved "not offered" fact suppressed. */
  suppressed: Array<{ label: string; by: string }>;
  /** Why service × location topics were or were not created. */
  locationNote: string | null;
};

const ref = (f: Fact): FactRef => ({
  id: f.id,
  kind: f.kind,
  value: f.value,
  source: f.source,
});
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const quote = (s: string) => `“${s}”`;
const weaker = (a: Strength, b: Strength): Strength =>
  RANK[a] >= RANK[b] ? a : b;

/** The name first, then the other wordings by normalised text, no repeats. */
function sortedWordings(name: string, others: string[]): string[] {
  const seen = new Set([normalizeFactValue(name)]);
  const rest = [...others]
    .sort((a, b) => normalizeFactValue(a).localeCompare(normalizeFactValue(b)))
    .filter((w) => {
      const k = normalizeFactValue(w);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return [name, ...rest];
}

type Draft = {
  key: string;
  label: string;
  service: string;
  location: Fact | null;
  facts: Fact[];
  wordings: string[];
};

/** Service offerings from approved facts, merged by wording, sorted. */
function serviceDrafts(services: Fact[], types: BusinessType[]): Draft[] {
  const byKey = new Map<string, Draft>();
  for (const f of services)
    for (const o of offeringsOf(f, types).offerings) {
      const key = `service:${normalizeFactValue(o.label)}`;
      const d = byKey.get(key);
      if (d) {
        if (!d.facts.includes(f)) d.facts.push(f);
        for (const w of o.wordings)
          if (!d.wordings.includes(w)) d.wordings.push(w);
      } else
        byKey.set(key, {
          key,
          label: o.label,
          service: o.label,
          location: null,
          facts: [f],
          wordings: [...o.wordings],
        });
    }
  return [...byKey.values()]
    .map((d) => ({
      ...d,
      facts: [...d.facts].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Analyses which pages serve the topics of the approved facts. */
export function buildTopicMap(input: {
  /** All facts of the website; only approved ones are used. */
  facts: Fact[];
  /** The analysed, classified pages (CoverageResult.pages). */
  pages: UnderstoodPage[];
  /** The analysed crawl (CoverageResult.crawl); null when there is none. */
  crawl: CoverageCrawl | null;
  /** The crawl run's id from the evidence loader; never guessed. */
  crawlId: string | null;
  /** Crawled URLs that returned an error (they may be the topic's page). */
  errorPages?: Array<{ url: string; httpStatus: number | null }>;
  now: Date;
}): TopicMap {
  const { pages, crawl, now } = input;
  const ok = approved(input.facts);
  const of = (k: Fact["kind"]) =>
    ok
      .filter((f) => f.kind === k)
      .sort(
        (a, b) =>
          normalizeFactValue(a.value).localeCompare(
            normalizeFactValue(b.value),
          ) || a.id.localeCompare(b.id),
      );
  const services = of("SERVICE");
  const locations = of("LOCATION");
  const excluded = of("EXCLUDED");
  const audiences = of("AUDIENCE").map(ref);
  const types = approvedTypes(ok);

  const suppressed: TopicMap["suppressed"] = [];
  const base = serviceDrafts(services, types).filter((d) => {
    const ex = excludedBy(excluded, d.wordings);
    if (ex) suppressed.push({ label: d.label, by: ex.value });
    return !ex;
  });

  const variantsWanted =
    locations.length > 1 || types.includes("multi-location");
  const variants: Draft[] = [];
  if (variantsWanted)
    for (const d of base)
      for (const l of locations) {
        const label = `${d.service} in ${l.value}`;
        // "Not offered" may name the pair ("Cottages in Manali") or the place.
        const combined = d.wordings.flatMap((s) =>
          [l.value, ...l.synonyms].map((p) => `${s} in ${p}`),
        );
        const ex = excludedBy(excluded, combined);
        if (ex) {
          suppressed.push({ label, by: ex.value });
          continue;
        }
        variants.push({
          key: `${d.key}|location:${normalizeFactValue(l.value)}`,
          label,
          service: d.service,
          location: l,
          facts: [...d.facts, l],
          wordings: d.wordings,
        });
      }
  variants.sort((a, b) => a.key.localeCompare(b.key));
  const all = [...base, ...variants];
  const drafts = all.slice(0, MAX_TOPICS);

  const freshness = crawl
    ? // The crawl is technical SEO evidence: same limit and states. The
      // score is irrelevant here; it only marks the evidence as measured.
      dimensionFreshness(
        {
          dimension: "TECHNICAL_SEO",
          measured: true,
          score: 0,
          sourceTimestamp: crawl.analyzedAt.toISOString(),
          evidence: { crawlStatus: crawl.status },
        },
        now,
      )
    : null;
  // A negative conclusion needs the whole site checked, recently.
  const canConclude = !!crawl && !crawl.gap && freshness?.state === "fresh";
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const serviceCount = services.length;

  // Which approved wordings a page shows (coverage's rules for legal pages).
  const wordingsOn = (
    p: UnderstoodPage,
    kind: Fact["kind"],
    wordings: string[],
  ) =>
    wordings.filter(
      (w) =>
        !!matchPage(
          p,
          { kind, value: w, synonyms: [] },
          { body: p.type !== "legal" },
        ),
    );
  const namedInPath = (url: string, wordings: string[]) => {
    const path = words(new URL(url).pathname.replace(/[-_/.]+/g, " "));
    return wordings.some((w) =>
      phrases({ value: w, synonyms: [] }).some((ph) =>
        containsPhrase(path, ph),
      ),
    );
  };

  const topics = drafts.map((d): Topic => {
    const serviceFact = {
      kind: "SERVICE" as const,
      value: d.wordings[0],
      synonyms: d.wordings.slice(1),
    };
    const serviceMatches = factMatches(pages, serviceFact, serviceCount, {
      body: true,
    });
    let matches: Array<PageMatch & { locationWhere: string[] | null }> =
      serviceMatches.map((m) => ({ ...m, locationWhere: null }));
    if (d.location) {
      const at = new Map(
        factMatches(pages, d.location, serviceCount, { body: true }).map(
          (m) => [m.url, m],
        ),
      );
      matches = serviceMatches.flatMap((m) => {
        const l = at.get(m.url);
        return l
          ? [
              {
                ...m,
                strength: weaker(m.strength, l.strength),
                note: m.note ?? l.note,
                locationWhere: l.where,
              },
            ]
          : [];
      });
      matches.sort(
        (a, b) =>
          RANK[a.strength] - RANK[b.strength] || a.url.localeCompare(b.url),
      );
    }

    const evidence = matches.map(
      (m): TopicEvidence & { fulfils: boolean; lacking: string | null } => {
        const p = byUrl.get(m.url)!;
        const lacking =
          m.strength === "strong"
            ? sufficiency(p, {
                wordings: d.wordings.flatMap((w) =>
                  phrases({ value: w, synonyms: [] }),
                ),
                label: d.service,
              })
            : null;
        const where = [
          ...m.where,
          ...(m.locationWhere ?? []).map((w) => `${w} (location)`),
        ].join(", ");
        return {
          url: m.url,
          strength: m.strength,
          where: m.where,
          locationWhere: m.locationWhere,
          matched: [
            ...wordingsOn(p, "SERVICE", d.wordings),
            ...(d.location
              ? wordingsOn(p, "LOCATION", [
                  d.location.value,
                  ...d.location.synonyms,
                ])
              : []),
          ],
          fulfils: m.strength === "strong" && !lacking,
          lacking,
          verdict:
            m.strength !== "strong"
              ? `Mentions it (${where}) but is not about it.${m.note ? ` ${m.note}` : ""}`
              : lacking
                ? `About it (${where}), but ${lacking}.`
                : `About it (${where}), with enough main content.`,
        };
      },
    );
    const cited = [
      ...evidence.filter((e) => e.fulfils),
      ...evidence.filter((e) => !e.fulfils),
    ]
      .slice(0, MAX_EVIDENCE)
      .map(({ fulfils: _, lacking: __, ...e }) => e);
    const covering = evidence.filter((e) => e.fulfils);

    let state: TopicState;
    let reason: string;
    if (!crawl) {
      state = "not-checked";
      reason = "No analysed crawl yet, so no page could be checked.";
    } else if (covering.length) {
      state = "covered";
      // Several pages may serve it on purpose (a service page and its
      // location pages), so no competition is claimed here.
      reason =
        covering.length === 1
          ? `Covered by ${covering[0].url}.`
          : `Covered by ${covering[0].url} and ${plural(covering.length - 1, "other page")}.`;
    } else if (evidence.length) {
      state = "partial";
      const about = evidence.find((e) => e.lacking);
      reason = about
        ? `${about.url} is about it, but ${about.lacking}.`
        : `${plural(evidence.length, "page")} ${evidence.length === 1 ? "mentions" : "mention"} it, but none is about it.`;
    } else {
      const wordings = [
        ...d.wordings,
        ...(d.location ? [d.location.value, ...d.location.synonyms] : []),
      ];
      const unchecked = crawl.unchecked.find((u) =>
        namedInPath(u.url, d.wordings),
      );
      const broken = (input.errorPages ?? []).find((e) =>
        namedInPath(e.url, d.wordings),
      );
      // The wordings looked for, when they say more than the label.
      const also =
        wordings.length === 1 && wordings[0] === d.label
          ? ""
          : ` (${wordings.map(quote).join(", ")})`;
      const searched = `No analysed page names ${quote(d.label)}${also}.`;
      if (unchecked) {
        state = "not-checked";
        reason = `${searched} ${unchecked.url} may be about it but was ${unchecked.reason === "robots-blocked" ? "blocked by robots.txt" : "not fetched"}.`;
      } else if (broken) {
        state = "not-checked";
        reason = `${searched} ${broken.url} may be about it but returns HTTP ${broken.httpStatus ?? "error"}.`;
      } else if (!canConclude) {
        state = "not-checked";
        reason = `${searched} ${crawl.gap ?? freshness?.reason ?? ""}`.trim();
      } else {
        state = "none";
        reason = `${searched} The crawl completed within its limits.`;
      }
    }

    return {
      key: d.key,
      label: d.label,
      service: d.service,
      location: d.location?.value ?? null,
      facts: d.facts.map(ref),
      wordings: sortedWordings(d.service, d.wordings),
      locationWordings: d.location
        ? sortedWordings(d.location.value, d.location.synonyms)
        : [],
      audiences,
      state,
      reason,
      evidence: cited,
      pagesMatched: evidence.length,
    };
  });

  return {
    version: TOPIC_VERSION,
    crawl:
      crawl && freshness
        ? {
            id: input.crawlId,
            analyzedAt: crawl.analyzedAt,
            status: crawl.status,
            analysedPages: crawl.analysedPages,
            complete: crawl.complete,
            gap: crawl.gap,
            limits: crawl.limits,
            freshness,
          }
        : null,
    topics,
    omitted: all.length - drafts.length,
    suppressed,
    locationNote: !locations.length
      ? null
      : variantsWanted
        ? `Each service is also mapped per location: the business has ${locations.length > 1 ? plural(locations.length, "approved location") : "the multi-location type"}.`
        : "One approved location: it is context for every topic, not a topic of its own.",
  };
}
