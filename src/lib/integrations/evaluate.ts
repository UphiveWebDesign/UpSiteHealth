import type {
  CrawlPageStatus,
  CrawlResourceType,
  CrawlRunStatus,
  IssueSeverity,
} from "@/generated/prisma/enums";
import type { PageTags, StructuredDataBlock } from "@/lib/crawler/html";
import type { BenefitCategory } from "@/lib/recommendations/benefits";
import type { ProbeResult } from "./probe";

/**
 * Integration health, worked out deterministically from the latest crawl
 * (page source) and the latest public probe. States:
 *
 * - verified:        a reliable functional check passed (robots.txt,
 *                    sitemap, canonical tags). Tracking tags are never
 *                    "verified" here — that needs an authorized API.
 * - detected:        found in public source; not proof that it works.
 * - needs-attention: missing, broken, duplicated, misconfigured or outdated.
 * - not-detected:    an optional integration that is not in use.
 * - not-checked:     no crawl/probe yet, or the stored data predates the
 *                    check ("Not measured"). Never reported as missing.
 */

export type IntegrationKey =
  | "GSC"
  | "GA4"
  | "GTM"
  | "BING"
  | "ROBOTS"
  | "SITEMAP"
  | "CANONICAL"
  | "SCHEMA";

export type IntegrationState =
  "verified" | "detected" | "needs-attention" | "not-detected" | "not-checked";

export type Confidence = "high" | "medium" | "low";

export type IntegrationProblem = {
  /** Stable code; with the key it identifies the setup task. */
  code: string;
  title: string;
  summary: string;
  severity: IssueSeverity;
  confidence: Confidence;
  action: string;
  urls: string[];
  /** False when an existing SEO finding already tracks this as a task. */
  task: boolean;
};

export type IntegrationStatus = {
  key: IntegrationKey;
  name: string;
  benefit: BenefitCategory;
  optional: boolean;
  state: IntegrationState;
  headline: string;
  evidence: string[];
  limitations: string[];
  problems: IntegrationProblem[];
  /** How a fix is confirmed. */
  verification: string;
  checkedAt: Date | null;
};

export type EvidencePage = {
  url: string;
  status: CrawlPageStatus;
  httpStatus: number | null;
  resourceType: CrawlResourceType | null;
  finalUrl: string | null;
  canonicalUrl: string | null;
  robotsMetaRaw: string | null;
  depth: number;
  result: unknown;
};

export type IntegrationEvidence = {
  websiteUrl: string;
  crawl: {
    status: CrawlRunStatus;
    analyzedAt: Date;
    pages: EvidencePage[];
  } | null;
  probe: { checkedAt: Date; result: ProbeResult } | null;
};

export const MAX_URLS = 50;
/** Problems at or above this severity make an integration "needs attention". */
const ATTENTION: IssueSeverity[] = ["CRITICAL", "HIGH", "MEDIUM"];

type Analysed = EvidencePage & {
  tags: PageTags | null;
  structuredData: StructuredDataBlock[] | null;
};

