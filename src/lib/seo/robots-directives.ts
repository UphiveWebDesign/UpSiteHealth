/**
 * Indexing directives from the two places a page can carry them: the robots
 * meta tag (`<meta name="robots">`, stored as CrawlPage.robotsMetaRaw) and
 * the X-Robots-Tag response header (stored, allowlisted, in
 * CrawlPage.result.responseHeaders by the crawler; crawler/headers.ts).
 *
 * X-Robots-Tag follows the documented header syntax: comma-separated
 * directives, optionally preceded by a user agent ("googlebot: noindex").
 * A user-agent prefix applies to the directives after it on the same header
 * line, until the next prefix. Directives that themselves take a value
 * ("max-snippet: 20", "unavailable_after: …") are not user agents.
 *
 * `noindex` and `none` (noindex plus nofollow) prohibit indexing. A
 * directive with no user agent applies to every crawler; a user-agent one
 * counts here only for the search engines this product reports on
 * (SEARCH_AGENTS), because a directive for some other bot does not keep the
 * page out of those results.
 */

/** Crawlers whose own directives decide whether a page is reported noindex. */
export const SEARCH_AGENTS = ["googlebot", "bingbot"] as const;

/** Header directives written "name: value", never user-agent prefixes. */
const VALUE_DIRECTIVES = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

const PROHIBITS_INDEXING = new Set(["noindex", "none"]);

export type HeaderDirective = {
  /** Lower-case user agent, or null when the directive applies to all. */
  agent: string | null;
  /** Lower-case directive, with its value when it has one. */
  directive: string;
};

/** Parses X-Robots-Tag header lines (one string per line). */
export function parseXRobotsTag(
  lines: readonly string[] | null | undefined,
): HeaderDirective[] {
  const out: HeaderDirective[] = [];
  for (const line of lines ?? []) {
    let agent: string | null = null; // a prefix never carries to the next line
    for (const part of line.split(",")) {
      let token = part.trim();
      if (!token) continue;
      const prefixed = /^([a-z0-9_.*-]+)\s*:\s*(.*)$/i.exec(token);
      if (prefixed && !VALUE_DIRECTIVES.has(prefixed[1].toLowerCase())) {
        agent = prefixed[1].toLowerCase();
        token = prefixed[2].trim();
        if (!token) continue;
      }
      out.push({ agent, directive: token.toLowerCase() });
    }
  }
  return out;
}

const appliesToSearch = (agent: string | null) =>
  agent === null ||
  agent === "*" ||
  (SEARCH_AGENTS as readonly string[]).includes(agent);

/**
 * Whether the header lines prohibit indexing, and for whom: "all" when a
 * directive applies to every crawler, else the search agents named.
 */
export function headerNoindex(lines: readonly string[] | null | undefined): {
  noindex: boolean;
  agents: string[];
} {
  const agents = new Set<string>();
  for (const { agent, directive } of parseXRobotsTag(lines)) {
    if (!PROHIBITS_INDEXING.has(directive) || !appliesToSearch(agent)) continue;
    agents.add(agent === null || agent === "*" ? "all" : agent);
  }
  const list = agents.has("all") ? ["all"] : [...agents].sort();
  return { noindex: list.length > 0, agents: list };
}

/**
 * Whether a robots meta tag's content prohibits indexing: `noindex` as a
 * word anywhere (the rule's original test, kept so malformed values such as
 * "noindex;nofollow" still count), or `none` as a directive of its own.
 */
export function metaNoindex(content: string | null | undefined): boolean {
  const c = content ?? "";
  return /\bnoindex\b/i.test(c) || /(^|[\s,;])none([\s,;]|$)/i.test(c);
}

/** The X-Robots-Tag lines a crawled page stored, or null when none were recorded. */
export function storedXRobotsTag(result: unknown): string[] | null {
  const headers = (result as { responseHeaders?: unknown } | null)
    ?.responseHeaders;
  if (!headers || typeof headers !== "object") return null;
  const lines = (headers as { xRobotsTag?: unknown }).xRobotsTag;
  return Array.isArray(lines)
    ? lines.filter((l): l is string => typeof l === "string")
    : null;
}

/** Whether a crawled page's result records its response headers at all. */
export function responseHeadersStored(result: unknown): boolean {
  return storedXRobotsTag(result) !== null;
}

export type NoindexSource = "meta" | "header" | "both";

/** Where a page's noindex comes from, or null when it is indexable. */
export function noindexSource(page: {
  robotsMetaRaw: string | null;
  xRobotsTag?: readonly string[] | null;
  result?: unknown;
}): { source: NoindexSource; headerAgents: string[] } | null {
  const meta = metaNoindex(page.robotsMetaRaw);
  const header = headerNoindex(
    page.xRobotsTag ?? storedXRobotsTag(page.result),
  );
  if (!meta && !header.noindex) return null;
  return {
    source: meta && header.noindex ? "both" : meta ? "meta" : "header",
    headerAgents: header.agents,
  };
}
