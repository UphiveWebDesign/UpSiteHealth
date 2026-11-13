import type {
  CheckOutcome,
  CrawlMode,
  CrawlRunStatus,
  IssueSeverity,
} from "@/generated/prisma/enums";
import type { Fact } from "@/lib/business/facts";
import type { StructuredDataBlock } from "@/lib/crawler/html";
import type {
  EvidencePage,
  IntegrationKey,
  IntegrationStatus,
} from "@/lib/integrations/evaluate";
import {
  canonicalisedElsewhere,
  isNoindex,
  localBusinessTypes,
} from "@/lib/seo/rules";
import {
  FAILURE_LABEL,
  type FailedSitemap,
  type SitemapState,
} from "@/lib/seo/sitemap";
import {
  gbpApplicability,
  growthProfile,
  type Applicability,
  type GrowthProfile,
} from "./profile";

/**
 * Organic Growth Starter: the foundations of a client's organic growth,
 * as tasks whose status is worked out again from stored evidence every
 * time it is shown (crawl, integration probe, monitoring, approved business
 * facts). Nothing here calls Google: where only a Google account can
 * confirm a step (Search Console, Business Profile, conversions), the task
 * says so and never reports it verified.
 *
 * VERIFIED is only ever set by an automated check. A person's word
 * (an approved fact, or an owner mark) is OWNER_MARKED_COMPLETE.
 */

export const TASK_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "NEEDS_ATTENTION",
  "OWNER_MARKED_COMPLETE",
  "VERIFIED",
  "NOT_APPLICABLE",
  "BLOCKED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STAGES = [
  { id: "foundations", title: "Website foundations" },
  { id: "search-console", title: "Google Search Console and indexing" },
  { id: "local", title: "Google Business Profile and local SEO" },
  { id: "analytics", title: "Analytics and conversion tracking" },
  { id: "content", title: "Content and keyword foundations" },
  { id: "monitoring", title: "Organic growth monitoring" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];

export type Verification = "automatic" | "partial" | "owner";
export const VERIFICATION_LABEL: Record<Verification, string> = {
  automatic:
    "Checked automatically from the crawl, integration check or monitoring.",
  partial:
    "Signals only: we can see a tag or token in the public site, not the account. The owner confirms ownership and data collection.",
  owner:
    "Owner confirms: this needs a Google account UpSiteHealth does not connect to, so it is never shown as verified.",
};

type Doc = { label: string; url: string };

export type GrowthInput = {
  now: Date;
  websiteUrl: string;
  /** Null when the business facts table is not available. */
  facts: Fact[] | null;
  integrations: IntegrationStatus[];
  crawl: {
    status: CrawlRunStatus;
    analyzedAt: Date;
    pages: EvidencePage[];
    /** What the crawl showed about the sitemap (seo/sitemap.ts). */
    sitemap?: SitemapState;
    sitemapFailures?: FailedSitemap[] | null;
  } | null;
  /** Open SEO findings, per rule and severity. */
  openFindings: Array<{
    ruleId: string;
    severity: IssueSeverity;
    count: number;
  }>;
  website: { crawlMode: CrawlMode; monitoringEnabled: boolean };
  uptime: { outcome: CheckOutcome | null; at: Date } | null;
  ssl: {
    outcome: CheckOutcome | null;
    at: Date;
    expiresAt: Date | null;
  } | null;
  performanceAt: Date | null;
  /** A person's latest mark per task (see mergeOwnerMark). */
  marks?: OwnerMark[];
};

export type OwnerMark = {
  taskId: string;
  status: "IN_PROGRESS" | "OWNER_MARKED_COMPLETE" | "NOT_STARTED";
  at: Date;
  by: string | null;
};

type Check = {
  status: TaskStatus;
  reason: string;
  evidence?: string[];
  checkedAt?: Date | null;
};

type TaskDef = {
  id: string;
  stage: StageId;
  title: string;
  why: string;
  steps: string[];
  prerequisites: string[];
  verification: Verification;
  docs: Doc[];
  /** Absent: applies to every business. */
  applies?: (p: GrowthProfile | null) => Applicability;
  check: (i: GrowthInput, ctx: Ctx) => Check;
};

type Ctx = { profile: GrowthProfile | null; done: (id: string) => boolean };

