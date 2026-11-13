import { describe, expect, test } from "vitest";
import type { Fact } from "@/lib/business/facts";
import type { EvidencePage } from "@/lib/integrations/evaluate";
import { gbpApplicability, growthProfile } from "./profile";
import {
  evaluateGrowth,
  growthProgress,
  mergeOwnerMark,
  TASKS,
  type GrowthInput,
  type TaskResult,
} from "./tasks";

let n = 0;
const fact = (
  kind: Fact["kind"],
  value: string,
  status: Fact["status"] = "APPROVED",
): Fact => ({
  id: `f${n++}`,
  kind,
  value,
  synonyms: [],
  source: "CLIENT",
  status,
});
const gbp = (...facts: Fact[]) => gbpApplicability(growthProfile(facts));

describe("business model and Google Business Profile applicability", () => {
  test("a local business with premises customers visit: applies", () => {
    const a = gbp(
      fact("BUSINESS_TYPE", "local-service"),
      fact("LOCATION", "Leeds"),
      fact("GOAL", "visits"),
    );
    expect(a.state).toBe("applies");
    expect(a.reason).toContain("Leeds");
  });

  test("a local service business that travels to customers: applies as a service-area business", () => {
    const a = gbp(
      fact("BUSINESS_TYPE", "local-service"),
      fact("SERVICE_AREA", "West Yorkshire"),
    );
    expect(a).toMatchObject({ state: "applies" });
    expect(a.reason).toMatch(/Hide the address/);
  });

  test.each([["ecommerce"], ["saas"]])(
    "online-only %s with no premises: not applicable",
    (type) => {
      expect(gbp(fact("BUSINESS_TYPE", type)).state).toBe("not-applicable");
    },
  );

  test("hybrid: an online shop with a showroom customers visit applies", () => {
    const facts = [
      fact("BUSINESS_TYPE", "ecommerce"),
      fact("BUSINESS_TYPE", "local-service"),
      fact("LOCATION", "York showroom"),
    ];
    expect(growthProfile(facts).model).toBe("hybrid");
    expect(gbp(...facts).state).toBe("applies");
  });

  test.each([["national-service"], ["b2b"], ["other"]])(
    "an ambiguous %s business goes to review, never forced either way",
    (type) => {
      const a = gbp(fact("BUSINESS_TYPE", type), fact("SERVICE_AREA", "UK"));
      expect(a.state).toBe("review");
      expect(a.reason).toMatch(/virtual office/);
    },
  );

  test("no approved business type: review; pending facts count for nothing", () => {
    expect(gbp().state).toBe("review");
    expect(gbp(fact("LOCATION", "Leeds", "PENDING")).state).toBe("review");
    expect(
      gbp(fact("BUSINESS_TYPE", "saas"), fact("LOCATION", "Leeds", "REJECTED"))
        .state,
    ).toBe("not-applicable");
  });

  test("a local type with no premises or area needs review", () => {
    expect(gbp(fact("BUSINESS_TYPE", "hospitality")).state).toBe("review");
  });
});

const NOW = new Date("2026-11-01T12:00:00Z");
const page = (over: Partial<EvidencePage>): EvidencePage => ({
  url: "https://site.example/",
  status: "CRAWLED",
  httpStatus: 200,
  resourceType: "HTML",
  finalUrl: null,
  canonicalUrl: null,
  robotsMetaRaw: null,
  depth: 0,
  result: { structuredData: [] },
  ...over,
});
const input = (over: Partial<GrowthInput> = {}): GrowthInput => ({
  now: NOW,
  websiteUrl: "https://site.example/",
  facts: [],
  integrations: [],
  crawl: {
    status: "COMPLETED",
    analyzedAt: new Date("2026-10-30T12:00:00Z"),
    pages: [page({})],
  },
  openFindings: [],
  website: { crawlMode: "AUTOMATIC", monitoringEnabled: true },
  uptime: { outcome: "SUCCESS", at: NOW },
  ssl: { outcome: "SUCCESS", at: NOW, expiresAt: null },
  performanceAt: null,
  ...over,
});
const task = (tasks: TaskResult[], id: string) =>
  tasks.find((t) => t.id === id)!;

