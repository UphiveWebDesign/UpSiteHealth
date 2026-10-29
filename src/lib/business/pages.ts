import type {
  ContactSignals,
  PageContent,
  StructuredDataBlock,
} from "@/lib/crawler/html";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import type { PageType } from "@/lib/knowledge/catalogue";
import { LEGAL_SEGMENT, legalSignals } from "@/lib/seo/legal";

/**
 * Deterministic page understanding from what the crawler stores: URL,
 * title, meta description, H1–H3 text, links with their anchor text and
 * JSON-LD. Body text is not stored, so nothing here reads it. A page whose
 * signals are weak or conflict is "unknown"; it is never forced into a type.
 * Crawled text is data only: it is matched, never interpreted.
 */

export type Confidence = "high" | "medium" | "low";

/** A loaded, analysed HTML page, ready for matching. */
export type UnderstoodPage = {
  url: string;
  path: string;
  isHome: boolean;
  /** Title without the site name repeated on every page (for matching). */
  title: string | null;
  /** The title as published (for display). */
  fullTitle: string | null;
  meta: string | null;
  h1: string[];
  h2h3: string[];
  /** Link text of internal links pointing at this page (not its own links). */
  inbound: string[];
  /** Names, service types and places from JSON-LD on this page. */
  schemaNames: string[];
  schemaPlaces: string[];
  schemaTypes: string[];
  noindex: boolean;
  /** Canonical points at a different URL (the page defers to another). */
  canonicalElsewhere: boolean;
  /** Words of visible text, when the crawl stored it. */
  wordCount: number | null;
  /**
   * Main content without site chrome or text repeated across the site;
   * null for crawls stored before main-content detection.
   */
  content: { words: number; blocks: string[] } | null;
  /** Contact links and forms; null for crawls stored before detection. */
  contact: ContactSignals | null;
  /** The site's name(s), as words, ignored when content is checked for an offering. */
  siteNames: string[][];
  type: PageType | "unknown";
  confidence: Confidence;
  signals: string[];
  /** For unknown pages: the closest guess, shown as a hint only. */
  candidate: PageType | null;
};

// ─── Text ───────────────────────────────────────────────────────────────────

const STOP = new Set(["a", "an", "and", "the", "of", "for", "in", "to", "&"]);

function singular(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss"))
    return t.slice(0, -1);
  return t;
}

/** Lower-case word tokens without accents, singularised, stop words removed. */
export function words(text: string | null | undefined): string[] {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOP.has(t))
    .map(singular);
}

/** The words with every occurrence of the given phrases removed. */
export function withoutPhrases(text: string[], remove: string[][]): string[] {
  const out = [...text];
  for (const ph of remove) {
    if (!ph.length) continue;
    for (let i = 0; i + ph.length <= out.length;) {
      if (ph.every((w, j) => out[i + j] === w)) out.splice(i, ph.length);
      else i++;
    }
  }
  return out;
}