export type TaskResult = {
  id: string;
  stage: StageId;
  title: string;
  why: string;
  steps: string[];
  prerequisites: string[];
  verification: Verification;
  docs: Doc[];
  applicability: Applicability;
  status: TaskStatus;
  reason: string;
  evidence: string[];
  checkedAt: Date | null;
  /** A person's mark kept for history, even when it no longer decides. */
  mark: OwnerMark | null;
};

const DAY = 86_400_000;
const FRESH_DAYS = 30;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const path = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

/** An integration status as a task check: detected is never verified. */
function fromIntegration(
  i: GrowthInput,
  key: IntegrationKey,
  detected: TaskStatus = "IN_PROGRESS",
): Check {
  const s = i.integrations.find((x) => x.key === key);
  if (!s) return { status: "NOT_STARTED", reason: "Not checked yet." };
  const status: TaskStatus = {
    verified: "VERIFIED",
    detected,
    "needs-attention": "NEEDS_ATTENTION",
    "not-detected": "NOT_STARTED",
    "not-checked": "NOT_STARTED",
  }[s.state] as TaskStatus;
  return {
    status,
    reason: s.headline,
    evidence: [...s.evidence, ...s.problems.map((p) => p.summary)],
    checkedAt: s.checkedAt,
  };
}

const analysed = (i: GrowthInput) =>
  (i.crawl?.pages ?? []).filter(
    (p) => p.status === "CRAWLED" && p.resourceType === "HTML" && !!p.result,
  );

/** Why a crawled page cannot be indexed as itself, or null. */
function notIndexable(p: EvidencePage): string | null {
  if ((p.httpStatus ?? 0) >= 400) return `HTTP ${p.httpStatus}`;
  if (isNoindex(p)) return "noindex";
  if (canonicalisedElsewhere(p)) return `canonical points to ${p.canonicalUrl}`;
  return null;
}

const noCrawl: Check = {
  status: "BLOCKED",
  reason:
    "Blocked: this is checked from a crawl and none has been analysed yet. Start a crawl from the Crawls page.",
};

/**
 * The sitemap from the integration probe; when the probe has not run, from
 * what the latest crawl read. Both are functional checks (the file was
 * fetched and parsed), so a readable sitemap is verified.
 */
function sitemapCheck(i: GrowthInput): Check {
  const probe = fromIntegration(i, "SITEMAP");
  const s = i.crawl?.sitemap;
  const probed = i.integrations.find((x) => x.key === "SITEMAP");
  if ((probed && probed.state !== "not-checked") || !i.crawl || !s)
    return probe;
  const at = i.crawl.analyzedAt;
  const failed = (i.crawl.sitemapFailures ?? []).map(
    (f) =>
      `${path(f.url)}: ${f.httpStatus === null ? "" : `HTTP ${f.httpStatus}, `}${FAILURE_LABEL[f.failure]}`,
  );
  switch (s.state) {
    case "found":
      return failed.length
        ? {
            status: "NEEDS_ATTENTION",
            reason: `The latest crawl read ${plural(s.urls, "sitemap URL")}, but some listed sitemap files could not be read.`,
            evidence: failed,
            checkedAt: at,
          }
        : {
            status: "VERIFIED",
            reason: `The latest crawl read ${plural(s.urls, "URL")} from the sitemap.`,
            checkedAt: at,
          };
    case "empty":
      return {
        status: "NEEDS_ATTENTION",
        reason: "The sitemap loads but lists no page URLs.",
        checkedAt: at,
      };
    case "missing":
      return {
        status: "NEEDS_ATTENTION",
        reason:
          "No sitemap: robots.txt lists none and /sitemap.xml returns 404 or 410.",
        checkedAt: at,
      };
    case "unreachable":
      return {
        status: "NEEDS_ATTENTION",
        reason: "A listed sitemap could not be read.",
        evidence: failed,
        checkedAt: at,
      };
    case "inconclusive":
      return {
        status: "NOT_STARTED",
        reason: `Not established: ${s.reason} Run an integration check or crawl again.`,
        checkedAt: at,
      };
    case "unknown":
      return probe;
  }
}