describe("task evaluation", () => {
  test("SaaS: Business Profile and local markup are not applicable, and excluded from progress", () => {
    const tasks = evaluateGrowth(
      input({ facts: [fact("BUSINESS_TYPE", "saas")] }),
    );
    expect(task(tasks, "gbp-profile").status).toBe("NOT_APPLICABLE");
    expect(task(tasks, "local-business-markup").status).toBe("NOT_APPLICABLE");
    const p = growthProgress(tasks);
    expect(p.notApplicable).toBe(2);
    expect(p.applicable).toBe(TASKS.length - 2);
  });

  test("an ambiguous business blocks the Business Profile task for review, and still counts", () => {
    const tasks = evaluateGrowth(
      input({ facts: [fact("BUSINESS_TYPE", "national-service")] }),
    );
    const t = task(tasks, "gbp-profile");
    expect(t.status).toBe("BLOCKED");
    expect(t.reason).toMatch(/^Eligibility review required/);
    expect(growthProgress(tasks).applicable).toBe(TASKS.length);
  });

  test("Business Profile is never reported verified: no Google connection", () => {
    const tasks = evaluateGrowth(
      input({
        facts: [
          fact("BUSINESS_TYPE", "local-service"),
          fact("LOCATION", "Leeds"),
        ],
      }),
    );
    expect(task(tasks, "gbp-profile").status).toBe("NOT_STARTED");
    expect(task(tasks, "gbp-profile").verification).toBe("owner");
  });

  test("home page: noindex needs attention; an indexable one is verified with the crawl date", () => {
    const bad = evaluateGrowth(
      input({
        crawl: {
          status: "COMPLETED",
          analyzedAt: NOW,
          pages: [page({ robotsMetaRaw: "noindex" })],
        },
      }),
    );
    expect(task(bad, "homepage-indexable")).toMatchObject({
      status: "NEEDS_ATTENTION",
      reason: "The home page is not indexable: noindex.",
    });
    const ok = task(evaluateGrowth(input()), "homepage-indexable");
    expect(ok.status).toBe("VERIFIED");
    expect(ok.checkedAt).toEqual(new Date("2026-10-30T12:00:00Z"));
  });

  test("pages linked from the home page: lists those that cannot be indexed", () => {
    const tasks = evaluateGrowth(
      input({
        crawl: {
          status: "COMPLETED",
          analyzedAt: NOW,
          pages: [
            page({}),
            page({ url: "https://site.example/a", depth: 1 }),
            page({
              url: "https://site.example/b",
              depth: 1,
              canonicalUrl: "https://site.example/a",
            }),
            page({
              url: "https://site.example/c",
              depth: 1,
              httpStatus: 404,
              result: null,
            }),
          ],
        },
      }),
    );
    expect(task(tasks, "key-pages-indexable")).toMatchObject({
      status: "NEEDS_ATTENTION",
      reason:
        "2 pages of 3 linked from the home page cannot be indexed as itself.",
      evidence: [
        "/b: canonical points to https://site.example/a",
        "/c: HTTP 404",
      ],
    });
  });

  test("without a crawl, crawl-based tasks are blocked, not failed", () => {
    const tasks = evaluateGrowth(input({ crawl: null }));
    expect(task(tasks, "homepage-indexable").status).toBe("BLOCKED");
    expect(task(tasks, "titles-descriptions").status).toBe("BLOCKED");
  });

  test("a detected GA4 tag is in progress, never verified", () => {
    const tasks = evaluateGrowth(
      input({
        integrations: [
          {
            key: "GA4",
            name: "Google Analytics 4",
            benefit: "measurement",
            optional: false,
            state: "detected",
            headline: "G-ABC123 found on 5 pages",
            evidence: [],
            limitations: [],
            problems: [],
            verification: "",
            checkedAt: NOW,
          },
        ],
      }),
    );
    expect(task(tasks, "ga4").status).toBe("IN_PROGRESS");
    expect(task(tasks, "ga4").reason).toMatch(
      /does not show the property receives data, or who owns it/,
    );
  });

  test("approved goals are a person's word (owner complete), and unblock conversion tracking", () => {
    const blocked = evaluateGrowth(input());
    expect(task(blocked, "conversion-tracking").status).toBe("BLOCKED");
    const tasks = evaluateGrowth(input({ facts: [fact("GOAL", "calls")] }));
    expect(task(tasks, "conversion-goals").status).toBe(
      "OWNER_MARKED_COMPLETE",
    );
    expect(task(tasks, "conversion-tracking").status).toBe("NOT_STARTED");
  });

  test("facts table unavailable: profile-based tasks are blocked, GBP goes to review", () => {
    const tasks = evaluateGrowth(input({ facts: null }));
    expect(task(tasks, "business-profile").status).toBe("BLOCKED");
    expect(task(tasks, "gbp-profile").applicability.state).toBe("review");
  });

  test("stale crawl and missing speed measurement", () => {
    const tasks = evaluateGrowth(
      input({
        crawl: {
          status: "COMPLETED",
          analyzedAt: new Date("2026-09-01T00:00:00Z"),
          pages: [page({})],
        },
      }),
    );
    expect(task(tasks, "recent-crawl").status).toBe("NEEDS_ATTENTION");
    expect(task(tasks, "performance-baseline").status).toBe("NOT_STARTED");
  });
});

