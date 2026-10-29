import {
  containsAllWords,
  containsPhrase,
  withoutPhrases,
  words,
  type UnderstoodPage,
} from "./pages";
import type { Fact } from "./facts";

/**
 * How strongly a page serves a fact or offering, from the text the crawler
 * stores. Shared by business coverage and page opportunities.
 */

export type Strength = "strong" | "medium" | "weak";

export type PageMatch = {
  url: string;
  strength: Strength;
  /** Where it matched, in plain words ("title", "H1", "link text" …). */
  where: string[];
  note: string | null;
};

export const RANK: Record<Strength, number> = { strong: 0, medium: 1, weak: 2 };
const LOWER: Record<Strength, Strength> = {
  strong: "medium",
  medium: "weak",
  weak: "weak",
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Every wording of a fact: its value and the synonyms a person entered. */
export const phrases = (f: Pick<Fact, "value" | "synonyms">) =>
  [f.value, ...f.synonyms].map(words).filter((p) => p.length > 0);

/**
 * How strongly one page serves a fact. Strong: named in the title, an H1 or
 * structured data. Medium: in a subheading, the link text of two or more
 * links to it, all words of it in the title/H1, or in the URL plus one
 * other place. Weak: only the description, the URL, one link or (when
 * asked for) the main content. A page that is noindex or canonicalised
 * elsewhere counts one level lower. The site name is removed from every
 * text first, so "Contact MOH MAYA Cottages & Cafe" names neither cottages
 * nor a cafe.
 */
export function matchPage(
  page: UnderstoodPage,
  fact: Pick<Fact, "kind" | "value" | "synonyms">,
  opts: {
    /**
     * Match the published texts, site name included. Only for "is it named
     * anywhere" checks: a brand such as "Kasol Cottages" does name Kasol,
     * but never makes a page about a service or location.
     */
    fullTitle?: boolean;
    /**
     * Also look in the main content (header, navigation, footer and
     * site-wide text removed). A body mention is only ever weak: evidence
     * that the offering is mentioned, never that a page is about it.
     */
    body?: boolean;
  } = {},
): PageMatch | null {
  const ps = phrases(fact);
  if (!ps.length) return null;
  const clean = (t: string | null) =>
    opts.fullTitle ? words(t) : withoutPhrases(words(t), page.siteNames);
  const any = (texts: Array<string | null>) =>
    texts.some((t) => ps.some((p) => containsPhrase(clean(t), p)));
  const schema =
    fact.kind === "SERVICE" || fact.kind === "EXCLUDED"
      ? page.schemaNames
      : page.schemaPlaces;
  const where: string[] = [];
  const inTitle = any([opts.fullTitle ? page.fullTitle : page.title]);
  const inH1 = any(page.h1);
  const inSchema = any(schema);
  if (inTitle) where.push("title");
  if (inH1) where.push("main heading");
  if (inSchema) where.push("structured data");
  const inSub = any(page.h2h3);
  if (inSub) where.push("subheading");
  const links = page.inbound.filter((t) =>
    ps.some((p) => containsPhrase(clean(t), p)),
  ).length;
  if (links) where.push(`link text of ${plural(links, "link")}`);
  const inMeta = any([page.meta]);
  if (inMeta) where.push("description");
  const inUrl = ps.some((p) =>
    containsPhrase(words(page.path.replace(/[-_/.]+/g, " ")), p),
  );
  if (inUrl) where.push("URL");
  const loose =
    !inTitle &&
    !inH1 &&
    [page.title, ...page.h1].some((t) =>
      ps.some((p) => containsAllWords(clean(t), p)),
    );
  if (loose) where.push("all its words in the title or heading");
  const inBody = !!opts.body && !!page.content && any(page.content.blocks);
  if (inBody) where.push("main content");

  let strength: Strength | null = null;
  if (inTitle || inH1 || inSchema) strength = "strong";
  else if (inSub || links >= 2 || loose || (inUrl && (inMeta || links === 1)))
    strength = "medium";
  else if (inMeta || inUrl || links === 1 || inBody) strength = "weak";
  if (!strength) return null;

  let note: string | null = null;
  if (page.noindex || page.canonicalElsewhere) {
    strength = LOWER[strength];
    note = page.noindex
      ? "The page asks search engines not to index it."
      : "The page's canonical points at a different URL.";
  }
  return { url: page.url, strength, where, note };
}

export const best = (m: PageMatch[]) =>
  [...m].sort(
    (a, b) => RANK[a.strength] - RANK[b.strength] || a.url.localeCompare(b.url),
  );