/** Loaded HTML pages the crawler parsed; tags are null on older crawls. */
function analysedPages(e: IntegrationEvidence): Analysed[] {
  return (e.crawl?.pages ?? [])
    .filter(
      (p) =>
        p.status === "CRAWLED" &&
        p.resourceType === "HTML" &&
        (p.httpStatus ?? 0) < 400 &&
        !!p.result,
    )
    .map((p) => {
      const r = p.result as { tags?: PageTags; structuredData?: unknown };
      return {
        ...p,
        tags: r.tags ?? null,
        structuredData: Array.isArray(r.structuredData)
          ? (r.structuredData as StructuredDataBlock[])
          : null,
      };
    });
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const uniq = (xs: string[]) => [...new Set(xs)];
const hasDuplicate = (xs: string[]) => new Set(xs).size < xs.length;

function finish(
  base: Omit<IntegrationStatus, "state"> & { state?: IntegrationState },
): IntegrationStatus {
  const state =
    base.state ??
    (base.problems.some((p) => ATTENTION.includes(p.severity))
      ? "needs-attention"
      : "detected");
  return { ...base, state };
}

const NO_CRAWL = "Not checked: crawl the site to check its page source.";
const OLD_CRAWL =
  "Not measured: the latest crawl ran before tracking-tag detection. Crawl again to check.";

function notChecked(
  base: Pick<
    IntegrationStatus,
    "key" | "name" | "benefit" | "optional" | "limitations" | "verification"
  >,
  headline: string,
  checkedAt: Date | null = null,
): IntegrationStatus {
  return {
    ...base,
    state: "not-checked",
    headline,
    evidence: [],
    problems: [],
    checkedAt,
  };
}

function ga4(e: IntegrationEvidence, pages: Analysed[]): IntegrationStatus {
  const base = {
    key: "GA4" as const,
    name: "Google Analytics 4",
    benefit: "measurement" as const,
    optional: false,
    limitations: [
      "Finding a GA4 ID shows a tag is installed. It does not show that data reaches Google Analytics; that needs a GA4 connection (planned).",
      "Tags added only by consent tools or after user interaction may not be visible in the page source.",
    ],
    verification:
      "The next crawl checks the page source on every crawled page. A future GA4 connection will confirm data collection.",
  };
  if (!e.crawl) return notChecked(base, NO_CRAWL);
  const measured = pages.filter((p) => p.tags);
  if (!measured.length) return notChecked(base, OLD_CRAWL, e.crawl.analyzedAt);

  const direct = measured.filter((p) => p.tags!.ga4.length);
  const viaGtm = uniq((e.probe?.result.gtm ?? []).flatMap((g) => g.ga4Ids));
  const gtmPages = measured.filter((p) => p.tags!.gtm.length);
  const ids = uniq([...direct.flatMap((p) => p.tags!.ga4), ...viaGtm]);
  const problems: IntegrationProblem[] = [];
  const evidence: string[] = [];

  if (direct.length) {
    evidence.push(
      `GA4 tag ${ids.join(", ")} found in the page source of ${direct.length} of ${measured.length} crawled pages.`,
    );
  }
  if (viaGtm.length) {
    evidence.push(
      `${viaGtm.join(", ")} appears in the published Google Tag Manager container.`,
    );
  }
  if (!direct.length && !viaGtm.length) {
    if (gtmPages.length && !e.probe?.result.gtm.length) {
      return {
        ...notChecked(
          base,
          "GA4 may be set up inside Google Tag Manager. Run an integration check to inspect the public container.",
          e.crawl.analyzedAt,
        ),
      };
    }
    problems.push({
      code: "MISSING",
      title: "Set up Google Analytics 4",
      summary: gtmPages.length
        ? `No GA4 measurement ID in the page source of ${measured.length} crawled pages or in the published GTM container.`
        : `No GA4 tag found in the page source of ${measured.length} crawled pages.`,
      severity: "MEDIUM",
      confidence: gtmPages.length ? "medium" : "high",
      action:
        "Create a GA4 property and add its Google tag (directly or through Google Tag Manager) to every page. UpSiteHealth does not install tags for you.",
      urls: [],
      task: true,
    });
  } else if (!viaGtm.length) {
    const missing = measured.filter(
      (p) => !p.tags!.ga4.length && !p.tags!.gtm.length,
    );
    if (missing.length) {
      problems.push({
        code: "PARTIAL",
        title: "Add the GA4 tag to every page",
        summary: `${plural(missing.length, "crawled page")} ha${missing.length === 1 ? "s" : "ve"} no GA4 or GTM tag, so visits to ${missing.length === 1 ? "it" : "them"} are not measured.`,
        severity: missing.length / measured.length > 0.2 ? "MEDIUM" : "LOW",
        confidence: "high",
        action:
          "Add the Google tag to the shared page template so every page includes it.",
        urls: missing.map((p) => p.url).slice(0, MAX_URLS),
        task: true,
      });
    }
  }
  const dupes = measured.filter(
    (p) => hasDuplicate(p.tags!.ga4) || p.tags!.gtagLoaders > 1,
  );
  if (dupes.length) {
    problems.push({
      code: "DUPLICATED",
      title: "Remove duplicate GA4 tags",
      summary: `${plural(dupes.length, "page")} load${dupes.length === 1 ? "s" : ""} the same GA4 tag more than once, which can double-count page views.`,
      severity: "MEDIUM",
      confidence: "medium",
      action:
        "Keep one installation of each GA4 tag per page (either the direct Google tag or GTM, not both).",
      urls: dupes.map((p) => p.url).slice(0, MAX_URLS),
      task: true,
    });
  }
  const ua = measured.filter((p) => p.tags!.ua.length);
  if (ua.length) {
    problems.push({
      code: "OUTDATED",
      title: "Remove the old Universal Analytics tag",
      summary: `Universal Analytics ${uniq(ua.flatMap((p) => p.tags!.ua)).join(", ")} is still installed on ${plural(ua.length, "page")}. Google no longer processes Universal Analytics data.`,
      severity: "LOW",
      confidence: "high",
      action:
        "Remove the UA tag. If you still need analytics, use GA4 instead.",
      urls: ua.map((p) => p.url).slice(0, MAX_URLS),
      task: true,
    });
  }
  if (ids.filter((i) => i.startsWith("G-")).length > 1) {
    evidence.push(
      "More than one GA4 ID is installed. That can be intentional (several properties); check it is.",
    );
  }
  return finish({
    ...base,
    headline: problems.some((p) => p.code === "MISSING")
      ? "No GA4 tag found"
      : "GA4 tag detected · data collection not verified",
    evidence,
    problems,
    checkedAt: e.crawl.analyzedAt,
  });
}

/** One task per unpublished container, so each keeps its own evidence. */
export const gtmBrokenCode = (id: string) => `BROKEN_${id.replace(/-/g, "_")}`;
export const gtmIdFromCode = (code: string) =>
  /^BROKEN_(GTM_[A-Z0-9]+)$/.exec(code)?.[1].replace("_", "-") ?? null;

function gtm(e: IntegrationEvidence, pages: Analysed[]): IntegrationStatus {
  const base = {
    key: "GTM" as const,
    name: "Google Tag Manager",
    benefit: "measurement" as const,
    optional: true,
    limitations: [
      "A published container shows Google serves it. It does not show that its tags fire or send data; that needs authorized Tag Manager access (planned).",
    ],
    verification:
      "The next crawl finds the container on each page; the next integration check confirms it is published.",
  };
  if (!e.crawl) return notChecked(base, NO_CRAWL);
  const measured = pages.filter((p) => p.tags);
  if (!measured.length) return notChecked(base, OLD_CRAWL, e.crawl.analyzedAt);
  const withGtm = measured.filter((p) => p.tags!.gtm.length);
  const ids = uniq(withGtm.flatMap((p) => p.tags!.gtm));
  if (!ids.length) {
    return {
      ...base,
      state: "not-detected",
      headline: "Not in use (optional)",
      evidence: [
        `No GTM container in ${plural(measured.length, "crawled page")}.`,
      ],
      problems: [],
      checkedAt: e.crawl.analyzedAt,
    };
  }
  const problems: IntegrationProblem[] = [];
  const evidence = [
    `Container ${ids.join(", ")} found on ${withGtm.length} of ${measured.length} crawled pages.`,
  ];
  const checks = e.probe?.result.gtm ?? [];
  for (const id of ids) {
    const c = checks.find((g) => g.id === id);
    if (!c) evidence.push(`${id}: availability not checked yet.`);
    else if (c.status === "available")
      evidence.push(`${id}: published (Google serves the container).`);
    else if (c.status === "not-found") {
      problems.push({
        code: gtmBrokenCode(id),
        title: `Publish or replace GTM container ${id}`,
        summary: `Google returned HTTP 404 for ${id}. That usually means the container does not exist or has not been published, in which case none of its tags load.`,
        severity: "HIGH",
        confidence: "medium",
        action:
          "Check the container ID on the site, and publish the container in Tag Manager.",
        urls: withGtm
          .filter((p) => p.tags!.gtm.includes(id))
          .map((p) => p.url)
          .slice(0, MAX_URLS),
        task: true,
      });
    } else {
      evidence.push(
        `${id}: availability could not be checked (${c.error ?? `HTTP ${c.httpStatus}`}).`,
      );
    }
  }
  const dupes = measured.filter(
    (p) => new Set(p.tags!.gtm).size > 1 || hasDuplicate(p.tags!.gtm),
  );
  if (dupes.length) {
    problems.push({
      code: "DUPLICATED",
      title: "Remove duplicate Tag Manager containers",
      summary: `${plural(dupes.length, "page")} load${dupes.length === 1 ? "s" : ""} more than one GTM container (or the same one twice), which can fire tags twice.`,
      severity: "MEDIUM",
      confidence: "medium",
      action:
        "Keep one container per page unless several are intentional, and remove repeated snippets.",
      urls: dupes.map((p) => p.url).slice(0, MAX_URLS),
      task: true,
    });
  }
  const missing = measured.length - withGtm.length;
  if (missing > 0) {
    problems.push({
      code: "PARTIAL",
      title: "Add the Tag Manager container to every page",
      summary: `${plural(missing, "crawled page")} ha${missing === 1 ? "s" : "ve"} no GTM container.`,
      severity: "LOW",
      confidence: "high",
      action: "Add the GTM snippet to the shared page template.",
      urls: measured
        .filter((p) => !p.tags!.gtm.length)
        .map((p) => p.url)
        .slice(0, MAX_URLS),
      task: true,
    });
  }
  return finish({
    ...base,
    headline: problems.some((p) => p.code.startsWith("BROKEN_"))
      ? "Container may not be published"
      : "Container detected · tags not verified",
    evidence,
    problems,
    checkedAt: e.probe?.checkedAt ?? e.crawl.analyzedAt,
  });
}

function gsc(e: IntegrationEvidence, pages: Analysed[]): IntegrationStatus {
  const base = {
    key: "GSC" as const,
    name: "Google Search Console",
    benefit: "search-insight" as const,
    optional: false,
    limitations: [
      "A verification token shows that verification was started. Only a Search Console connection (planned) can confirm the property, its owner and its data.",
      "Search Console can also be verified with an HTML file, Google Analytics or Tag Manager, which are not visible here.",
    ],
    verification:
      "The next crawl and integration check look for verification tokens. A future Search Console connection will verify the property.",
  };
  const measured = pages.filter((p) => p.tags);
  const dns = e.probe?.result.dnsTxt;
  if (!measured.length && (!dns || dns.status !== "ok")) {
    return notChecked(
      base,
      e.crawl
        ? OLD_CRAWL
        : "Not checked: crawl the site and run an integration check.",
      e.crawl?.analyzedAt ?? null,
    );
  }
  const meta = measured.filter((p) => p.tags!.googleSiteVerification.length);
  const evidence: string[] = [];
  if (meta.length)
    evidence.push(
      `Verification meta tag found on ${plural(meta.length, "page")}.`,
    );
  if (dns?.status === "ok" && dns.googleTokens)
    evidence.push(
      `${plural(dns.googleTokens, "DNS TXT verification record")} found.`,
    );
  const checkedAt = e.probe?.checkedAt ?? e.crawl?.analyzedAt ?? null;
  if (evidence.length) {
    return {
      ...base,
      state: "detected",
      headline: "Verification token found · property not verified here",
      evidence,
      problems: [],
      checkedAt,
    };
  }
  return finish({
    ...base,
    headline: "No public verification token found",
    evidence: [
      measured.length
        ? `No google-site-verification meta tag in ${plural(measured.length, "crawled page")}.`
        : "Page source not measured yet.",
      dns?.status === "ok"
        ? "No google-site-verification DNS TXT record."
        : "DNS TXT records not checked.",
    ],
    problems: [
      {
        code: "UNCONFIRMED",
        title: "Confirm Google Search Console is set up",
        summary:
          "No public Search Console verification was found. The site may still be verified another way, so this needs confirming rather than fixing.",
        severity: "MEDIUM",
        confidence: "low",
        action:
          "In Search Console, check that a property exists for this site (a Domain property covers every subdomain and protocol) and submit the XML sitemap.",
        urls: [],
        task: true,
      },
    ],
    checkedAt,
  });
}

function bing(e: IntegrationEvidence, pages: Analysed[]): IntegrationStatus {
  const base = {
    key: "BING" as const,
    name: "Bing Webmaster Tools",
    benefit: "search-insight" as const,
    optional: true,
    limitations: [
      "Detection only. A token or BingSiteAuth.xml shows verification was started, not that the site is verified.",
    ],
    verification:
      "The next crawl and integration check look for Bing verification.",
  };
  const measured = pages.filter((p) => p.tags);
  const file = e.probe?.result.bing;
  if (!measured.length && (!file || file.status === "error")) {
    return notChecked(
      base,
      e.crawl
        ? OLD_CRAWL
        : "Not checked: crawl the site and run an integration check.",
      e.crawl?.analyzedAt ?? null,
    );
  }
  const meta = measured.filter((p) => p.tags!.bingSiteVerification.length);
  const evidence: string[] = [];
  if (meta.length)
    evidence.push(`msvalidate.01 meta tag on ${plural(meta.length, "page")}.`);
  if (file?.status === "found") evidence.push("BingSiteAuth.xml is published.");
  return {
    ...base,
    state: evidence.length ? "detected" : "not-detected",
    headline: evidence.length
      ? "Verification token found · not verified here"
      : "Not in use (optional)",
    evidence: evidence.length
      ? evidence
      : ["No Bing verification meta tag or BingSiteAuth.xml found."],
    problems: [],
    checkedAt: e.probe?.checkedAt ?? e.crawl?.analyzedAt ?? null,
  };
}

function robots(e: IntegrationEvidence): IntegrationStatus {
  const base = {
    key: "ROBOTS" as const,
    name: "robots.txt",
    benefit: "crawling-indexing" as const,
    optional: false,
    limitations: ["Checks the rules for all crawlers (User-agent: *)."],
    verification: "The next integration check fetches robots.txt again.",
  };
  const r = e.probe?.result.robots;
  if (!r) return notChecked(base, "Not checked: run an integration check.");
  const checkedAt = e.probe!.checkedAt;
  if (r.status === "error") {
    return finish({
      ...base,
      headline: "robots.txt could not be fetched",
      evidence: [
        r.httpStatus ? `HTTP ${r.httpStatus}` : `Request failed: ${r.error}`,
      ],
      problems: [
        {
          code: "BROKEN",
          title: "Fix robots.txt errors",
          summary: `robots.txt returned ${r.httpStatus ? `HTTP ${r.httpStatus}` : r.error}. While it returns server errors, Google may pause crawling the site.`,
          severity: "HIGH",
          confidence: r.httpStatus ? "high" : "medium",
          action:
            "Make /robots.txt return HTTP 200 (or 404 if you do not use one). Check the server or CDN rules for this path.",
          urls: [`${new URL(e.websiteUrl).origin}/robots.txt`],
          task: true,
        },
      ],
      checkedAt,
    });
  }
  if (r.status === "missing") {
    return finish({
      ...base,
      state: "verified",
      headline: "No robots.txt (search engines may crawl everything)",
      evidence: [
        `HTTP ${r.httpStatus}: search engines treat a missing robots.txt as "allow all".`,
      ],
      problems: [
        {
          code: "MISSING",
          title: "Consider adding a robots.txt that lists your sitemap",
          summary:
            "Not required. A robots.txt is the standard place to point crawlers at your sitemap.",
          severity: "LOW",
          confidence: "high",
          action:
            "Publish /robots.txt with a Sitemap: line for your XML sitemap.",
          urls: [],
          task: true,
        },
      ],
      checkedAt,
    });
  }
  const problems: IntegrationProblem[] = [];
  if (r.blocksAll) {
    problems.push({
      code: "BLOCKED",
      title: "robots.txt blocks the whole site",
      summary:
        'robots.txt disallows "/" for all crawlers, so search engines are asked not to crawl any page.',
      severity: "CRITICAL",
      confidence: "high",
      action:
        "Remove the site-wide Disallow rule unless the site is intentionally hidden (for example, a staging site).",
      urls: [`${new URL(e.websiteUrl).origin}/robots.txt`],
      task: true,
    });
  }
  if (!r.sitemaps.length) {
    problems.push({
      code: "NO_SITEMAP",
      title: "Reference your sitemap in robots.txt",
      summary: "robots.txt does not list a sitemap.",
      severity: "LOW",
      confidence: "high",
      action: "Add a line such as Sitemap: https://example.com/sitemap.xml.",
      urls: [],
      task: true,
    });
  }
  return finish({
    ...base,
    state: r.blocksAll ? "needs-attention" : "verified",
    headline: r.blocksAll ? "Blocks all crawlers" : "Found and allows crawling",
    evidence: [
      "HTTP 200",
      r.sitemaps.length
        ? `Lists ${plural(r.sitemaps.length, "sitemap")}.`
        : "Lists no sitemap.",
    ],
    problems,
    checkedAt,
  });
}

function sitemap(e: IntegrationEvidence): IntegrationStatus {
  const base = {
    key: "SITEMAP" as const,
    name: "XML sitemap",
    benefit: "crawling-indexing" as const,
    optional: false,
    limitations: [
      "Reads up to 5 sitemap files and cross-checks up to 500 listed URLs with the latest crawl.",
    ],
    verification:
      "The next integration check re-reads the sitemap; the next crawl rechecks the listed pages.",
  };
  const s = e.probe?.result.sitemaps;
  if (!s) return notChecked(base, "Not checked: run an integration check.");
  const checkedAt = e.probe!.checkedAt;
  const ok = s.files.filter((f) => f.httpStatus === 200);
  const failed = s.files.filter((f) => f.httpStatus !== 200);
  const evidence = s.files.map((f) =>
    f.httpStatus === 200
      ? `${f.url}: ${f.isIndex ? "sitemap index" : plural(f.urlCount ?? 0, "URL")}`
      : `${f.url}: ${f.httpStatus ? `HTTP ${f.httpStatus}` : f.error}`,
  );
  const problems: IntegrationProblem[] = [];
  if (!ok.length) {
    const missing =
      s.source === "default" && failed.every((f) => f.httpStatus === 404);
    problems.push(
      missing
        ? {
            code: "MISSING",
            title: "Publish an XML sitemap",
            summary:
              "No sitemap is listed in robots.txt and /sitemap.xml returns 404.",
            severity: "MEDIUM",
            confidence: "high",
            action:
              "Generate an XML sitemap of the pages you want indexed, publish it, and list it in robots.txt.",
            urls: [],
            task: true,
          }
        : {
            code: "BROKEN",
            title: "Fix the XML sitemap",
            summary: "The sitemap could not be fetched.",
            severity: "HIGH",
            confidence: "high",
            action: "Make every listed sitemap return HTTP 200 with valid XML.",
            urls: failed.map((f) => f.url),
            task: true,
          },
    );
  } else {
    if (failed.length) {
      problems.push({
        code: "FILE_ERRORS",
        title: "Fix sitemap files that fail to load",
        summary: `${plural(failed.length, "sitemap file")} could not be fetched.`,
        severity: "MEDIUM",
        confidence: "high",
        action: "Fix or remove the failing sitemap files.",
        urls: failed.map((f) => f.url),
        task: true,
      });
    }
    if (s.totalUrls === 0) {
      problems.push({
        code: "EMPTY",
        title: "Add pages to the XML sitemap",
        summary: "The sitemap loads but lists no page URLs.",
        severity: "MEDIUM",
        confidence: "high",
        action:
          "Make sure the sitemap generator includes your indexable pages.",
        urls: ok.map((f) => f.url),
        task: true,
      });
    }
  }
  // Cross-check listed URLs with the latest crawl.
  if (e.crawl && s.sampleUrls.length) {
    const listed = new Set(s.sampleUrls);
    const crawled = e.crawl.pages.filter(
      (p) => listed.has(p.url) && p.status === "CRAWLED",
    );
    const broken = crawled.filter((p) => (p.httpStatus ?? 0) >= 400);
    const noindex = crawled.filter(
      (p) =>
        (p.httpStatus ?? 0) < 400 && /\bnoindex\b/i.test(p.robotsMetaRaw ?? ""),
    );
    const redirected = crawled.filter(
      (p) => (p.httpStatus ?? 0) < 400 && p.finalUrl && p.finalUrl !== p.url,
    );
    evidence.push(
      `${plural(crawled.length, "listed URL")} checked against the crawl of ${e.crawl.analyzedAt.toISOString().slice(0, 10)}.`,
    );
    if (broken.length)
      problems.push({
        code: "LISTS_ERRORS",
        title: "Remove broken URLs from the sitemap",
        summary: `${plural(broken.length, "URL")} in the sitemap return${broken.length === 1 ? "s" : ""} an HTTP error.`,
        severity: "MEDIUM",
        confidence: "high",
        action: "Fix these pages or remove them from the sitemap.",
        urls: broken.map((p) => p.url).slice(0, MAX_URLS),
        task: true,
      });
    if (noindex.length)
      problems.push({
        code: "LISTS_NOINDEX",
        title: "Remove noindex pages from the sitemap",
        summary: `${plural(noindex.length, "URL")} in the sitemap ask${noindex.length === 1 ? "s" : ""} search engines not to index ${noindex.length === 1 ? "it" : "them"} (noindex), which sends mixed signals.`,
        severity: "MEDIUM",
        confidence: "high",
        action: "Either remove noindex or remove the URL from the sitemap.",
        urls: noindex.map((p) => p.url).slice(0, MAX_URLS),
        task: true,
      });
    if (redirected.length)
      problems.push({
        code: "LISTS_REDIRECTS",
        title: "List final URLs in the sitemap",
        summary: `${plural(redirected.length, "URL")} in the sitemap redirect${redirected.length === 1 ? "s" : ""} elsewhere.`,
        severity: "LOW",
        confidence: "high",
        action: "Replace redirected URLs with their final address.",
        urls: redirected.map((p) => p.url).slice(0, MAX_URLS),
        task: true,
      });
  }
  const healthy = ok.length > 0 && s.totalUrls > 0;
  return finish({
    ...base,
    state:
      problems.some((p) => ATTENTION.includes(p.severity)) || !healthy
        ? "needs-attention"
        : "verified",
    headline: healthy
      ? `${plural(s.totalUrls, "URL")} listed${s.source === "default" ? " (found at /sitemap.xml)" : ""}`
      : (problems[0]?.summary ?? "No sitemap"),
    evidence,
    problems,
    checkedAt,
  });
}

function canonical(
  e: IntegrationEvidence,
  pages: Analysed[],
): IntegrationStatus {
  const base = {
    key: "CANONICAL" as const,
    name: "Canonical tags",
    benefit: "crawling-indexing" as const,
    optional: false,
    limitations: [
      "Checked on crawled pages only. Canonicals pointing to other sites are tracked as SEO findings.",
    ],
    verification: "The next crawl rechecks each page's canonical tag.",
  };
  if (!e.crawl) return notChecked(base, NO_CRAWL);
  if (!pages.length)
    return notChecked(
      base,
      "Not checked: the latest crawl has no analysable pages.",
      e.crawl.analyzedAt,
    );
  const byUrl = new Map(e.crawl.pages.map((p) => [p.url, p]));
  const host = new URL(e.websiteUrl).hostname.replace(/^www\./, "");
  const internal = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "") === host;
    } catch {
      return false;
    }
  };
  const missing = pages.filter((p) => !p.canonicalUrl);
  const toError = pages.filter((p) => {
    const t =
      p.canonicalUrl && internal(p.canonicalUrl)
        ? byUrl.get(p.canonicalUrl)
        : undefined;
    return t?.status === "CRAWLED" && (t.httpStatus ?? 0) >= 400;
  });
  const toRedirect = pages.filter((p) => {
    const t =
      p.canonicalUrl && internal(p.canonicalUrl)
        ? byUrl.get(p.canonicalUrl)
        : undefined;
    return (
      t?.status === "CRAWLED" &&
      (t.httpStatus ?? 0) < 400 &&
      !!t.finalUrl &&
      t.finalUrl !== t.url
    );
  });
  const external = pages.filter(
    (p) => p.canonicalUrl && !internal(p.canonicalUrl),
  );
  const problems: IntegrationProblem[] = [];
  if (toError.length)
    problems.push({
      code: "TO_ERROR",
      title: "Point canonical tags at working pages",
      summary: `${plural(toError.length, "page")} declare${toError.length === 1 ? "s" : ""} a canonical URL that returns an HTTP error.`,
      severity: "MEDIUM",
      confidence: "high",
      action: "Set each canonical to the working, preferred URL of the page.",
      urls: toError.map((p) => p.url).slice(0, MAX_URLS),
      task: true,
    });
  if (toRedirect.length)
    problems.push({
      code: "TO_REDIRECT",
      title: "Point canonical tags at final URLs",
      summary: `${plural(toRedirect.length, "page")} declare${toRedirect.length === 1 ? "s" : ""} a canonical URL that redirects.`,
      severity: "LOW",
      confidence: "high",
      action: "Use the final URL (after redirects) as the canonical.",
      urls: toRedirect.map((p) => p.url).slice(0, MAX_URLS),
      task: true,
    });
  if (missing.length)
    problems.push({
      code: "MISSING",
      title: "Add canonical tags",
      summary: `${plural(missing.length, "crawled page")} ha${missing.length === 1 ? "s" : "ve"} no canonical tag. Not an error, but a self-referencing canonical helps when the same page is reachable at several URLs.`,
      severity: "LOW",
      confidence: "high",
      action:
        "Add a self-referencing canonical tag to the shared page template.",
      urls: missing.map((p) => p.url).slice(0, MAX_URLS),
      task: true,
    });
  const evidence = [
    `${pages.length - missing.length} of ${pages.length} crawled pages declare a canonical URL.`,
  ];
  if (external.length)
    evidence.push(
      `${plural(external.length, "page")} point${external.length === 1 ? "s" : ""} to another site (see SEO findings).`,
    );
  const attention =
    problems.some((p) => ATTENTION.includes(p.severity)) || external.length > 0;
  return {
    ...base,
    state: attention
      ? "needs-attention"
      : e.crawl.status === "COMPLETED"
        ? "verified"
        : "detected",
    headline: attention
      ? "Some canonical tags need attention"
      : e.crawl.status === "COMPLETED"
        ? "Canonical tags checked on every crawled page"
        : "Checked on the pages this partial crawl reached",
    evidence,
    problems,
    checkedAt: e.crawl.analyzedAt,
  };
}