const DOCS = {
  robots: {
    label: "Google: introduction to robots.txt",
    url: "https://developers.google.com/search/docs/crawling-indexing/robots/intro",
  },
  sitemap: {
    label: "Google: build and submit a sitemap",
    url: "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap",
  },
  noindex: {
    label: "Google: block indexing with noindex",
    url: "https://developers.google.com/search/docs/crawling-indexing/block-indexing",
  },
  canonical: {
    label: "Google: canonical URLs",
    url: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
  },
  gscVerify: {
    label: "Search Console Help: verify your site ownership",
    url: "https://support.google.com/webmasters/answer/9008080",
  },
  gscSitemaps: {
    label: "Search Console Help: Sitemaps report",
    url: "https://support.google.com/webmasters/answer/7451001",
  },
  gbpEligibility: {
    label: "Business Profile Help: eligibility and ownership guidelines",
    url: "https://support.google.com/business/answer/13763036",
  },
  gbpGuidelines: {
    label: "Business Profile Help: guidelines for representing your business",
    url: "https://support.google.com/business/answer/3038177",
  },
  gbpAreas: {
    label: "Business Profile Help: manage service areas",
    url: "https://support.google.com/business/answer/9157481",
  },
  localBusiness: {
    label: "Google: LocalBusiness structured data",
    url: "https://developers.google.com/search/docs/appearance/structured-data/local-business",
  },
  ga4: {
    label: "Analytics Help: set up Analytics for a website",
    url: "https://support.google.com/analytics/answer/9304153",
  },
  keyEvents: {
    label: "Analytics Help: mark events as key events",
    url: "https://support.google.com/analytics/answer/13128484",
  },
  titles: {
    label: "Google: title links in search results",
    url: "https://developers.google.com/search/docs/appearance/title-link",
  },
  snippets: {
    label: "Google: snippets and meta descriptions",
    url: "https://developers.google.com/search/docs/appearance/snippet",
  },
} satisfies Record<string, Doc>;

const gbp = (p: GrowthProfile | null): Applicability =>
  p
    ? gbpApplicability(p)
    : {
        state: "review",
        reason:
          "Business facts are not available on this database, so eligibility cannot be assessed.",
      };

const SNIPPET_RULES = [
  "TECH_TITLE_MISSING",
  "TECH_DUPLICATE_TITLE",
  "TECH_META_DESCRIPTION_MISSING",
  "TECH_DUPLICATE_META_DESCRIPTION",
];

