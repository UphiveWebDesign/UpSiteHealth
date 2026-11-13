import type { EvidencePage } from "@/lib/integrations/evaluate";
import { phrases } from "./match";
import {
  containsPhrase,
  withoutPhrases,
  words,
  type UnderstoodPage,
} from "./pages";
import type { TopicMap } from "./topics";

/**
 * Internal-link opportunities for covered service topics, from what the
 * crawler stores per page: its distinct internal links (target URL, anchor
 * text, nofollow) and, separately, its main content. Links are not marked as
 * navigation or content, so this claims nothing it cannot show:
 *
 * - An opportunity is a page whose MAIN CONTENT names the service (an
 *   approved wording, site name removed) but which has NO link at all to the
 *   page that covers the service. A page linking to it anywhere (menu,
 *   footer, text) is never an opportunity; neither is a page whose link list
 *   was cut at the crawler's limit (the link may be among the dropped ones),
 *   the target itself, a legal page, or a noindex or canonicalised page.
 * - A link counts when it points at the target or at a URL the crawl saw
 *   redirect to it (trailing slashes ignored); nofollow links count as links.
 * - "Poorly connected": the target is linked from at most one other analysed
 *   page and is not linked site-wide. Site-wide means from at least two pages
 *   and at least half of the analysed pages (menus and footers), the same
 *   heuristic as repeated template text (`repeatedBlocks`).
 * - Only on a complete, recent crawl (the topic map's own condition), and
 *   only for topics the map found covered. Nothing is inferred about search
 *   demand or rankings.
 *
 * Bump LINK_VERSION when a rule changes meaning.
 */
export const LINK_VERSION = "l1";
/** Source pages listed per topic. */
export const MAX_SOURCES = 5;

export type LinkSource = {
  url: string;
  /** The main-content passage that names the service, shortened. */
  passage: string;
};

export type LinkOpportunity = {
  topicKey: string;
  label: string;
  /** The page that covers the topic. */
  target: string;
  /** Other analysed pages that link to the target. */
  inboundPages: number;
  /** Linked from at least half of the analysed pages (menus, footers). */
  linkedSiteWide: boolean;
  poorlyConnected: boolean;
  /** Pages that name the service but do not link to the target (best first). */
  sources: LinkSource[];
  /** All such pages (sources lists at most MAX_SOURCES). */
  sourcesTotal: number;
};

const trim = (u: string) => u.replace(/\/+$/, "") || u;
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const clip = (s: string, n = 140) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/** Outbound internal links of one analysed page; null when its list was cut. */
function outbound(
  p: EvidencePage,
  final: Map<string, string>,
): Set<string> | null {
  const r = record(p.result);
  if (!r) return null;
  if (typeof r.linksOmitted === "number" && r.linksOmitted > 0) return null;
  const out = new Set<string>();
  for (const l of Array.isArray(r.links) ? r.links : []) {
    const link = record(l);
    if (link?.type !== "internal" || typeof link.url !== "string") continue;
    const u = trim(link.url);
    out.add(final.get(u) ?? u);
  }
  out.delete(trim(p.url));
  return out;
}

export function linkOpportunities(input: {
  map: TopicMap;
  /** The crawl's understood pages (`analyzeCoverage(...).pages`). */
  pages: UnderstoodPage[];
  /** The same crawl's stored pages (links, redirects). */
  raw: EvidencePage[];
}): LinkOpportunity[] {
  const { map, pages, raw } = input;
  const conclusive =
    !!map.crawl && !map.crawl.gap && map.crawl.freshness.state === "fresh";
  if (!conclusive) return [];
  // Where each crawled URL ended up (redirects), trailing slashes ignored.
  const final = new Map<string, string>();
  for (const p of raw)
    if (p.finalUrl && trim(p.finalUrl) !== trim(p.url))
      final.set(trim(p.url), trim(p.finalUrl));
  const analysed = new Set(pages.map((p) => trim(p.url)));
  const links = new Map<string, Set<string> | null>();
  for (const p of raw)
    if (analysed.has(trim(p.url))) links.set(trim(p.url), outbound(p, final));
  const sourcesOf = (target: string) =>
    [...links].filter(([from, to]) => from !== target && to?.has(target))
      .length;

  const out: LinkOpportunity[] = [];
  for (const t of map.topics) {
    if (t.location !== null || t.state !== "covered" || !t.evidence.length)
      continue;
    const target = trim(t.evidence[0].url);
    if (!analysed.has(target)) continue;
    const inboundPages = sourcesOf(target);
    const linkedSiteWide =
      inboundPages >= 2 && inboundPages >= analysed.size / 2;
    const wanted = t.wordings.flatMap((w) =>
      phrases({ value: w, synonyms: [] }),
    );
    const sources: LinkSource[] = [];
    for (const p of pages) {
      const url = trim(p.url);
      const to = links.get(url);
      if (
        url === target ||
        !to || // no stored links, or a cut list: absence cannot be shown
        to.has(target) ||
        p.type === "legal" ||
        p.noindex ||
        p.canonicalElsewhere ||
        !p.content
      )
        continue;
      const passage = p.content.blocks.find((b) =>
        wanted.some((ph) =>
          containsPhrase(withoutPhrases(words(b), p.siteNames), ph),
        ),
      );
      if (passage) sources.push({ url: p.url, passage: clip(passage) });
    }
    // Pages with more main content first: more room for a natural link.
    const size = new Map(pages.map((p) => [p.url, p.content?.words ?? 0]));
    sources.sort(
      (a, b) =>
        (size.get(b.url) ?? 0) - (size.get(a.url) ?? 0) ||
        a.url.localeCompare(b.url),
    );
    const poorlyConnected = !linkedSiteWide && inboundPages <= 1;
    if (!sources.length && !poorlyConnected) continue;
    out.push({
      topicKey: t.key,
      label: t.label,
      target: t.evidence[0].url,
      inboundPages,
      linkedSiteWide,
      poorlyConnected,
      sources: sources.slice(0, MAX_SOURCES),
      sourcesTotal: sources.length,
    });
  }
  return out;
}
