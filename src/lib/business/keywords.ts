import { factMatches } from "./coverage";
import { approved, normalizeFactValue, type Fact } from "./facts";
import { phrases, type PageMatch } from "./match";
import { sufficiency } from "./opportunities";
import { words, type UnderstoodPage } from "./pages";
import type { Topic, TopicCrawl, TopicMap } from "./topics";

/**
 * Keyword candidates (Sprint 2, objective 2, stage A): the search terms the
 * approved business facts suggest, mapped to the crawled page that serves
 * them. Provider-neutral and read-only: nothing is measured, so there is no
 * search volume, ranking or traffic here, and nothing becomes a finding or
 * a task.
 *
 * - Candidates come only from approved wordings (a fact's value and the
 *   other wordings a person entered): each service wording, and for
 *   service × location topics each service wording followed by each
 *   location wording. No modifiers ("near me", "best", "cheap") are added.
 *   A location wording of more than MAX_PLACE_WORDS words is an address,
 *   not a search term, and is not combined (its shorter wordings are).
 * - Identity is the normalised text (`kw:boiler repair york`), so the order
 *   of facts or wordings never changes it. At most MAX_CANDIDATES, service
 *   candidates first, then combinations, in topic order.
 * - Mapping follows the topic map: "mapped" only to a page that covers the
 *   topic (about it, indexable, enough main content); a page that only
 *   mentions it is "weak"; "unmapped" only on a complete, recent crawl;
 *   otherwise "not-checked".
 * - Possible overlap: two or more pages, each about the same candidate
 *   (named in the title, main heading or structured data, indexable, not
 *   canonicalised elsewhere, enough main content). Excluded: the home page,
 *   legal pages, and for a service candidate any page whose title or main
 *   heading names an approved location (a location page for that service
 *   serves the service-and-location candidate instead). Never a finding.
 *
 * Bump KEYWORD_VERSION when a rule changes meaning.
 */
export const KEYWORD_VERSION = "kw1";
export const MAX_CANDIDATES = 100;
export const MAX_PLACE_WORDS = 4;

export type MappingState = "mapped" | "weak" | "unmapped" | "not-checked";

export type KeywordSource = {
  factId: string;
  kind: Fact["kind"];
  /** The approved wording used, as entered. */
  wording: string;
  /** The fact's name, or another wording a person entered for it. */
  isName: boolean;
  source: Fact["source"];
  /** When a person approved the fact; null when not loaded. */
  approvedAt: Date | null;
};

export type KeywordMapping = {
  state: MappingState;
  reason: string;
  /** The page that serves it ("mapped" only). */
  page: string | null;
  /** Where the topic matched on that page. */
  where: string[];
  /** Whether this exact wording appears on that page (null: no page). */
  wordingOnPage: boolean | null;
  /** Pages that only mention it ("weak" only). */
  mentions: string[];
};

export type KeywordCandidate = {
  key: string;
  text: string;
  kind: "service" | "service-location";
  topicKey: string;
  topicLabel: string;
  from: KeywordSource[];
  /** Always false in stage A: no search data is measured. */
  measured: false;
  mapping: KeywordMapping;
};

export type KeywordOverlap = {
  topicKey: string;
  /** Candidates that the same pages are each about. */
  candidates: string[];
  pages: Array<{ url: string; where: string[] }>;
  reason: string;
};