export const TASKS: TaskDef[] = [
  // ── Website foundations ────────────────────────────────────────────────
  {
    id: "site-reachable",
    stage: "foundations",
    title: "Site loads reliably",
    why: "Search engines and visitors must be able to reach the site.",
    steps: [
      "Keep uptime monitoring on for the website.",
      "Investigate any failed check on the Monitoring page.",
    ],
    prerequisites: [],
    verification: "automatic",
    docs: [],
    check: (i) =>
      !i.uptime
        ? { status: "NOT_STARTED", reason: "No uptime check has run yet." }
        : i.uptime.outcome === "SUCCESS"
          ? {
              status: "VERIFIED",
              reason: "The latest uptime check succeeded.",
              checkedAt: i.uptime.at,
            }
          : {
              status: "NEEDS_ATTENTION",
              reason: `The latest uptime check failed (${(i.uptime.outcome ?? "unknown").toLowerCase().replace(/_/g, " ")}).`,
              checkedAt: i.uptime.at,
            },
  },
  {
    id: "https",
    stage: "foundations",
    title: "HTTPS with a valid certificate",
    why: "Browsers warn visitors about insecure or expired certificates.",
    steps: [
      "Serve every page over HTTPS and redirect HTTP to HTTPS.",
      "Renew the certificate before it expires (automatic renewal is best).",
    ],
    prerequisites: [],
    verification: "automatic",
    docs: [],
    check: (i) => {
      if (i.websiteUrl.startsWith("http://"))
        return {
          status: "NEEDS_ATTENTION",
          reason: "The website address is set to HTTP, not HTTPS.",
        };
      if (!i.ssl)
        return {
          status: "NOT_STARTED",
          reason: "No certificate check has run yet.",
        };
      const expires = i.ssl.expiresAt
        ? [`Certificate expires ${i.ssl.expiresAt.toISOString().slice(0, 10)}.`]
        : [];
      return i.ssl.outcome === "SUCCESS"
        ? {
            status: "VERIFIED",
            reason: "The latest certificate check passed.",
            evidence: expires,
            checkedAt: i.ssl.at,
          }
        : {
            status: "NEEDS_ATTENTION",
            reason: `The latest certificate check reported: ${(i.ssl.outcome ?? "unknown").toLowerCase().replace(/_/g, " ")}.`,
            evidence: expires,
            checkedAt: i.ssl.at,
          };
    },
  },
  {
    id: "robots-txt",
    stage: "foundations",
    title: "robots.txt allows crawling",
    why: "robots.txt tells crawlers what they may fetch; a mistake can hide the whole site.",
    steps: [
      "Make sure robots.txt does not disallow pages you want in search.",
      "List the XML sitemap in robots.txt.",
    ],
    prerequisites: [],
    verification: "automatic",
    docs: [DOCS.robots],
    check: (i) => fromIntegration(i, "ROBOTS"),
  },
  {
    id: "xml-sitemap",
    stage: "foundations",
    title: "XML sitemap is published and readable",
    why: "A sitemap helps search engines discover the pages you want indexed. It does not guarantee indexing.",
    steps: [
      "Publish an XML sitemap of the indexable pages (most CMSs generate one).",
      "Make sure it returns HTTP 200 and lists live, indexable URLs only.",
      "Reference it in robots.txt.",
    ],
    prerequisites: [],
    verification: "automatic",
    docs: [DOCS.sitemap],
    check: sitemapCheck,
  },
  {
    id: "homepage-indexable",
    stage: "foundations",
    title: "Home page can be indexed",
    why: "If the home page returns an error, is noindex or canonicalises elsewhere, it cannot appear in search as itself.",
    steps: [
      "Remove any noindex from the home page.",
      "Make its canonical tag point to itself (or remove it).",
    ],
    prerequisites: [],
    verification: "automatic",
    docs: [DOCS.noindex, DOCS.canonical],
    check: (i) => {
      if (!i.crawl) return noCrawl;
      const home = analysed(i).find((p) => p.depth === 0);
      if (!home)
        return {
          status: "NEEDS_ATTENTION",
          reason: "The latest crawl could not analyse the home page.",
          checkedAt: i.crawl.analyzedAt,
        };
      const why = notIndexable(home);
      return why
        ? {
            status: "NEEDS_ATTENTION",
            reason: `The home page is not indexable: ${why}.`,
            evidence: [home.url],
            checkedAt: i.crawl.analyzedAt,
          }
        : {
            status: "VERIFIED",
            reason:
              "The home page loads, has no noindex and is its own canonical.",
            evidence: [home.url],
            checkedAt: i.crawl.analyzedAt,
          };
    },
  },
  {
    id: "key-pages-indexable",
    stage: "foundations",
    title: "Pages linked from the home page can be indexed",
    why: "Pages linked from the home page are usually the most important ones (services, products, contact).",
    steps: [
      "For each page listed, remove noindex, fix the error, or correct the canonical, unless it is meant to stay out of search.",
    ],
    prerequisites: ["Home page can be indexed"],
    verification: "automatic",
    docs: [DOCS.noindex, DOCS.canonical],
    check: (i) => {
      if (!i.crawl) return noCrawl;
      const linked = (i.crawl.pages ?? []).filter(
        (p) =>
          p.depth === 1 &&
          p.status === "CRAWLED" &&
          p.resourceType === "HTML" &&
          (!!p.result || (p.httpStatus ?? 0) >= 400),
      );
      if (!linked.length)
        return {
          status: "NOT_STARTED",
          reason:
            "The latest crawl analysed no pages linked from the home page.",
          checkedAt: i.crawl.analyzedAt,
        };
      const bad = linked
        .map((p) => [p, notIndexable(p)] as const)
        .filter(([, why]) => why);
      return bad.length
        ? {
            status: "NEEDS_ATTENTION",
            reason: `${plural(bad.length, "page")} of ${linked.length} linked from the home page cannot be indexed as itself.`,
            evidence: bad
              .slice(0, 8)
              .map(([p, why]) => `${path(p.url)}: ${why}`),
            checkedAt: i.crawl.analyzedAt,
          }
        : {
            status: "VERIFIED",
            reason: `All ${plural(linked.length, "page")} linked from the home page can be indexed.`,
            checkedAt: i.crawl.analyzedAt,
          };
    },
  },
  {
    id: "no-high-findings",
    stage: "foundations",
    title: "No high-severity technical SEO problems",
    why: "High-severity findings (for example error pages) stop pages being crawled or shown.",
    steps: ["Work through the high-severity items on the SEO findings page."],
    prerequisites: [],
    verification: "automatic",
    docs: [],
    check: (i) => {
      if (!i.crawl) return noCrawl;
      const high = i.openFindings.filter(
        (f) => f.severity === "HIGH" || f.severity === "CRITICAL",
      );
      const n = high.reduce((s, f) => s + f.count, 0);
      return n
        ? {
            status: "NEEDS_ATTENTION",
            reason: `${plural(n, "open high-severity finding")}.`,
            evidence: high.map((f) => `${f.ruleId}: ${f.count}`),
            checkedAt: i.crawl.analyzedAt,
          }
        : {
            status: "VERIFIED",
            reason: "No open high-severity findings after the latest crawl.",
            checkedAt: i.crawl.analyzedAt,
          };
    },
  },

  // ── Search Console and indexing ────────────────────────────────────────
  {
    id: "gsc-verified",
    stage: "search-console",
    title: "Search Console property verified",
    why: "Search Console is Google's own report of indexing, queries and errors for the site.",
    steps: [
      "Add the site in Search Console (a Domain property covers every subdomain and protocol).",
      "Verify ownership (DNS TXT record for a Domain property; HTML tag or file for a URL-prefix property).",
      "Give the agency's Google account access.",
    ],
    prerequisites: ["Access to the domain's DNS, or to the site's HTML"],
    verification: "partial",
    docs: [DOCS.gscVerify],
    check: (i) => {
      const c = fromIntegration(i, "GSC");
      return c.status === "IN_PROGRESS"
        ? {
            ...c,
            reason:
              "A Search Console verification token is on the site or in DNS. This shows verification was started; it does not prove the property is verified, who owns it, or that its data is available. Confirm access in Search Console.",
          }
        : c;
    },
  },
  {
    id: "gsc-sitemap",
    stage: "search-console",
    title: "Sitemap submitted in Search Console",
    why: "Submitting the sitemap lets Search Console report how many listed pages are indexed.",
    steps: [
      "In Search Console, open Sitemaps and submit the sitemap URL.",
      "Check that the status is Success and review any reported errors.",
    ],
    prerequisites: [
      "Search Console property verified",
      "XML sitemap is published and readable",
    ],
    verification: "owner",
    docs: [DOCS.gscSitemaps],
    check: (_i, ctx) =>
      !ctx.done("xml-sitemap")
        ? {
            status: "BLOCKED",
            reason:
              "Blocked: the task “XML sitemap is published and readable” is not complete. Submit the sitemap once it loads.",
          }
        : {
            status: "NOT_STARTED",
            reason:
              "Cannot be checked without a Search Console connection; the owner confirms it.",
          },
  },

  // ── Google Business Profile and local SEO ──────────────────────────────
  {
    id: "gbp-profile",
    stage: "local",
    title: "Google Business Profile claimed and verified",
    why: "For eligible businesses, the Business Profile is what appears in Google Maps and local results.",
    steps: [
      "Check eligibility against Google's guidelines (in-person contact with customers during stated hours).",
      "Claim or create the profile with the exact business name used in the real world.",
      "Set the address (only if customers are served there) and/or the service areas, then complete verification.",
      "Use the same name, address and phone number as the website.",
    ],
    prerequisites: ["Eligibility confirmed"],
    verification: "owner",
    docs: [DOCS.gbpEligibility, DOCS.gbpGuidelines, DOCS.gbpAreas],
    applies: gbp,
    check: () => ({
      status: "NOT_STARTED",
      reason:
        "Cannot be checked without a Business Profile connection; the owner confirms it.",
    }),
  },
  {
    id: "local-business-markup",
    stage: "local",
    title: "LocalBusiness structured data with address",
    why: "Structured data states the business name, address and phone in a form search engines read reliably.",
    steps: [
      "Add LocalBusiness (or a more specific type) JSON-LD to the home or contact page.",
      "Include name, address and telephone exactly as shown on the page and on the Business Profile.",
    ],
    prerequisites: [],
    verification: "automatic",
    docs: [DOCS.localBusiness],
    applies: gbp,
    check: (i) => {
      if (!i.crawl) return noCrawl;
      const pages = analysed(i)
        .map((p) => ({
          url: p.url,
          types: localBusinessTypes(
            ((p.result as { structuredData?: StructuredDataBlock[] })
              .structuredData ?? []) as StructuredDataBlock[],
          ),
        }))
        .filter((p) => p.types.length);
      if (!pages.length)
        return {
          status: "NOT_STARTED",
          reason: `No LocalBusiness markup on the ${plural(analysed(i).length, "analysed page")}.`,
          checkedAt: i.crawl.analyzedAt,
        };
      const incomplete = i.openFindings.find(
        (f) => f.ruleId === "TECH_LOCAL_BUSINESS_INCOMPLETE",
      );
      const evidence = pages
        .slice(0, 5)
        .map((p) => `${path(p.url)}: ${p.types.join(", ")}`);
      return incomplete
        ? {
            status: "NEEDS_ATTENTION",
            reason:
              "LocalBusiness markup found, but it leaves out the address or telephone.",
            evidence,
            checkedAt: i.crawl.analyzedAt,
          }
        : {
            status: "VERIFIED",
            reason: `LocalBusiness markup found on ${plural(pages.length, "page")}.`,
            evidence,
            checkedAt: i.crawl.analyzedAt,
          };
    },
  },

  // ── Analytics and conversion tracking ──────────────────────────────────
  {
    id: "ga4",
    stage: "analytics",
    title: "Google Analytics 4 installed",
    why: "Analytics measures visits and conversions. It does not affect rankings.",
    steps: [
      "Create a GA4 property and a web data stream.",
      "Install the Google tag (directly or through Tag Manager) on every page.",
      "Confirm data arrives in the Realtime report.",
    ],
    prerequisites: [],
    verification: "partial",
    docs: [DOCS.ga4],
    check: (i) => {
      const c = fromIntegration(i, "GA4");
      return c.status === "IN_PROGRESS"
        ? {
            ...c,
            reason: `${c.reason}. The tag is in the public page source; that does not show the property receives data, or who owns it. Check the Realtime report in GA4.`,
          }
        : c;
    },
  },
  {
    id: "conversion-goals",
    stage: "analytics",
    title: "Conversion goals agreed",
    why: "Growth is measured against what visitors should do: call, enquire, book, buy or visit.",
    steps: ["Add and approve the business's goals on the Business page."],
    prerequisites: [],
    verification: "owner",
    docs: [],
    check: (i, ctx) =>
      !ctx.profile
        ? {
            status: "BLOCKED",
            reason:
              "Blocked: business facts are not available on this database (migration 1_business_facts missing).",
          }
        : ctx.profile.goals.length
          ? {
              status: "OWNER_MARKED_COMPLETE",
              reason:
                "Recorded by a person (approved goals on the Business page). This is their word, not an automated check.",
              evidence: ctx.profile.goals,
            }
          : { status: "NOT_STARTED", reason: "No approved goals yet." },
  },
  {
    id: "conversion-tracking",
    stage: "analytics",
    title: "Conversions tracked as GA4 key events",
    why: "Without key events, analytics shows visits but not results.",
    steps: [
      "Create an event for each agreed goal (form submitted, phone link clicked, booking, purchase).",
      "Mark those events as key events in GA4.",
      "Test each one and confirm it appears in the reports.",
    ],
    prerequisites: ["Google Analytics 4 installed", "Conversion goals agreed"],
    verification: "owner",
    docs: [DOCS.keyEvents],
    check: (_i, ctx) =>
      !ctx.done("conversion-goals")
        ? {
            status: "BLOCKED",
            reason:
              "Blocked: no approved conversion goals yet. Add and approve them on the Business page first.",
          }
        : {
            status: "NOT_STARTED",
            reason:
              "Cannot be checked without a GA4 connection; the owner confirms it.",
          },
  },

  // ── Content and keyword foundations ────────────────────────────────────
  {
    id: "business-profile",
    stage: "content",
    title: "Services and target locations documented",
    why: "Content and keyword work starts from what the business offers and where. Business Profile applicability also depends on it.",
    steps: [
      "On the Business page, add and approve the business type, services, premises (if customers visit) and service areas.",
      "Record whether the business is local, e-commerce, SaaS, national, hybrid or other.",
    ],
    prerequisites: [],
    verification: "owner",
    docs: [],
    check: (_i, ctx) => {
      const p = ctx.profile;
      if (!p)
        return {
          status: "BLOCKED",
          reason:
            "Blocked: business facts are not available on this database (migration 1_business_facts missing).",
        };
      const missing = [
        !p.types.length && "business type",
        !p.services.length && "services",
      ].filter(Boolean);
      if (!missing.length)
        return {
          status: "OWNER_MARKED_COMPLETE",
          reason:
            "Recorded by a person (approved business facts). This is their word, not an automated check.",
          evidence: [
            `Services: ${p.services.join(", ")}`,
            ...(p.premises.length
              ? [`Premises: ${p.premises.join(", ")}`]
              : []),
            ...(p.serviceAreas.length
              ? [`Service areas: ${p.serviceAreas.join(", ")}`]
              : []),
          ],
        };
      return {
        status:
          p.types.length || p.services.length ? "IN_PROGRESS" : "NOT_STARTED",
        reason: `Missing approved ${missing.join(" and ")}.`,
      };
    },
  },
  {
    id: "titles-descriptions",
    stage: "content",
    title: "Every page has a unique title and description",
    why: "Titles and descriptions are what searchers see in results; duplicates make pages hard to tell apart.",
    steps: [
      "Write a unique title (15–60 characters) naming the page's service or topic.",
      "Write a unique meta description (50–160 characters).",
    ],
    prerequisites: [],
    verification: "automatic",
    docs: [DOCS.titles, DOCS.snippets],
    check: (i) => {
      if (!i.crawl) return noCrawl;
      const open = i.openFindings.filter((f) =>
        SNIPPET_RULES.includes(f.ruleId),
      );
      const byRule = new Map<string, number>();
      for (const f of open)
        byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + f.count);
      return byRule.size
        ? {
            status: "NEEDS_ATTENTION",
            reason:
              "Open findings for missing or duplicate titles or descriptions.",
            evidence: [...byRule].map(([r, n]) => `${r}: ${n}`),
            checkedAt: i.crawl.analyzedAt,
          }
        : {
            status: "VERIFIED",
            reason:
              "No missing or duplicate titles or descriptions on analysed pages.",
            checkedAt: i.crawl.analyzedAt,
          };
    },
  },

  // ── Organic growth monitoring ──────────────────────────────────────────
  {
    id: "automatic-crawls",
    stage: "monitoring",
    title: "Automatic weekly crawls on",
    why: "Regular crawls keep the checks on this page current and confirm fixes.",
    steps: ["Set the crawl mode to Automatic in the website settings."],
    prerequisites: [],
    verification: "automatic",
    docs: [],
    check: (i) =>
      i.website.crawlMode === "AUTOMATIC"
        ? { status: "VERIFIED", reason: "Crawl mode is Automatic." }
        : {
            status: "NOT_STARTED",
            reason:
              "Crawl mode is Manual: the site is crawled only on request.",
          },
  },
  {
    id: "recent-crawl",
    stage: "monitoring",
    title: `Complete crawl in the last ${FRESH_DAYS} days`,
    why: "Checks based on an old or partial crawl may no longer describe the site.",
    steps: ["Start a crawl, or turn on automatic crawls."],
    prerequisites: [],
    verification: "automatic",
    docs: [],
    check: (i) => {
      if (!i.crawl)
        return { status: "NOT_STARTED", reason: "No analysed crawl yet." };
      const age = Math.floor(
        (i.now.getTime() - i.crawl.analyzedAt.getTime()) / DAY,
      );
      if (i.crawl.status !== "COMPLETED")
        return {
          status: "NEEDS_ATTENTION",
          reason: `The latest analysed crawl is ${i.crawl.status.toLowerCase()}, not complete.`,
          checkedAt: i.crawl.analyzedAt,
        };
      return age > FRESH_DAYS
        ? {
            status: "NEEDS_ATTENTION",
            reason: `The latest complete crawl is ${age} days old.`,
            checkedAt: i.crawl.analyzedAt,
          }
        : {
            status: "VERIFIED",
            reason: `Complete crawl ${age === 0 ? "today" : `${plural(age, "day")} ago`}.`,
            checkedAt: i.crawl.analyzedAt,
          };
    },
  },
  {
    id: "uptime-monitoring",
    stage: "monitoring",
    title: "Uptime monitoring on",
    why: "Outages are found before clients or search engines notice them.",
    steps: ["Enable monitoring in the website settings."],
    prerequisites: [],
    verification: "automatic",
    docs: [],
    check: (i) =>
      i.website.monitoringEnabled
        ? { status: "VERIFIED", reason: "Monitoring is enabled." }
        : { status: "NOT_STARTED", reason: "Monitoring is disabled." },
  },
  {
    id: "performance-baseline",
    stage: "monitoring",
    title: `Page speed measured in the last ${FRESH_DAYS} days`,
    why: "A recent speed measurement is the baseline for user-experience work.",
    steps: ["Run a PageSpeed check from the website overview."],
    prerequisites: [],
    verification: "automatic",
    docs: [],
    check: (i) => {
      if (!i.performanceAt)
        return {
          status: "NOT_STARTED",
          reason: "No PageSpeed measurement yet.",
        };
      const age = Math.floor(
        (i.now.getTime() - i.performanceAt.getTime()) / DAY,
      );
      return age > FRESH_DAYS
        ? {
            status: "NEEDS_ATTENTION",
            reason: `The latest measurement is ${age} days old.`,
            checkedAt: i.performanceAt,
          }
        : {
            status: "VERIFIED",
            reason: "Measured recently.",
            checkedAt: i.performanceAt,
          };
    },
  },
];

