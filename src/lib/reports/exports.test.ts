import { describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { recommendationVisibility } from "@/lib/business/visibility";
import {
  buildProvenance,
  provenanceLabel,
  type EvidenceComponent,
  type Provenance,
} from "@/lib/recommendations/provenance";
import type { TenantDb } from "@/lib/tenancy/scope";
import { BOM } from "./csv";
import {
  buildExport,
  DATASETS,
  factsConfirmed,
  MAX_EXPORT_ROWS,
  TASK_COLUMNS,
  tasksCsv,
  type Dataset,
  type TaskExportRow,
} from "./exports";

const NOW = new Date("2026-10-24T12:00:00Z");
const ago = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const crawl = (
  at: Date | null,
  crawlStatus: EvidenceComponent["crawlStatus"] = "COMPLETED",
): EvidenceComponent => ({ at, dimension: "TECHNICAL_SEO", crawlStatus });
const observed = (c: EvidenceComponent) =>
  buildProvenance({ source: "crawl", basis: "observed", components: [c] }, NOW);
const task = (
  provenance: Provenance | null,
  extra: Partial<TaskExportRow> = {},
): TaskExportRow => ({
  website: "example.com",
  title: "Fix missing titles",
  status: "PROPOSED",
  priority: "HIGH",
  provenance,
  ...extra,
});
/** Data lines (header and trailing empty line removed), split into cells. */
const lines = (csv: string) => csv.split("\r\n").filter(Boolean);
const HEADER = `${BOM}website,title,status,priority,evidence_source,evidence_basis,evidence_observed_at,evidence_freshness,facts_confirmed,based_on`;

describe("tasks export columns", () => {
  test("exact header and column order", () => {
    expect([...TASK_COLUMNS]).toEqual([
      "website",
      "title",
      "status",
      "priority",
      "evidence_source",
      "evidence_basis",
      "evidence_observed_at",
      "evidence_freshness",
      "facts_confirmed",
      "based_on",
    ]);
    expect(lines(tasksCsv([]))).toEqual([HEADER]);
  });

  test("a row carries the provenance's own values and the page's label", () => {
    const p = observed(crawl(ago(1)));
    expect(lines(tasksCsv([task(p)]))[1]).toBe(
      `example.com,Fix missing titles,PROPOSED,HIGH,crawl,observed,${ago(1).toISOString()},current,,${provenanceLabel(p)}`,
    );
  });

  test("every freshness state is exported as such", () => {
    const states: [Provenance, string][] = [
      [observed(crawl(ago(1))), "current"],
      [
        buildProvenance(
          {
            source: "ai-search",
            basis: "observed",
            components: [{ at: ago(3), dimension: null }],
          },
          NOW,
        ),
        "unrated",
      ],
      [observed(crawl(ago(1), "PARTIAL")), "partial"],
      [observed(crawl(null)), "unknown"],
      [observed(crawl(ago(61))), "stale"],
    ];
    for (const [p, freshness] of states) {
      const cells = lines(tasksCsv([task(p)]))[1].split(",");
      expect(cells[7]).toBe(freshness);
      expect(p.freshness).toBe(freshness);
    }
  });

  test("a known date is ISO 8601; undated or future evidence leaves it empty", () => {
    const dated = lines(tasksCsv([task(observed(crawl(ago(61))))]))[1];
    expect(dated.split(",")[6]).toBe(ago(61).toISOString());
    for (const at of [null, new Date(NOW.getTime() + 24 * 60 * 60 * 1000)]) {
      const cells = lines(tasksCsv([task(observed(crawl(at)))]))[1].split(",");
      expect(cells[6]).toBe("");
      expect(cells[7]).toBe("unknown");
    }
    // Several pieces, one undated: no date at all, never the dated one alone.
    const mixed = buildProvenance(
      {
        source: "crawl-and-probe",
        basis: "observed",
        components: [crawl(ago(2)), { at: null, dimension: null }],
      },
      NOW,
    );
    expect(lines(tasksCsv([task(mixed)]))[1].split(",")[6]).toBe("");
  });

  describe("facts_confirmed", () => {
    const inferred = (factSources?: string[]) =>
      buildProvenance(
        {
          source: "facts-and-crawl",
          basis: "inferred",
          components: [crawl(ago(1))],
          factSources,
        },
        NOW,
      );
    const cell = (p: Provenance | null) =>
      lines(tasksCsv([task(p)]))[1].split(",")[8];

    test("yes: every fact is the client's", () => {
      expect(factsConfirmed(inferred(["CLIENT"]))).toBe("yes");
      expect(cell(inferred(["CLIENT", "CLIENT"]))).toBe("yes");
    });

    test("partial: some, not all, are the client's (others known or unknown)", () => {
      expect(cell(inferred(["CLIENT", "TEAM"]))).toBe("partial");
      expect(cell(inferred(["CLIENT", "IMPORT", "INFERENCE"]))).toBe("partial");
      expect(cell(inferred(["CLIENT", "UNKNOWN"]))).toBe("partial");
    });

    test("no: none is the client's and every source is known", () => {
      expect(cell(inferred(["TEAM"]))).toBe("no");
      expect(cell(inferred(["TEAM", "IMPORT", "INFERENCE"]))).toBe("no");
    });

    test("empty: no facts, no provenance, or none the client's with an unknown source", () => {
      expect(cell(inferred())).toBe("");
      expect(cell(inferred([]))).toBe("");
      expect(cell(observed(crawl(ago(1))))).toBe("");
      expect(cell(null)).toBe("");
      // A missing source ("UNKNOWN" from the loader) or an unexpected value
      // could be the client's: never "no".
      expect(cell(inferred(["UNKNOWN"]))).toBe("");
      expect(cell(inferred(["TEAM", "UNKNOWN"]))).toBe("");
      expect(cell(inferred(["client"]))).toBe("");
      expect(cell(inferred([""]))).toBe("");
      // An empty tally is not a fact.
      expect(
        factsConfirmed({
          ...inferred(["TEAM"]),
          facts: { total: 0, fromClient: 0 },
        }),
      ).toBeNull();
    });

    test("the unknown-source count leaves the provenance label unchanged", () => {
      const known = inferred(["TEAM"]);
      const unknown = inferred(["UNKNOWN"]);
      expect(known.facts).toEqual({ total: 1, fromClient: 0 });
      expect(unknown.facts).toEqual({
        total: 1,
        fromClient: 0,
        unknownSource: 1,
      });
      expect(provenanceLabel(unknown)).toBe(provenanceLabel(known));
      expect(lines(tasksCsv([task(unknown)]))[1].split(",")[9]).toBe(
        provenanceLabel(unknown),
      );
    });
  });

  test("no provenance (evidence no longer available): evidence cells empty", () => {
    expect(lines(tasksCsv([task(null, { status: "COMPLETED" })]))[1]).toBe(
      "example.com,Fix missing titles,COMPLETED,HIGH,,,,,,",
    );
  });

  test("cells that start a formula are neutralised", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      const csv = tasksCsv([task(null, { title: bad, website: bad })]);
      const row = lines(csv).slice(1).join("\r\n");
      expect(row.startsWith(`'${bad}`) || row.startsWith(`"'${bad}`)).toBe(
        true,
      );
      expect(row).not.toMatch(/^[=+\-@\t\r]/);
    }
    expect(
      lines(tasksCsv([task(null, { title: '=HYPERLINK("http://evil")' })]))[1],
    ).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

/**
 * A stand-in for the tenant client: returns `rows[model]` and records each
 * call's arguments. No database.
 */
function fakeDb(rows: Record<string, unknown[]> = {}) {
  const calls: { model: string; method: string; args: unknown }[] = [];
  const db = new Proxy(
    {},
    {
      get: (_, model: string) =>
        new Proxy(
          {},
          {
            get: (__, method: string) => async (args: unknown) => {
              calls.push({ model, method, args });
              return rows[model] ?? [];
            },
          },
        ),
    },
  ) as unknown as TenantDb;
  return { db, calls };
}
const root = {} as PrismaClient;

describe("tasks export scoping (no database)", () => {
  test("a client member's query excludes business-coverage tasks", async () => {
    const { db, calls } = fakeDb();
    await buildExport(db, "tasks", { days: 30, role: "CLIENT", root });
    const [call] = calls;
    expect(call).toMatchObject({ model: "recommendation", method: "findMany" });
    expect(call.args).toMatchObject({
      where: { AND: [{}, recommendationVisibility("CLIENT")] },
      take: MAX_EXPORT_ROWS,
    });
    expect(recommendationVisibility("CLIENT")).not.toEqual({});
  });

  test("a missing role is treated as CLIENT; agency members see every task", async () => {
    const missing = fakeDb();
    await buildExport(missing.db, "tasks", { days: 30, root });
    expect(missing.calls[0].args).toMatchObject({
      where: { AND: [{}, recommendationVisibility("CLIENT")] },
    });
    const member = fakeDb();
    await buildExport(member.db, "tasks", { days: 30, role: "MEMBER", root });
    expect(member.calls[0].args).toMatchObject({
      where: { AND: [{}, {}] },
    });
  });

  test("order: website name, website, priority, last update, then id as the tie-breaker", async () => {
    const { db, calls } = fakeDb();
    await buildExport(db, "tasks", { days: 30, role: "MEMBER", root });
    const orderBy = (calls[0].args as { orderBy: unknown[] }).orderBy;
    expect(orderBy).toEqual([
      { website: { name: "asc" } },
      { websiteId: "asc" },
      { priority: "asc" },
      { updatedAt: "desc" },
      { id: "asc" },
    ]);
    // Rows equal on every earlier key are told apart by id alone, the last
    // and only unique key.
    expect(orderBy.at(-1)).toEqual({ id: "asc" });
    expect(orderBy.filter((k) => "id" in (k as object))).toHaveLength(1);
  });

  test("websiteId limits the query; days is ignored", async () => {
    const a = fakeDb();
    await buildExport(a.db, "tasks", {
      days: 7,
      websiteId: "site-1",
      role: "ADMIN",
      root,
    });
    const b = fakeDb();
    await buildExport(b.db, "tasks", {
      days: 365,
      websiteId: "site-1",
      role: "ADMIN",
      root,
    });
    expect(a.calls[0].args).toMatchObject({
      where: { AND: [{ websiteId: "site-1" }, {}] },
    });
    expect(a.calls[0].args).toEqual(b.calls[0].args);
  });

  test("no tasks: header only, and no evidence context is loaded", async () => {
    const { db, calls } = fakeDb();
    expect(lines(await buildExport(db, "tasks", { days: 30, root }))).toEqual([
      HEADER,
    ]);
    expect(calls).toHaveLength(1);
  });

  test("refuses to run without the root client", async () => {
    const { db } = fakeDb();
    await expect(buildExport(db, "tasks", { days: 30 })).rejects.toThrow(
      "root client",
    );
  });
});

describe("existing datasets are unchanged", () => {
  const at = new Date("2026-10-20T08:30:00Z");
  const website = { domain: "example.com" };
  const rows = {
    website: [
      {
        id: "w1",
        name: "=Site",
        domain: "example.com",
        url: "https://example.com",
        status: "ACTIVE",
        client: { name: "Acme, Inc" },
        monitoringEnabled: true,
        createdAt: at,
      },
    ],
    websiteCheck: [
      {
        createdAt: at,
        website,
        type: "UPTIME",
        outcome: "SUCCESS",
        httpStatus: 200,
        responseTimeMs: 120,
        finalUrl: "https://example.com/",
        sslExpiresAt: null,
        errorMessage: 'say "hi"',
      },
    ],
    issue: [
      {
        website,
        category: "UPTIME",
        severity: "HIGH",
        status: "OPEN",
        title: "Down",
        description: "line1\nline2",
        firstSeenAt: at,
        lastSeenAt: at,
        resolvedAt: null,
        assignedTo: { email: "a@example.com" },
      },
    ],
    seoFinding: [
      {
        website,
        ruleId: "TITLE_MISSING",
        scope: "PAGE",
        severity: "MEDIUM",
        status: "OPEN",
        title: "Missing title",
        evidence: { url: "https://example.com/a" },
        recommendation: "+Add one",
        firstSeenAt: at,
        lastSeenAt: at,
      },
    ],
    alertEvent: [
      {
        createdAt: at,
        website,
        type: "UPTIME_INCIDENT_OPENED",
        severity: "HIGH",
        title: "Down",
        message: "-x",
        resolvedAt: at,
      },
    ],
    websiteScoreSnapshot: [
      {
        calculatedAt: at,
        website,
        score: 81,
        measuredWeight: 0.9,
        scoringVersion: 3,
      },
    ],
  };
  const T = at.toISOString();
  // Golden output, identical to the exports before the tasks dataset.
  const expected: Record<Exclude<Dataset, "report" | "tasks">, string[]> = {
    websites: [
      `${BOM}id,name,domain,url,status,client,monitoring_enabled,created_at`,
      `w1,'=Site,example.com,https://example.com,ACTIVE,"Acme, Inc",true,${T}`,
    ],
    checks: [
      `${BOM}time,website,type,outcome,http_status,response_ms,final_url,ssl_expires_at,error`,
      `${T},example.com,UPTIME,SUCCESS,200,120,https://example.com/,,"say ""hi"""`,
    ],
    issues: [
      `${BOM}website,category,severity,status,title,description,first_seen,last_seen,resolved_at,assignee`,
      `example.com,UPTIME,HIGH,OPEN,Down,"line1\nline2",${T},${T},,a@example.com`,
    ],
    "seo-findings": [
      `${BOM}website,rule,scope,severity,status,title,page_url,recommendation,first_seen,last_seen`,
      `example.com,TITLE_MISSING,PAGE,MEDIUM,OPEN,Missing title,https://example.com/a,'+Add one,${T},${T}`,
    ],
    alerts: [
      `${BOM}time,website,type,severity,title,message,resolved_at`,
      `${T},example.com,UPTIME_INCIDENT_OPENED,HIGH,Down,'-x,${T}`,
    ],
    scores: [
      `${BOM}time,website,score,measured_weight,scoring_version`,
      `${T},example.com,81,0.9,3`,
    ],
  };

  test("the dataset list only gains tasks, at the end", () => {
    expect([...DATASETS]).toEqual([
      "report",
      "websites",
      "checks",
      "issues",
      "seo-findings",
      "alerts",
      "scores",
      "tasks",
    ]);
  });

  for (const [dataset, want] of Object.entries(expected))
    test(`${dataset}: byte-identical output, with or without a role`, async () => {
      for (const params of [
        { days: 30 },
        { days: 30, role: "CLIENT" as const, root },
      ]) {
        const { db } = fakeDb(rows);
        const csv = await buildExport(db, dataset as Dataset, params);
        expect(csv).toBe(`${want.join("\r\n")}\r\n`);
      }
    });
});