function schemaTypes(block: StructuredDataBlock): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t))
      out.push(...t.filter((x): x is string => typeof x === "string"));
    if (o["@graph"]) walk(o["@graph"]);
  };
  walk(block.data);
  return out;
}

function schema(e: IntegrationEvidence, pages: Analysed[]): IntegrationStatus {
  const base = {
    key: "SCHEMA" as const,
    name: "Structured data",
    benefit: "search-appearance" as const,
    optional: false,
    limitations: [
      "Checks that JSON-LD parses and which types it declares. It is not validated against Google's rich result requirements, and it does not guarantee rich results.",
    ],
    verification:
      "The next crawl re-reads structured data on every crawled page.",
  };
  if (!e.crawl) return notChecked(base, NO_CRAWL);
  const measured = pages.filter((p) => p.structuredData);
  if (!measured.length)
    return notChecked(
      base,
      "Not measured: the latest crawl did not store structured data.",
      e.crawl.analyzedAt,
    );
  const withData = measured.filter((p) => p.structuredData!.length);
  const invalid = measured.filter((p) =>
    p.structuredData!.some((b) => !b.valid),
  );
  const types = uniq(
    measured.flatMap((p) =>
      p.structuredData!.filter((b) => b.valid).flatMap(schemaTypes),
    ),
  );
  if (!withData.length) {
    return {
      ...base,
      state: "not-detected",
      headline: "No structured data found",
      evidence: [`No JSON-LD in ${plural(measured.length, "crawled page")}.`],
      problems: [
        {
          code: "MISSING",
          title: "Consider adding structured data",
          summary:
            "No JSON-LD structured data was found. Describing your organization and key pages helps search engines understand them; it does not guarantee rich results.",
          severity: "LOW",
          confidence: "medium",
          action:
            "Add JSON-LD for your organization (Organization or LocalBusiness) and for page types that match your content, using only facts shown on the page.",
          urls: [],
          task: true,
        },
      ],
      checkedAt: e.crawl.analyzedAt,
    };
  }
  return {
    ...base,
    state: invalid.length ? "needs-attention" : "detected",
    headline: invalid.length
      ? `Invalid JSON-LD on ${plural(invalid.length, "page")}`
      : `Found on ${withData.length} of ${measured.length} crawled pages`,
    evidence: [
      types.length
        ? `Types: ${types.slice(0, 12).join(", ")}.`
        : "No @type declared.",
      ...(invalid.length
        ? ["Invalid blocks are tracked as SEO findings."]
        : []),
    ],
    problems: invalid.length
      ? [
          {
            code: "INVALID",
            title: "Fix invalid structured data",
            summary: `${plural(invalid.length, "page")} contain${invalid.length === 1 ? "s" : ""} JSON-LD that does not parse.`,
            severity: "MEDIUM",
            confidence: "high",
            action:
              "See the structured data SEO finding for the affected pages.",
            urls: invalid.map((p) => p.url).slice(0, MAX_URLS),
            task: false, // TECH_STRUCTURED_DATA_INVALID already tracks it
          },
        ]
      : [],
    checkedAt: e.crawl.analyzedAt,
  };
}

export const INTEGRATION_ORDER: IntegrationKey[] = [
  "GSC",
  "GA4",
  "GTM",
  "SITEMAP",
  "ROBOTS",
  "CANONICAL",
  "SCHEMA",
  "BING",
];

export function evaluateIntegrations(
  e: IntegrationEvidence,
): IntegrationStatus[] {
  const pages = analysedPages(e);
  return [
    gsc(e, pages),
    ga4(e, pages),
    gtm(e, pages),
    sitemap(e),
    robots(e),
    canonical(e, pages),
    schema(e, pages),
    bing(e, pages),
  ];
}

/** GTM container IDs found by the latest crawl (input to the probe). */
export function gtmIdsFromCrawl(e: IntegrationEvidence): string[] {
  return uniq(analysedPages(e).flatMap((p) => p.tags?.gtm ?? []));
}