const COMPLETE: TaskStatus[] = ["VERIFIED", "OWNER_MARKED_COMPLETE"];

/**
 * Combines the automated check with a person's mark. An automated result
 * is never overridden by a mark: VERIFIED stays verified, and a problem
 * the latest check found stays NEEDS_ATTENTION even if someone marked the
 * task done. A mark only fills in what automation cannot see.
 */
export function mergeOwnerMark(check: Check, mark: OwnerMark | null): Check {
  if (!mark) return check;
  if (check.status === "VERIFIED" || check.status === "BLOCKED") return check;
  if (check.status === "NEEDS_ATTENTION")
    return mark.status === "OWNER_MARKED_COMPLETE"
      ? {
          ...check,
          reason: `${check.reason} (Marked complete on ${mark.at.toISOString().slice(0, 10)}, but the latest check disagrees.)`,
        }
      : check;
  if (mark.status === "NOT_STARTED") return check;
  return {
    ...check,
    status: mark.status,
    reason:
      mark.status === "OWNER_MARKED_COMPLETE"
        ? `Marked complete by ${mark.by ?? "a team member"} on ${mark.at.toISOString().slice(0, 10)}. Not verified automatically.`
        : `Marked in progress on ${mark.at.toISOString().slice(0, 10)}.`,
  };
}