export type KeywordMap = {
  version: string;
  crawl: TopicCrawl | null;
  candidates: KeywordCandidate[];
  /** Candidates beyond MAX_CANDIDATES, not listed. */
  omitted: number;
  /** Location wordings too long to be search terms (addresses). */
  addresses: string[];
  overlaps: KeywordOverlap[];
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const keyOf = (text: string) => `kw:${words(text).join(" ")}`;
const same = (a: string, b: string) =>
  normalizeFactValue(a) === normalizeFactValue(b);
const prominent = (m: PageMatch | undefined) =>
  !!m &&
  m.strength === "strong" &&
  m.where.some((w) => w === "title" || w === "main heading");

/** Builds keyword candidates and their mapping from a topic map. */
export function buildKeywordMap(input: {
  /** All facts of the website; only approved ones are used. */
  facts: Fact[];
  /** The topic map of the same facts and crawl. */
  map: TopicMap;
  /** The classified pages the topic map was built from. */
  pages: UnderstoodPage[];
}): KeywordMap {
  const { map, pages } = input;
  const ok = approved(input.facts);
  const byId = new Map(ok.map((f) => [f.id, f]));
  const services = ok.filter((f) => f.kind === "SERVICE");
  const locations = ok.filter((f) => f.kind === "LOCATION");
  const conclusive =
    !!map.crawl && !map.crawl.gap && map.crawl.freshness.state === "fresh";
  const addresses = new Set<string>();

  // The approved fact a wording comes from (a split hospitality offering
  // keeps its label as the name of its fact).
  const sourceOf = (
    t: Topic,
    kind: "SERVICE" | "LOCATION",
    wording: string,
    isName: boolean,
  ): KeywordSource | null => {
    const facts = t.facts
      .filter((f) => f.kind === kind)
      .map((f) => byId.get(f.id))
      .filter((f): f is Fact => !!f);
    const f =
      facts.find(
        (x) =>
          same(x.value, wording) || x.synonyms.some((s) => same(s, wording)),
      ) ?? facts[0];
    return f
      ? {
          factId: f.id,
          kind,
          wording,
          isName,
          source: f.source,
          approvedAt: f.reviewedAt ?? null,
        }
      : null;
  };

  const mappingOf = (t: Topic, wordings: string[]): KeywordMapping => {
    const none = { page: null, where: [], wordingOnPage: null, mentions: [] };
    if (t.state === "covered") {
      const e = t.evidence[0];
      return {
        state: "mapped",
        reason: `Served by ${e.url}, the page about “${t.label}”.`,
        page: e.url,
        where: [
          ...e.where,
          ...(e.locationWhere ?? []).map((w) => `${w} (location)`),
        ],
        wordingOnPage: wordings.every((w) => e.matched.some((m) => same(m, w))),
        mentions: [],
      };
    }
    if (t.state === "partial")
      return {
        ...none,
        state: "weak",
        reason: `No page serves it sufficiently: ${t.reason}`,
        mentions: t.evidence.map((e) => e.url),
      };
    // Reasons name the service (and location) without the topic label,
    // which can be a whole address.
    const what =
      t.location === null
        ? "this service"
        : "this service together with this location";
    if (t.state === "none" && conclusive)
      return {
        ...none,
        state: "unmapped",
        reason: `No page names ${what}, on a complete, recent crawl.`,
      };
    // A page-specific cause (a blocked or broken URL) is kept as given.
    if (!map.crawl || !conclusive)
      return {
        ...none,
        state: "not-checked",
        reason: map.crawl
          ? `No page found that names ${what}, but this crawl cannot confirm a gap: ${map.crawl.gap ?? map.crawl.freshness.reason}`
          : "No analysed crawl yet.",
      };
    return { ...none, state: "not-checked", reason: t.reason };
  };

  const all: KeywordCandidate[] = [];
  const seen = new Set<string>();
  const add = (
    t: Topic,
    text: string,
    kind: KeywordCandidate["kind"],
    from: Array<KeywordSource | null>,
    wordings: string[],
  ) => {
    const key = keyOf(text);
    if (key === "kw:" || seen.has(key)) return;
    seen.add(key);
    all.push({
      key,
      text,
      kind,
      topicKey: t.key,
      topicLabel: t.label,
      from: from.filter((x): x is KeywordSource => !!x),
      measured: false,
      mapping: mappingOf(t, wordings),
    });
  };
  // Service candidates first, then combinations (the topic map lists
  // service topics before service × location topics).
  for (const t of map.topics) {
    if (t.location === null) {
      t.wordings.forEach((w, i) =>
        add(t, w, "service", [sourceOf(t, "SERVICE", w, i === 0)], [w]),
      );
      continue;
    }
    t.wordings.forEach((sw, i) =>
      t.locationWordings.forEach((lw, j) => {
        if (words(lw).length > MAX_PLACE_WORDS) {
          addresses.add(lw);
          return;
        }
        add(
          t,
          `${sw} ${lw}`,
          "service-location",
          [
            sourceOf(t, "SERVICE", sw, i === 0),
            sourceOf(t, "LOCATION", lw, j === 0),
          ],
          [sw, lw],
        );
      }),
    );
  }
  const candidates = all.slice(0, MAX_CANDIDATES);

  // Possible overlap: pages that are each about the exact candidate.
  const overlaps = new Map<string, KeywordOverlap>();
  const serviceCount = services.length;
  const eligible = pages.filter(
    (p) =>
      !p.isHome && !p.noindex && !p.canonicalElsewhere && p.type !== "legal",
  );
  const strongAt = (kind: "SERVICE" | "LOCATION", wording: string) =>
    new Map(
      factMatches(
        eligible,
        { kind, value: wording, synonyms: [] },
        serviceCount,
      ).map((m) => [m.url, m]),
    );
  const placeWordings = locations.flatMap((l) => [l.value, ...l.synonyms]);
  for (const c of map.crawl ? candidates : []) {
    const [sw, lw] = [c.from[0]?.wording, c.from[1]?.wording];
    if (!sw) continue;
    const service = strongAt("SERVICE", sw);
    const place = lw ? strongAt("LOCATION", lw) : null;
    const about = eligible.filter((p) => {
      const m = service.get(p.url);
      if (m?.strength !== "strong") return false;
      if (place && !prominent(place.get(p.url))) return false;
      // A page about the service in one place serves that combination.
      if (
        !place &&
        placeWordings.some((w) =>
          prominent(
            factMatches(
              [p],
              { kind: "LOCATION", value: w, synonyms: [] },
              0,
            )[0],
          ),
        )
      )
        return false;
      return !sufficiency(p, {
        wordings: [sw, ...(lw ? [lw] : [])].flatMap((w) =>
          phrases({ value: w, synonyms: [] }),
        ),
        label: c.text,
      });
    });
    if (about.length < 2) continue;
    const urls = about.map((p) => p.url).sort();
    const id = `${c.topicKey}|${urls.join("|")}`;
    const o = overlaps.get(id);
    if (o) o.candidates.push(c.text);
    else
      overlaps.set(id, {
        topicKey: c.topicKey,
        candidates: [c.text],
        pages: urls.map((url) => ({
          url,
          where: [
            ...(service.get(url)?.where ?? []),
            ...(place?.get(url)?.where ?? []).map((w) => `${w} (location)`),
          ],
        })),
        reason: `${plural(urls.length, "page")} are each about it (named in the title, main heading or structured data, indexable, with enough main content). Whether they compete in search is not measured.`,
      });
  }

  return {
    version: KEYWORD_VERSION,
    crawl: map.crawl,
    candidates,
    omitted: all.length - candidates.length,
    addresses: [...addresses].sort(),
    overlaps: [...overlaps.values()],
  };
}
