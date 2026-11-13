import type { Confidence } from "@/lib/integrations/evaluate";
import type { PlatformSignals } from "./html";

/**
 * Which platform a website runs on, from the platform signals the crawler
 * stored per page (html.ts, `result.platform`). Pure: no database, no
 * network. Conservative by design: platform-specific advice is only as good
 * as this answer, so anything short of clear evidence is "unknown".
 *
 * Evidence families (each counts once, however many pages show it):
 * - WordPress: a generator tag naming WordPress or WooCommerce (WooCommerce
 *   runs only on WordPress), a link to the WordPress REST API, same-site
 *   theme, plugin or core files (not uploaded media).
 * - WooCommerce: a generator tag naming WooCommerce, same-site WooCommerce
 *   plugin assets, WooCommerce body classes.
 *
 * Confidence (the app's high / medium / low scale, not a probability):
 * - high: two or more families;
 * - medium: one family, seen on two or more pages;
 * - one family on one page is too weak: the platform stays "unknown".
 * WooCommerce is reported only on top of a WordPress result, with the lower
 * of the two confidences. A generator naming another platform next to
 * WordPress evidence is a conflict: "unknown". Pages without stored signals
 * (crawls before detection) are unavailable evidence, not a "no".
 */

export const PLATFORM_SIGNALS_VERSION = 1;

export type Platform = "wordpress" | "woocommerce" | "unknown";

export type PlatformSignalKind =
  | "wp-generator"
  | "wp-rest-link"
  | "wp-assets"
  | "woo-generator"
  | "woo-assets"
  | "woo-body-class";

export type PlatformSignal = {
  kind: PlatformSignalKind;
  /** Plain description, e.g. "Generator tag “WordPress 6.6.2”". */
  label: string;
  /** Pages that showed it. */
  pages: number;
};

export type PlatformReason =
  | "detected"
  /** No page of the crawl has stored signals (crawled before detection). */
  | "not-recorded"
  /** Signals were recorded and none point to WordPress. */
  | "no-signals"
  /** One family on one page: not enough to act on. */
  | "weak"
  /** WordPress evidence next to a generator naming another platform. */
  | "conflicting"
  /** Only a generator naming another platform. */
  | "other-platform";

export type PlatformDetection = {
  platform: Platform;
  /** Null when the platform is unknown. */
  confidence: Exclude<Confidence, "low"> | null;
  reason: PlatformReason;
  signals: PlatformSignal[];
  /** Pages given to the detector. */
  pagesChecked: number;
  /** Pages whose stored result has readable platform signals. */
  pagesWithSignals: number;
  /** Pages whose stored platform signals could not be read. */
  malformed: number;
  /** Other platforms named by generator tags (for "conflicting" / "other-platform"). */
  otherPlatforms: string[];
};

/**
 * Generators that name a platform other than WordPress. Plugins and
 * builders that run on WordPress (Elementor, WPML, Site Kit…) are not here:
 * they neither prove nor contradict WordPress.
 */
const OTHER_PLATFORMS: Array<[RegExp, string]> = [
  [/^wix\.com\b/i, "Wix"],
  [/^squarespace\b/i, "Squarespace"],
  [/^webflow\b/i, "Webflow"],
  [/^drupal\b/i, "Drupal"],
  [/^joomla\b/i, "Joomla"],
  [/^ghost\b/i, "Ghost"],
  [/^hugo\b/i, "Hugo"],
  [/^jekyll\b/i, "Jekyll"],
  [/^gatsby\b/i, "Gatsby"],
  [/^hubspot\b/i, "HubSpot"],
  [/^typo3\b/i, "TYPO3"],
  [/^duda\b/i, "Duda"],
  [/^weebly\b/i, "Weebly"],
  [/^blogger\b/i, "Blogger"],
  [/^shopify\b/i, "Shopify"],
  [/^craft cms\b/i, "Craft CMS"],
  [/^astro\b/i, "Astro"],
];
const WP_GENERATOR = /^wordpress\b/i;
const WOO_GENERATOR = /^woocommerce\b/i;

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The platform signals stored in a crawl page's `result`: null when none
 * were recorded, "malformed" when present but unreadable.
 */
export function readPlatformSignals(
  result: unknown,
): PlatformSignals | null | "malformed" {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return null;
  if (!("platform" in result)) return null;
  const p = (result as { platform: unknown }).platform;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "malformed";
  const s = p as Record<string, unknown>;
  if (
    s.v !== PLATFORM_SIGNALS_VERSION ||
    !isStrings(s.generators) ||
    !isCount(s.wpAssets) ||
    typeof s.wpRestLink !== "boolean" ||
    !isCount(s.wooAssets) ||
    !isStrings(s.wooBodyClasses)
  )
    return "malformed";
  return s as PlatformSignals;
}