/** Every task, evaluated in catalogue order (prerequisites first). */
export function evaluateGrowth(i: GrowthInput): TaskResult[] {
  const profile = i.facts ? growthProfile(i.facts) : null;
  const results = new Map<string, TaskResult>();
  const ctx: Ctx = {
    profile,
    done: (id) => COMPLETE.includes(results.get(id)?.status ?? "NOT_STARTED"),
  };
  const marks = new Map((i.marks ?? []).map((m) => [m.taskId, m]));
  for (const t of TASKS) {
    const applicability: Applicability = t.applies
      ? t.applies(profile)
      : { state: "applies", reason: "Applies to every business." };
    const mark = marks.get(t.id) ?? null;
    let check: Check;
    if (applicability.state === "not-applicable")
      // The mark is kept (history), but no longer decides anything.
      check = { status: "NOT_APPLICABLE", reason: applicability.reason };
    else if (applicability.state === "review")
      check = {
        status: "BLOCKED",
        reason: `Eligibility review required: ${applicability.reason} Once decided, record premises or service areas (or the business type) on the Business page.`,
      };
    else check = mergeOwnerMark(t.check(i, ctx), mark);
    results.set(t.id, {
      id: t.id,
      stage: t.stage,
      title: t.title,
      why: t.why,
      steps: t.steps,
      prerequisites: t.prerequisites,
      verification: t.verification,
      docs: t.docs,
      applicability,
      status: check.status,
      reason: check.reason,
      evidence: check.evidence ?? [],
      checkedAt: check.checkedAt ?? null,
      mark,
    });
  }
  return [...results.values()];
}

export type GrowthProgress = {
  /** Tasks counted: everything except NOT_APPLICABLE. */
  applicable: number;
  complete: number;
  verified: number;
  ownerMarked: number;
  needsAttention: number;
  blocked: number;
  notApplicable: number;
  /** complete / applicable, rounded down; null when nothing applies. */
  percent: number | null;
};

/**
 * Progress over applicable tasks. NOT_APPLICABLE is excluded; a task awaiting
 * an eligibility review is counted (it is not proven not to apply), so the
 * percentage never runs ahead of what is known.
 */
export function growthProgress(
  tasks: Array<Pick<TaskResult, "status">>,
): GrowthProgress {
  const n = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const notApplicable = n("NOT_APPLICABLE");
  const applicable = tasks.length - notApplicable;
  const verified = n("VERIFIED");
  const ownerMarked = n("OWNER_MARKED_COMPLETE");
  const complete = verified + ownerMarked;
  return {
    applicable,
    complete,
    verified,
    ownerMarked,
    needsAttention: n("NEEDS_ATTENTION"),
    blocked: n("BLOCKED"),
    notApplicable,
    percent: applicable ? Math.floor((complete / applicable) * 100) : null,
  };
}
