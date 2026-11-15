import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { PlatformDetection } from "@/lib/crawler/platform";
import { PLAYBOOKS } from "@/lib/knowledge/playbooks";
import type { TenantDb } from "@/lib/tenancy/scope";
import type { RecommendationBasis } from "./generate";
import { issueMeta, seoRuleMeta } from "./metadata";
import { loadPlatformEvidence, PLATFORM_PAGES } from "./platform-evidence";
import {
  platformStatus,
  platformSupported,
  remediationFor,
  withRemediation,
  type PlatformEvidence,
} from "./remediation";

const AT = new Date("2026-10-24T09:00:00Z");
const detection = (d: Partial<PlatformDetection> = {}): PlatformDetection => ({
  platform: "unknown",
  confidence: null,
  reason: "no-signals",
  signals: [],
  pagesChecked: 3,
  pagesWithSignals: 3,
  malformed: 0,
  otherPlatforms: [],
  ...d,
});
const evidence = (d: Partial<PlatformDetection> | null): PlatformEvidence => ({
  analysedAt: AT,
  detection: d === null ? null : detection(d),
});
const WP = evidence({
  platform: "wordpress",
  confidence: "medium",
  reason: "detected",
  signals: [{ kind: "wp-assets", label: "Site files", pages: 2 }],
});
const WOO = evidence({
  platform: "woocommerce",
  confidence: "high",
  reason: "detected",
});
const NONE: PlatformEvidence = { analysedAt: null, detection: null };
const rule = (ruleId: string): RecommendationBasis => ({
  kind: "seo-rule",
  ruleId,
});

describe("remediationFor", () => {
  test("a technical SEO rule gets its playbook; no platform steps without evidence", () => {
    const r = remediationFor(rule("TECH_NOINDEX"), NONE)!;
    expect(r).toMatchObject({
      ruleId: "TECH_NOINDEX",
      playbookVersion: "p2",
      steps: PLAYBOOKS.TECH_NOINDEX.steps,
      prerequisites: PLAYBOOKS.TECH_NOINDEX.prerequisites,
      risks: PLAYBOOKS.TECH_NOINDEX.risks,
      overlays: [],
    });
  });

  test("WordPress steps only when WordPress is supported", () => {
    const r = remediationFor(rule("TECH_NOINDEX"), WP)!;
    expect(r.overlays.map((o) => o.platform)).toEqual(["wordpress"]);
    expect(r.overlays[0]).toMatchObject({
      label: "WordPress",
      steps: PLAYBOOKS.TECH_NOINDEX.platforms!.wordpress!.steps,
    });
  });

  test("WooCommerce adds its steps after WordPress's, where the rule has them", () => {
    expect(
      remediationFor(rule("TECH_THIN_CONTENT"), WOO)!.overlays.map(
        (o) => o.platform,
      ),
    ).toEqual(["wordpress", "woocommerce"]);
    // No WooCommerce overlay for this rule: WordPress only.
    expect(
      remediationFor(rule("TECH_TITLE_MISSING"), WOO)!.overlays.map(
        (o) => o.platform,
      ),
    ).toEqual(["wordpress"]);
  });

  test("uncertain detections never add platform steps", () => {
    for (const d of [
      { reason: "weak" as const },
      { reason: "conflicting" as const, otherPlatforms: ["Wix"] },
      { reason: "not-recorded" as const, pagesWithSignals: 0 },
      // Defensive: a platform without a confidence is not supported.
      { platform: "wordpress" as const, reason: "detected" as const },
    ]) {
      const e = evidence(d);
      expect(platformSupported(e.detection)).toBe(false);
      expect(remediationFor(rule("TECH_NOINDEX"), e)!.overlays).toEqual([]);
    }
  });

  test("other kinds of task, content rules and unknown rules get none", () => {
    for (const basis of [
      { kind: "issue", issueId: "i1" },
      { kind: "integration", key: "GSC", code: "MISSING" },
      { kind: "coverage", code: "BIZ_SERVICE_PAGE" },
      { kind: "performance" },
      { kind: "ai-search" },
      rule("CONTENT_SERVICE_LOCATION_GAP"),
      rule("TECH_REMOVED_RULE"),
    ] as RecommendationBasis[])
      expect(remediationFor(basis, WP)).toBeNull();
  });
});

describe("withRemediation", () => {
  const seo = seoRuleMeta({
    ruleId: "TECH_NOINDEX",
    severity: "LOW",
    scope: "PAGE",
    open: 1,
    onAnalysed: 1,
    urls: ["https://a.example/x"],
    samples: [],
    analysedPages: 4,
    homepageAffected: false,
  });

  test("adds the remediation and changes nothing else", () => {
    const m = withRemediation(seo, rule("TECH_NOINDEX"), WP)!;
    const { remediation, ...rest } = m;
    expect(rest).toEqual(seo);
    expect(remediation?.ruleId).toBe("TECH_NOINDEX");
  });

  test("other tasks keep their metadata as it was; missing metadata stays missing", () => {
    const issue = issueMeta({
      category: "SSL",
      severity: "HIGH",
      description: "Certificate expires soon",
      firstSeenAt: AT,
      lastSeenAt: AT,
    });
    expect(withRemediation(issue, { kind: "issue", issueId: "i" }, WP)).toBe(
      issue,
    );
    expect(withRemediation(null, rule("TECH_NOINDEX"), WP)).toBeNull();
  });
});