/** The phrase appears as consecutive words. */
export function containsPhrase(text: string[], phrase: string[]): boolean {
  if (!phrase.length || phrase.length > text.length) return false;
  outer: for (let i = 0; i <= text.length - phrase.length; i++) {
    for (let j = 0; j < phrase.length; j++)
      if (text[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/** Every word of a multi-word phrase appears, in any order. */
export function containsAllWords(text: string[], phrase: string[]): boolean {
  if (phrase.length < 2) return false;
  const set = new Set(text);
  return phrase.every((w) => set.has(w));
}

// ─── Structured data ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const asArray = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
const str = (v: unknown): string[] =>
  asArray(v).flatMap((x) =>
    typeof x === "string"
      ? [x]
      : x && typeof x === "object" && typeof (x as Json).name === "string"
        ? [(x as Json).name as string]
        : [],
  );

/** Every JSON-LD node, including those inside @graph (depth-limited). */
function nodes(blocks: StructuredDataBlock[]): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || out.length > 200) return;
    for (const item of asArray(v)) {
      if (!item || typeof item !== "object") continue;
      const n = item as Json;
      out.push(n);
      if (n["@graph"]) walk(n["@graph"], depth + 1);
    }
  };
  for (const b of blocks) if (b.valid) walk(b.data, 0);
  return out;
}

function schemaFacts(blocks: StructuredDataBlock[]) {
  const types: string[] = [];
  const names: string[] = [];
  const places: string[] = [];
  for (const n of nodes(blocks)) {
    const t = str(n["@type"]);
    types.push(...t);
    if (t.some((x) => ["Service", "Product", "Offer"].includes(x)))
      names.push(...str(n.name), ...str(n.serviceType));
    places.push(...str(n.areaServed));
    for (const a of asArray(n.address)) {
      if (a && typeof a === "object") {
        const addr = a as Json;
        places.push(...str(addr.addressLocality), ...str(addr.addressRegion));
      }
    }
  }
  return { types, names, places };
}

// ─── Classification ─────────────────────────────────────────────────────────

const SCHEMA_TYPE: Record<string, PageType> = {
  ContactPage: "contact",
  AboutPage: "about",
  Article: "article",
  BlogPosting: "article",
  NewsArticle: "article",
  Product: "product",
  CollectionPage: "category",
  Service: "service",
};

/** Path segments that suggest a type (first match wins per segment). */
const SEGMENT: Array<[RegExp, PageType]> = [
  [/^(blog|news|articles?|posts?|insights|stories|guides?)$/, "article"],
  [/^(contact|contact-us|get-in-touch|enquir(y|e)|book(ing)?s?)$/, "contact"],
  [/^(about|about-us|our-story|who-we-are|team|our-team)$/, "about"],
  [/^(services?|solutions?|what-we-do|treatments?)$/, "service"],
  [
    /^(locations?|areas?|service-areas?|areas-we-cover|branches|stores?|offices?)$/,
    "location",
  ],
  [/^(products?|shop|item)$/, "product"],
  [/^(categor(y|ies)|collections?|range)$/, "category"],
  [LEGAL_SEGMENT, "legal"],
];

type Score = Partial<Record<PageType, { points: number; why: string[] }>>;

function add(score: Score, type: PageType, points: number, why: string) {
  const s = (score[type] ??= { points: 0, why: [] });
  s.points += points;
  s.why.push(why);
}

/**
 * Scores page types from independent signals: JSON-LD type (3), URL path
 * (2, or 1 for a section index), title/H1 wording (1) and approved business
 * terms in the title/H1 (2). Two or more points make a type; four or more
 * from at least two signals make it high confidence. A tie is "unknown".
 */
export function classify(
  p: Pick<UnderstoodPage, "path" | "isHome" | "title" | "h1" | "schemaTypes">,
  terms: { service: boolean; location: boolean },
): Pick<UnderstoodPage, "type" | "confidence" | "signals" | "candidate"> {
  if (p.isHome)
    return {
      type: "home",
      confidence: "high",
      signals: ["The website's home page URL"],
      candidate: null,
    };
  const score: Score = {};
  // SEO plugins (Yoast, Rank Math) mark every page as a generic Article. When
  // the URL and the title or H1 both say "legal page", that generic markup
  // counts for little, so it cannot outweigh them.
  const legal = legalSignals(p);
  const legalEvidence = legal.url && legal.heading;
  for (const t of new Set(p.schemaTypes)) {
    const type = SCHEMA_TYPE[t];
    if (!type) continue;
    if (t === "Article" && legalEvidence)
      add(
        score,
        type,
        1,
        "Structured data says Article (generic markup; the URL and title say legal page)",
      );
    else add(score, type, 3, `Structured data says ${t}`);
  }
  const segments = p.path.split("/").filter(Boolean);
  segments.forEach((seg, i) => {
    const hit = SEGMENT.find(([re]) => re.test(seg.toLowerCase()));
    if (!hit) return;
    const [, type] = hit;
    const index = i === segments.length - 1 && segments.length === 1;
    // "/services" alone lists services; "/services/x" is one of them.
    const resolved: PageType = index && type === "product" ? "category" : type;
    add(
      score,
      resolved,
      index && (type === "service" || type === "location") ? 1 : 2,
      `URL section “/${seg}”`,
    );
  });
  const heading = [p.title ?? "", ...p.h1].join(" ").toLowerCase();
  if (/\bcontact( us)?\b|\bget in touch\b/.test(heading))
    add(score, "contact", 1, "Title or heading says contact");
  if (/\babout( us)?\b|\bour story\b|\bwho we are\b/.test(heading))
    add(score, "about", 1, "Title or heading says about");
  if (legal.heading) add(score, "legal", 1, "Title or heading names a policy");
  if (terms.service)
    add(score, "service", 2, "Title or H1 names an approved service");
  if (terms.location && !terms.service)
    add(score, "location", 2, "Title or H1 names an approved location");

  const ranked = (
    Object.entries(score) as Array<
      [PageType, { points: number; why: string[] }]
    >
  ).sort((a, b) => b[1].points - a[1].points);
  const [top, next] = ranked;
  const signals = ranked.flatMap(([, s]) => s.why);
  if (!top || top[1].points < 2 || (next && next[1].points === top[1].points))
    return {
      type: "unknown",
      confidence: "low",
      signals: signals.length ? signals : ["No clear signal"],
      candidate:
        top && (!next || next[1].points < top[1].points) ? top[0] : null,
    };
  return {
    type: top[0],
    confidence:
      top[1].points >= 4 && top[1].why.length >= 2 ? "high" : "medium",
    signals,
    candidate: null,
  };
}

const record = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

/** Analysed pages of a crawl, with inbound link text, before classification. */
const SEPARATOR = /\s+[|\-–—·:]\s+/;
const norm = (t: string) => words(t).join(" ");

/**
 * Title segments repeated on at least half of the pages (and on two or
 * more): the site or brand name, as in "Privacy Policy - Moh Maya Cottages".
 * They say nothing about one page, so matching ignores them.
 */
export function siteNameSegments(titles: Array<string | null>): Set<string> {
  const counts = new Map<string, number>();
  const present = titles.filter((t): t is string => !!t);
  for (const t of present)
    for (const seg of new Set(t.split(SEPARATOR).map(norm).filter(Boolean)))
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
  return new Set(
    [...counts]
      .filter(([, n]) => n >= 2 && n >= present.length / 2)
      .map(([seg]) => seg),
  );
}

function readContent(v: unknown): PageContent | null {
  const c = record(v);
  if (
    !c ||
    c.v !== 1 ||
    typeof c.words !== "number" ||
    !Array.isArray(c.blocks)
  )
    return null;
  const blocks = (c.blocks as unknown[])
    .map(record)
    .filter((b): b is Record<string, unknown> => !!b)
    .filter((b) => typeof b.t === "string" && typeof b.w === "number")
    .map((b) => ({ t: b.t as string, w: b.w as number }));
  return { v: 1, source: "body", words: c.words, blocks };
}

function readContact(v: unknown): ContactSignals | null {
  const c = record(v);
  const n = (k: string) => (typeof c?.[k] === "number" ? (c[k] as number) : 0);
  return c
    ? {
        tel: n("tel"),
        mailto: n("mailto"),
        whatsapp: n("whatsapp"),
        forms: n("forms"),
      }
    : null;
}

/**
 * Main-content blocks found on at least two pages and at least half of the
 * pages with content: shared calls to action, banners and similar template
 * text that says nothing about one page.
 */
export function repeatedBlocks(
  contents: Array<PageContent | null>,
): Set<string> {
  const counts = new Map<string, number>();
  const withContent = contents.filter((c): c is PageContent => !!c);
  for (const c of withContent)
    for (const t of new Set(c.blocks.map((b) => norm(b.t)).filter(Boolean)))
      counts.set(t, (counts.get(t) ?? 0) + 1);
  return new Set(
    [...counts]
      .filter(([, n]) => n >= 2 && n >= withContent.length / 2)
      .map(([t]) => t),
  );
}

export function readPages(
  pages: EvidencePage[],
  websiteUrl: string,
  /** The business's own names (profile): stripped from titles even on a one-page site. */
  brandNames: string[] = [],
): Array<
  Omit<UnderstoodPage, "type" | "confidence" | "signals" | "candidate">
> {
  const analysed = pages.filter(
    (p) =>
      p.status === "CRAWLED" &&
      p.resourceType === "HTML" &&
      (p.httpStatus ?? 0) < 400 &&
      !!record(p.result),
  );
  const home = new URL(websiteUrl);
  const inbound = new Map<string, string[]>();
  for (const p of analysed) {
    const links = record(p.result)!.links;
    for (const l of Array.isArray(links) ? links : []) {
      const link = record(l);
      if (
        link?.type !== "internal" ||
        typeof link.url !== "string" ||
        typeof link.anchorText !== "string" ||
        link.url === p.url ||
        !link.anchorText.trim()
      )
        continue;
      const list = inbound.get(link.url) ?? [];
      if (list.length < 50) list.push(link.anchorText);
      inbound.set(link.url, list);
    }
  }
  const siteName = siteNameSegments(analysed.map((p) => p.title ?? null));
  for (const b of brandNames) if (norm(b)) siteName.add(norm(b));
  const contents = analysed.map((p) => readContent(record(p.result)!.content));
  const repeated = repeatedBlocks(contents);
  const topic = (title: string | null) => {
    if (!title || !siteName.size) return title;
    const kept = title
      .split(SEPARATOR)
      .filter((seg) => !siteName.has(norm(seg)));
    // A title that is only the site name says nothing about the page.
    return kept.length ? kept.join(" - ") : null;
  };
  return analysed.map((p, i) => {
    const r = record(p.result)!;
    const c = contents[i];
    const headings = record(r.headings) ?? {};
    const list = (k: string) =>
      Array.isArray(headings[k])
        ? (headings[k] as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [];
    const blocks = Array.isArray(r.structuredData)
      ? (r.structuredData as StructuredDataBlock[])
      : [];
    const schema = schemaFacts(blocks);
    const url = new URL(p.url);
    // The canonical is compared with where the page really is (its final
    // URL), not with a URL that redirected to it.
    let final = url;
    try {
      if (p.finalUrl) final = new URL(p.finalUrl);
    } catch {
      final = url;
    }
    let canonicalElsewhere = false;
    if (p.canonicalUrl) {
      try {
        const c = new URL(p.canonicalUrl, final);
        canonicalElsewhere =
          c.host !== final.host ||
          c.pathname.replace(/\/$/, "") !== final.pathname.replace(/\/$/, "");
      } catch {
        canonicalElsewhere = false;
      }
    }
    return {
      url: p.url,
      path: url.pathname,
      isHome:
        url.host.replace(/^www\./, "") === home.host.replace(/^www\./, "") &&
        url.pathname.replace(/\/$/, "") === home.pathname.replace(/\/$/, "") &&
        !url.search,
      title: topic(p.title ?? null),
      fullTitle: p.title ?? null,
      meta: p.metaDescription ?? null,
      h1: list("h1").filter((h) => !siteName.has(norm(h))),
      h2h3: [...list("h2"), ...list("h3")],
      inbound: inbound.get(p.url) ?? [],
      schemaNames: schema.names,
      schemaPlaces: schema.places,
      schemaTypes: schema.types,
      noindex: /\bnoindex\b/i.test(p.robotsMetaRaw ?? ""),
      canonicalElsewhere,
      wordCount: p.wordCount ?? null,
      content: c
        ? {
            // Words in blocks repeated across the site, or that are only the
            // site name (e.g. a brand H1), are not this page's.
            words: Math.max(
              0,
              c.words -
                c.blocks
                  .filter(
                    (b) => repeated.has(norm(b.t)) || siteName.has(norm(b.t)),
                  )
                  .reduce((n, b) => n + b.w, 0),
            ),
            blocks: c.blocks
              .filter(
                (b) => !(repeated.has(norm(b.t)) || siteName.has(norm(b.t))),
              )
              .map((b) => b.t),
          }
        : null,
      contact: readContact(r.contact),
      siteNames: [...siteName].map((n) => n.split(" ")),
    };
  });
}