type Tally = { pages: number; detail: string | null };

const LABEL: Record<PlatformSignalKind, (detail: string | null) => string> = {
  "wp-generator": (d) => `Generator tag “${d}”`,
  "wp-rest-link": () => "Link to the WordPress REST API",
  "wp-assets": () => "WordPress theme, plugin or core files",
  "woo-generator": (d) => `Generator tag “${d}”`,
  "woo-assets": () => "WooCommerce plugin files",
  "woo-body-class": (d) => `WooCommerce page classes (${d})`,
};

/** The family a WordPress signal belongs to: each family counts once. */
const WP_FAMILY: Partial<Record<PlatformSignalKind, string>> = {
  "wp-generator": "generator",
  "woo-generator": "generator",
  "wp-rest-link": "rest-link",
  "wp-assets": "assets",
  "woo-assets": "assets",
};
const WOO_KINDS: PlatformSignalKind[] = [
  "woo-generator",
  "woo-assets",
  "woo-body-class",
];

const strength = (
  families: number,
  maxPages: number,
): "high" | "medium" | "weak" | "none" =>
  families >= 2
    ? "high"
    : families === 1 && maxPages >= 2
      ? "medium"
      : families === 1
        ? "weak"
        : "none";

/** Detects the platform from the pages of one crawl (see the module comment). */
export function detectPlatform(
  pages: ReadonlyArray<{ result: unknown }>,
): PlatformDetection {
  const tally = new Map<PlatformSignalKind, Tally>();
  const others = new Set<string>();
  let withSignals = 0;
  let malformed = 0;
  const add = (kind: PlatformSignalKind, detail: string | null = null) => {
    const t = tally.get(kind);
    if (t) t.pages++;
    else tally.set(kind, { pages: 1, detail });
  };
  for (const page of pages) {
    const s = readPlatformSignals(page.result);
    if (s === "malformed") malformed++;
    if (!s || s === "malformed") continue;
    withSignals++;
    const wpGen = s.generators.find((g) => WP_GENERATOR.test(g));
    const wooGen = s.generators.find((g) => WOO_GENERATOR.test(g));
    if (wpGen) add("wp-generator", wpGen);
    if (wooGen) add("woo-generator", wooGen);
    if (s.wpRestLink) add("wp-rest-link");
    if (s.wpAssets > 0) add("wp-assets");
    if (s.wooAssets > 0) add("woo-assets");
    if (s.wooBodyClasses.length > 0)
      add("woo-body-class", s.wooBodyClasses.slice(0, 3).join(", "));
    for (const g of s.generators)
      for (const [re, name] of OTHER_PLATFORMS)
        if (re.test(g)) others.add(name);
  }
  const signals: PlatformSignal[] = [...tally].map(([kind, t]) => ({
    kind,
    label: LABEL[kind](t.detail),
    pages: t.pages,
  }));
  const base = {
    signals,
    pagesChecked: pages.length,
    pagesWithSignals: withSignals,
    malformed,
    otherPlatforms: [...others].sort(),
  };
  const unknown = (reason: PlatformReason): PlatformDetection => ({
    platform: "unknown",
    confidence: null,
    reason,
    ...base,
  });
  if (withSignals === 0) return unknown("not-recorded");

  const familyStrength = (
    kinds: PlatformSignalKind[],
    family: (k: PlatformSignalKind) => string = (k) => k,
  ) => {
    const families = new Set<string>();
    let maxPages = 0;
    for (const k of kinds) {
      const t = tally.get(k);
      if (!t) continue;
      families.add(family(k));
      maxPages = Math.max(maxPages, t.pages);
    }
    return strength(families.size, maxPages);
  };
  const wpKinds = Object.keys(WP_FAMILY) as PlatformSignalKind[];
  const wp = familyStrength(wpKinds, (k) => WP_FAMILY[k]!);
  if (others.size > 0)
    return unknown(wp === "none" ? "other-platform" : "conflicting");
  if (wp === "none") return unknown("no-signals");
  if (wp === "weak") return unknown("weak");

  const woo = familyStrength(WOO_KINDS);
  if (woo === "high" || woo === "medium") {
    return {
      platform: "woocommerce",
      confidence: wp === "high" && woo === "high" ? "high" : "medium",
      reason: "detected",
      ...base,
    };
  }
  return { platform: "wordpress", confidence: wp, reason: "detected", ...base };
}
