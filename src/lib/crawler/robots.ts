/**
 * Minimal robots.txt support (RFC 9309): user-agent groups, Allow/Disallow with
 * `*` and `$`, longest match wins, Allow wins ties. Sitemap lines are collected.
 */

type Rule = { allow: boolean; pattern: string; regex: RegExp };
type Group = { agents: string[]; rules: Rule[] };

export type Robots = {
  isAllowed(url: string): boolean;
  sitemaps: string[];
};

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string, userAgent: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (!value) continue; // empty Disallow allows everything
      current.rules.push({
        allow: key === "allow",
        pattern: value,
        regex: toRegex(value),
      });
    }
  }

  const token = userAgent.toLowerCase().split("/")[0];
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && token.includes(a)),
  );
  const chosen = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);

  return {
    sitemaps,
    isAllowed(url: string) {
      let path: string;
      try {
        const u = new URL(url);
        path = `${u.pathname}${u.search}`;
      } catch {
        return false;
      }
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

export const allowAllRobots: Robots = { isAllowed: () => true, sitemaps: [] };

/** Extracts <loc> URLs from a sitemap or sitemap index. */
export function parseSitemap(
  xml: string,
  limit = 5000,
): { urls: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  for (let m = re.exec(xml); m && urls.length < limit; m = re.exec(xml)) {
    urls.push(
      m[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    );
  }
  return { urls, isIndex };
}
