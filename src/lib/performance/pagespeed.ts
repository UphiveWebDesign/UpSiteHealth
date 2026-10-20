import type { PrismaClient } from "@/generated/prisma/client";
import type { PerformanceStrategy } from "@/generated/prisma/enums";

/**
 * Google PageSpeed Insights v5. Stored as LAB observations, matching
 * production rows (source PAGESPEED_INSIGHTS, Lighthouse version recorded).
 * INP has no lab equivalent, so it comes from field data when available.
 */

export const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export type PageSpeedErrorCode =
  "RATE_LIMITED" | "QUOTA_EXCEEDED" | "INVALID_URL" | "TIMEOUT" | "UNAVAILABLE";

export class PageSpeedError extends Error {
  constructor(
    public readonly code: PageSpeedErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type PageSpeedResult = {
  url: string;
  strategy: PerformanceStrategy;
  sourceVersion: string | null;
  performanceScore: number | null;
  lcpMs: number | null;
  inpMs: number | null;
  clsScore: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
};

type Audit = { numericValue?: number };
type PsiResponse = {
  id?: string;
  lighthouseResult?: {
    finalUrl?: string;
    lighthouseVersion?: string;
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, Audit | undefined>;
  };
  loadingExperience?: {
    metrics?: Record<string, { percentile?: number } | undefined>;
  };
};

const ms = (v: number | undefined) =>
  typeof v === "number" ? Math.round(v) : null;

export function parsePageSpeed(
  json: PsiResponse,
  strategy: PerformanceStrategy,
  requestedUrl: string,
): PageSpeedResult {
  const lh = json.lighthouseResult;
  if (!lh)
    throw new PageSpeedError(
      "UNAVAILABLE",
      "Response has no Lighthouse result",
    );
  const audit = (id: string) => lh.audits?.[id]?.numericValue;
  const score = lh.categories?.performance?.score;
  const cls = audit("cumulative-layout-shift");
  return {
    url: lh.finalUrl ?? json.id ?? requestedUrl,
    strategy,
    sourceVersion: lh.lighthouseVersion ?? null,
    performanceScore:
      typeof score === "number" ? Math.round(score * 100) : null,
    lcpMs: ms(audit("largest-contentful-paint")),
    inpMs: ms(
      json.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile,
    ),
    clsScore: typeof cls === "number" ? Math.round(cls * 1000) / 1000 : null,
    fcpMs: ms(audit("first-contentful-paint")),
    ttfbMs: ms(audit("server-response-time")),
  };
}

export async function runPageSpeed(
  url: string,
  strategy: PerformanceStrategy,
  {
    apiKey,
    fetchImpl = fetch,
    timeoutMs = 90_000,
  }: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PageSpeedResult> {
  const params = new URLSearchParams({
    url,
    strategy: strategy.toLowerCase(),
    category: "performance",
  });
  if (apiKey) params.set("key", apiKey);
  let res: Response;
  try {
    res = await fetchImpl(`${PSI_ENDPOINT}?${params}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    throw new PageSpeedError(
      name === "TimeoutError" || name === "AbortError"
        ? "TIMEOUT"
        : "UNAVAILABLE",
      "PageSpeed Insights request failed",
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) {
      // Google now rejects most anonymous calls with a quota error, so a key
      // (PAGESPEED_API_KEY) is effectively required.
      throw /quota/i.test(body)
        ? new PageSpeedError(
            "QUOTA_EXCEEDED",
            "PageSpeed Insights quota exceeded",
          )
        : new PageSpeedError(
            "RATE_LIMITED",
            "PageSpeed Insights rate limit reached",
          );
    }
    if (res.status === 400)
      throw new PageSpeedError(
        "INVALID_URL",
        "PageSpeed could not test this URL",
      );
    throw new PageSpeedError(
      "UNAVAILABLE",
      `PageSpeed Insights returned HTTP ${res.status}`,
    );
  }
  return parsePageSpeed((await res.json()) as PsiResponse, strategy, url);
}

/** Runs PSI for each strategy and stores observations. Never logs the API key. */
export async function recordPageSpeed(
  db: PrismaClient,
  website: { id: string; organizationId: string; url: string },
  options: {
    apiKey?: string;
    strategies?: PerformanceStrategy[];
    fetchImpl?: typeof fetch;
  } = {},
) {
  const strategies = options.strategies ?? ["MOBILE", "DESKTOP"];
  const saved: PageSpeedResult[] = [];
  for (const strategy of strategies) {
    const r = await runPageSpeed(website.url, strategy, options);
    await db.performanceObservation.create({
      data: {
        organizationId: website.organizationId,
        websiteId: website.id,
        strategy,
        source: "PAGESPEED_INSIGHTS",
        metricSource: "LAB",
        sourceVersion: r.sourceVersion,
        url: r.url,
        performanceScore: r.performanceScore,
        lcpMs: r.lcpMs,
        inpMs: r.inpMs,
        clsScore: r.clsScore,
        fcpMs: r.fcpMs,
        ttfbMs: r.ttfbMs,
      },
    });
    saved.push(r);
  }
  return saved;
}