describe("platformStatus", () => {
  test("a supported detection names the platform, confidence, crawl date and signals", () => {
    const s = platformStatus(WP);
    expect(s.supported).toBe(true);
    expect(s.text).toBe(
      "WordPress detected (medium confidence) from the crawl analysed 24 Oct 2026, 09:00 UTC, checking 3 pages.",
    );
    expect(s.signals).toEqual(["Site files, on 2 pages"]);
  });

  test("every other state says 'not detected' and why", () => {
    const cases: Array<[PlatformEvidence, RegExp]> = [
      [NONE, /no analysed crawl yet/],
      [
        evidence({ reason: "not-recorded", pagesWithSignals: 0 }),
        /ran before platform detection was added/,
      ],
      [evidence({}), /does not show the site uses another platform/],
      [evidence({ reason: "weak" }), /one kind of signal, on one page/],
      [
        evidence({ reason: "conflicting", otherPlatforms: ["Wix"] }),
        /generator tag naming Wix/,
      ],
      [
        evidence({ reason: "other-platform", otherPlatforms: ["Drupal"] }),
        /not detected as WordPress.*Drupal/,
      ],
    ];
    for (const [e, text] of cases) {
      const s = platformStatus(e);
      expect(s.supported).toBe(false);
      expect(s.text).toMatch(/^Platform not detected/);
      expect(s.text).toMatch(text);
    }
  });

  test("unreadable data is reported with the signals", () => {
    expect(platformStatus(evidence({ malformed: 1 })).signals).toEqual([
      "Unreadable platform data on 1 page",
    ]);
  });
});

describe("loadPlatformEvidence", () => {
  const platform = {
    v: 1,
    generators: ["WordPress 6.6"],
    wpAssets: 2,
    wpRestLink: true,
    wooAssets: 0,
    wooBodyClasses: [],
  };
  const stub = (crawl: { id: string; seoAnalyzedAt: Date } | null) => {
    const findFirst = vi.fn().mockResolvedValue(crawl);
    const queryRaw = vi.fn().mockResolvedValue([
      { recorded: true, platform },
      // A page crawled before detection: no platform key.
      { recorded: false, platform: null },
    ]);
    const db = {
      crawlRun: { findFirst },
      $queryRaw: queryRaw,
    } as unknown as TenantDb;
    return { db, findFirst, queryRaw };
  };

  test("reads the latest analysed crawl, then only the platform value of a bounded set of its HTML pages", async () => {
    const { db, findFirst, queryRaw } = stub({ id: "run1", seoAnalyzedAt: AT });
    const e = await loadPlatformEvidence(db, "org1", "site1");
    expect(findFirst).toHaveBeenCalledWith({
      where: { websiteId: "site1", seoAnalyzedAt: { not: null } },
      orderBy: { seoAnalyzedAt: "desc" },
      select: { id: true, seoAnalyzedAt: true },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("$").replace(/\s+/g, " ");
    expect(sql).toContain("result -> 'platform' AS platform");
    expect(sql).not.toMatch(/SELECT \*|SELECT result,|SELECT result /);
    for (const clause of [
      '"organizationId" = $',
      '"websiteId" = $',
      '"crawlRunId" = $',
      "status = 'CRAWLED'",
      "\"resourceType\" = 'HTML'",
      '"httpStatus" < 400',
      "ORDER BY depth ASC, id ASC LIMIT $",
    ])
      expect(sql).toContain(clause);
    expect(values).toEqual(["org1", "site1", "run1", PLATFORM_PAGES]);
    expect(e).toMatchObject({
      analysedAt: AT,
      detection: {
        platform: "wordpress",
        confidence: "high",
        pagesChecked: 2,
        pagesWithSignals: 1,
        malformed: 0,
      },
    });
  });

  test("no analysed crawl: no page query, no detection", async () => {
    const { db, queryRaw } = stub(null);
    expect(await loadPlatformEvidence(db, "org1", "site1")).toEqual(NONE);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  test("tenant scoping: the page passes its tenant client and organization; the loader never uses the root client", () => {
    const page = readFileSync(
      "src/app/(app)/o/[orgSlug]/websites/[websiteId]/recommendations/page.tsx",
      "utf8",
    );
    expect(page).toContain(
      "loadPlatformEvidence(ctx.db, ctx.organization.id, websiteId)",
    );
    const loader = readFileSync(
      "src/lib/recommendations/platform-evidence.ts",
      "utf8",
    );
    expect(loader).not.toMatch(/@\/lib\/db|\$executeRaw|queryRawUnsafe/);
  });
});
