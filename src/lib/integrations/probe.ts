import { Resolver } from "node:dns/promises";
import { parseRobots, parseSitemap } from "@/lib/crawler/robots";
import { normalizeCrawlUrl } from "@/lib/crawler/urls";
import {
  DEFAULT_USER_AGENT,
  safeFetch,
  SafeFetchError,
} from "@/lib/net/safe-fetch";
import { strictPolicy, type NetPolicy } from "@/lib/net/ssrf";

/**
 * Public functional checks for a website's integrations: robots.txt,
 * sitemaps, DNS TXT verification records, BingSiteAuth.xml and whether each
 * GTM container is published. Every request goes through the SSRF-safe
 * fetcher. Results are stored as one `website_checks` row (type SEO) and are
 * never mixed into uptime/SSL/DNS status or history.
 */

export const PROBE_CHECK_TYPE = "SEO" as const;
export const PROBE_KIND = "integration-probe";
/** Marks a claimed or failed probe row; never parsed as a probe result. */
export const PROBE_ATTEMPT_KIND = "integration-probe-attempt";
export const GTM_ORIGIN = "https://www.googletagmanager.com";
const GTM_ID = /^GTM-[A-Z0-9]{4,12}$/;
const MAX_SITEMAP_FILES = 5;
const MAX_SITEMAP_URLS = 500;
const MAX_GTM_CONTAINERS = 3;

type FetchStatus = { httpStatus: number | null; error: string | null };

export type ProbeResult = {
  kind: typeof PROBE_KIND;
  version: 1;
  robots: FetchStatus & {
    status: "found" | "missing" | "error";
    /** robots.txt disallows "/" for crawlers without their own group. Null when not found. */
    blocksAll: boolean | null;
    /**
     * Whether Googlebot, using its own group if there is one, is blocked
     * from "/". Absent on probes stored before this field existed.
     */
    blocksGooglebot?: boolean | null;
    sitemaps: string[];
  };
  sitemaps: {
    source: "robots" | "default";
    files: Array<
      FetchStatus & { url: string; urlCount: number | null; isIndex: boolean }
    >;
    totalUrls: number;
    /** Up to MAX_SITEMAP_URLS normalized URLs, to cross-check with crawls. */
    sampleUrls: string[];
  };
  dnsTxt: {
    status: "ok" | "error";
    googleTokens: number;
    error: string | null;
  };
  bing: FetchStatus & { status: "found" | "missing" | "error" };
  gtm: Array<
    FetchStatus & {
      id: string;
      status: "available" | "not-found" | "error";
      /** GA4 IDs that appear in the published container. */
      ga4Ids: string[];
    }
  >;
};

export type ProbeDeps = {
  policy?: NetPolicy;
  resolveTxt?: (host: string) => Promise<string[][]>;
  /** Test seam: where the GTM availability request goes. */
  gtmOrigin?: string;
  userAgent?: string;
  /**
   * Epoch ms. Request timeouts are capped to it, and if it passes the probe
   * stops with ProbeDeadlineError and nothing is stored, so a request cut
   * short by our own budget is never recorded as a site failure.
   */
  deadline?: number;
};

export class ProbeDeadlineError extends Error {
  constructor() {
    super("Integration probe ran out of time");
  }
}

function failure(error: unknown): FetchStatus {
  return {
    httpStatus: null,
    // Only the failure code: never response bodies or internal addresses.
    error: error instanceof SafeFetchError ? error.code : "UNKNOWN_ERROR",
  };
}

/** Rejects with ETIMEOUT after `ms`, so a slow lookup cannot outlive the budget. */
function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function defaultResolveTxt(host: string): Promise<string[][]> {
  const resolver = new Resolver({ timeout: 5_000, tries: 1 });
  return resolver.resolveTxt(host);
}

/** True if robots.txt blocks "/" for this user agent (its most specific group). */
function blocksRoot(text: string, userAgent: string): boolean {
  return !parseRobots(text, userAgent).isAllowed("https://robots.check/");
}