describe("owner marks never outrank automated checks", () => {
  const mark = {
    taskId: "x",
    status: "OWNER_MARKED_COMPLETE" as const,
    at: NOW,
    by: "Sam",
  };
  test("a mark fills in what automation cannot see", () => {
    expect(
      mergeOwnerMark({ status: "NOT_STARTED", reason: "Unknown." }, mark),
    ).toMatchObject({
      status: "OWNER_MARKED_COMPLETE",
      reason:
        "Marked complete by Sam on 2026-11-01. Not verified automatically.",
    });
  });
  test("a problem the latest check found stays NEEDS_ATTENTION", () => {
    const r = mergeOwnerMark(
      { status: "NEEDS_ATTENTION", reason: "noindex." },
      mark,
    );
    expect(r.status).toBe("NEEDS_ATTENTION");
    expect(r.reason).toMatch(/latest check disagrees/);
  });
  test("VERIFIED and BLOCKED are unchanged", () => {
    for (const status of ["VERIFIED", "BLOCKED"] as const)
      expect(mergeOwnerMark({ status, reason: "r" }, mark).status).toBe(status);
  });
  test("a not-applicable task keeps its mark for history", () => {
    const tasks = evaluateGrowth(
      input({
        facts: [fact("BUSINESS_TYPE", "saas")],
        marks: [{ ...mark, taskId: "gbp-profile" }],
      }),
    );
    expect(task(tasks, "gbp-profile")).toMatchObject({
      status: "NOT_APPLICABLE",
      mark: { taskId: "gbp-profile", by: "Sam" },
    });
  });
});

describe("progress", () => {
  test("excludes not-applicable, separates verified from owner-marked", () => {
    expect(
      growthProgress([
        { status: "VERIFIED" },
        { status: "OWNER_MARKED_COMPLETE" },
        { status: "NEEDS_ATTENTION" },
        { status: "NOT_APPLICABLE" },
      ]),
    ).toMatchObject({
      applicable: 3,
      complete: 2,
      verified: 1,
      ownerMarked: 1,
      percent: 66,
    });
    expect(growthProgress([{ status: "NOT_APPLICABLE" }]).percent).toBeNull();
  });
});

describe("wording and fallbacks", () => {
  const integration = (
    key: "GSC" | "SITEMAP",
    state: "detected" | "not-checked",
  ) => ({
    key,
    name: key,
    benefit: "search-insight" as const,
    optional: false,
    state,
    headline: "h",
    evidence: [],
    limitations: [],
    problems: [],
    verification: "",
    checkedAt: NOW,
  });

  test("a Search Console token is not account ownership", () => {
    const t = task(
      evaluateGrowth(input({ integrations: [integration("GSC", "detected")] })),
      "gsc-verified",
    );
    expect(t.status).toBe("IN_PROGRESS");
    expect(t.reason).toMatch(
      /does not prove the property is verified, who owns it/,
    );
  });

  const withSitemap = (
    sitemap: NonNullable<GrowthInput["crawl"]>["sitemap"],
    sitemapFailures: NonNullable<GrowthInput["crawl"]>["sitemapFailures"] = [],
  ) =>
    task(
      evaluateGrowth(
        input({
          integrations: [integration("SITEMAP", "not-checked")],
          crawl: {
            status: "COMPLETED",
            analyzedAt: NOW,
            pages: [page({})],
            sitemap,
            sitemapFailures,
          },
        }),
      ),
      "xml-sitemap",
    );

  test("without an integration check, the crawl's sitemap reading decides", () => {
    expect(withSitemap({ state: "found", urls: 40 })).toMatchObject({
      status: "VERIFIED",
      reason: "The latest crawl read 40 URLs from the sitemap.",
    });
    expect(withSitemap({ state: "empty", files: 1 }).status).toBe(
      "NEEDS_ATTENTION",
    );
    expect(
      withSitemap({ state: "unreachable", failed: [] }, [
        {
          url: "https://site.example/s.xml",
          httpStatus: 403,
          failure: "access-refused",
        },
      ]),
    ).toMatchObject({
      status: "NEEDS_ATTENTION",
      evidence: ["/s.xml: HTTP 403, access refused, possibly to crawlers only"],
    });
    expect(
      withSitemap({ state: "inconclusive", reason: "x returned HTTP 503." }),
    ).toMatchObject({ status: "NOT_STARTED" });
  });

  test("blocked tasks say what unblocks them", () => {
    const tasks = evaluateGrowth(input());
    expect(task(tasks, "gsc-sitemap").reason).toMatch(/^Blocked: the task/);
    expect(task(tasks, "conversion-tracking").reason).toMatch(
      /Business page first/,
    );
    expect(
      task(evaluateGrowth(input({ crawl: null })), "homepage-indexable").reason,
    ).toMatch(/Start a crawl/);
  });
});