export async function probeIntegrations(
  website: { url: string; domain: string },
  gtmIds: string[],
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const policy = deps.policy ?? strictPolicy;
  const userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
  const origin = new URL(website.url).origin;
  const deadline = deps.deadline ?? Infinity;
  const budget = (ms: number) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new ProbeDeadlineError();
    return Math.min(ms, left);
  };
  const overrun = () => {
    if (Date.now() >= deadline) throw new ProbeDeadlineError();
  };
  const fetchWithin = async (
    url: string,
    opts: Parameters<typeof safeFetch>[1] & { timeoutMs: number },
  ) => {
    const timeoutMs = budget(opts.timeoutMs);
    try {
      return await safeFetch(url, { ...opts, timeoutMs });
    } finally {
      overrun();
    }
  };
  const get = (url: string, maxBodyBytes: number, timeoutMs = 10_000) =>
    fetchWithin(url, {
      policy,
      userAgent,
      timeoutMs,
      maxBodyBytes,
      onBodyTooLarge: "truncate",
    });

  // robots.txt
  let robots: ProbeResult["robots"];
  try {
    const res = await get(`${origin}/robots.txt`, 512 * 1024);
    if (res.status === 200) {
      const text = res.body.toString("utf8");
      robots = {
        status: "found",
        httpStatus: 200,
        error: null,
        blocksAll: blocksRoot(text, "*"),
        blocksGooglebot: blocksRoot(text, "Googlebot"),
        sitemaps: parseRobots(text, userAgent).sitemaps.slice(0, 20),
      };
    } else if (res.status === 404 || res.status === 410) {
      robots = {
        status: "missing",
        httpStatus: res.status,
        error: null,
        blocksAll: null,
        sitemaps: [],
      };
    } else {
      robots = {
        status: "error",
        httpStatus: res.status,
        error: null,
        blocksAll: null,
        sitemaps: [],
      };
    }
  } catch (error) {
    if (error instanceof ProbeDeadlineError) throw error;
    robots = {
      status: "error",
      ...failure(error),
      blocksAll: null,
      sitemaps: [],
    };
  }

  // Sitemaps: those declared in robots.txt, else /sitemap.xml.
  const source = robots.sitemaps.length ? "robots" : "default";
  const queue = robots.sitemaps.length
    ? robots.sitemaps.slice(0, MAX_SITEMAP_FILES)
    : [`${origin}/sitemap.xml`];
  const files: ProbeResult["sitemaps"]["files"] = [];
  const sample = new Set<string>();
  let totalUrls = 0;
  while (queue.length && files.length < MAX_SITEMAP_FILES) {
    const url = queue.shift()!;
    try {
      const res = await get(url, 5 * 1024 * 1024);
      if (res.status !== 200) {
        files.push({
          url,
          httpStatus: res.status,
          error: null,
          urlCount: null,
          isIndex: false,
        });
        continue;
      }
      const { urls, isIndex } = parseSitemap(res.body.toString("utf8"), 50_000);
      files.push({
        url,
        httpStatus: 200,
        error: null,
        urlCount: urls.length,
        isIndex,
      });
      if (isIndex) queue.push(...urls.slice(0, MAX_SITEMAP_FILES));
      else {
        totalUrls += urls.length;
        for (const u of urls) {
          if (sample.size >= MAX_SITEMAP_URLS) break;
          const n = normalizeCrawlUrl(u, origin);
          if (n) sample.add(n);
        }
      }
    } catch (error) {
      if (error instanceof ProbeDeadlineError) throw error;
      files.push({ url, ...failure(error), urlCount: null, isIndex: false });
    }
  }

  // DNS TXT: Search Console domain verification records.
  let dnsTxt: ProbeResult["dnsTxt"];
  overrun();
  try {
    const records = await withinBudget(
      (deps.resolveTxt ?? defaultResolveTxt)(website.domain),
      budget(5_000),
    );
    overrun();
    dnsTxt = {
      status: "ok",
      googleTokens: records
        .map((r) => r.join(""))
        .filter((r) => r.startsWith("google-site-verification=")).length,
      error: null,
    };
  } catch (error) {
    if (error instanceof ProbeDeadlineError) throw error;
    const code = (error as { code?: string }).code;
    // No TXT records at all is an answer, not a failure.
    dnsTxt =
      code === "ENODATA" || code === "ENOTFOUND"
        ? { status: "ok", googleTokens: 0, error: null }
        : { status: "error", googleTokens: 0, error: code ?? "DNS_ERROR" };
  }

  // Bing XML verification file.
  let bing: ProbeResult["bing"];
  try {
    const res = await get(`${origin}/BingSiteAuth.xml`, 64 * 1024);
    const found =
      res.status === 200 &&
      /<user>[^<]+<\/user>/i.test(res.body.toString("utf8"));
    // Only a definite answer counts as "missing"; 5xx etc. is unknown.
    const absent = !found && [200, 404, 410].includes(res.status);
    bing = {
      status: found ? "found" : absent ? "missing" : "error",
      httpStatus: res.status,
      error: null,
    };
  } catch (error) {
    if (error instanceof ProbeDeadlineError) throw error;
    bing = { status: "error", ...failure(error) };
  }

  // GTM: is each container published? A strict, fixed request to Google:
  // validated ID, fixed host, no redirects, small timeout and body limit.
  const gtmOrigin = new URL(deps.gtmOrigin ?? GTM_ORIGIN);
  const gtm: ProbeResult["gtm"] = [];
  for (const id of [...new Set(gtmIds)]
    .filter((i) => GTM_ID.test(i))
    .slice(0, MAX_GTM_CONTAINERS)) {
    const url = new URL("/gtm.js", gtmOrigin);
    url.searchParams.set("id", id);
    try {
      const res = await fetchWithin(url.toString(), {
        policy,
        userAgent,
        timeoutMs: 8_000,
        maxRedirects: 0,
        maxBodyBytes: 2 * 1024 * 1024,
        onBodyTooLarge: "truncate",
      });
      if (new URL(res.finalUrl).host !== gtmOrigin.host) {
        gtm.push({
          id,
          status: "error",
          httpStatus: res.status,
          error: "UNEXPECTED_HOST",
          ga4Ids: [],
        });
      } else if (
        res.status === 200 &&
        res.body.length > 0 &&
        /javascript/i.test(String(res.headers["content-type"] ?? ""))
      ) {
        const body = res.body.toString("utf8");
        gtm.push({
          id,
          status: "available",
          httpStatus: 200,
          error: null,
          ga4Ids: [...new Set(body.match(/\bG-[A-Z0-9]{4,12}\b/g) ?? [])].slice(
            0,
            10,
          ),
        });
      } else {
        // Anything but a JavaScript 200 or a 404 is indeterminate.
        gtm.push({
          id,
          status: res.status === 404 ? "not-found" : "error",
          httpStatus: res.status,
          error: res.status === 200 ? "UNEXPECTED_RESPONSE" : null,
          ga4Ids: [],
        });
      }
    } catch (error) {
      if (error instanceof ProbeDeadlineError) throw error;
      gtm.push({ id, status: "error", ...failure(error), ga4Ids: [] });
    }
  }

  return {
    kind: PROBE_KIND,
    version: 1,
    robots,
    sitemaps: { source, files, totalUrls, sampleUrls: [...sample] },
    dnsTxt,
    bing,
    gtm,
  };
}

export function isProbeResult(value: unknown): value is ProbeResult {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === PROBE_KIND &&
    (value as { version?: unknown }).version === 1
  );
}
