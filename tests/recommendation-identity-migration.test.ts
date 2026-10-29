import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { M1_OBJECTS } from "../src/lib/recommendations/capabilities";

/**
 * Static checks of migration 4_recommendation_identity (Stage 2, M1) and of
 * the schema and capability check that depend on it. Files only: nothing
 * here connects to a database. What the database does with this SQL
 * (triggers firing, foreign key actions) is tested on itest-ci, after the
 * migration is applied there with approval (tests/integration, V1 to V8).
 */

const root = process.cwd(); // vitest runs from the repository root
const migrations = join(root, "prisma/migrations");
const NAME = "4_recommendation_identity";
const sql = readFileSync(join(migrations, NAME, "migration.sql"), "utf8");
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");

/** The executable SQL: comments and function bodies removed. */
const statements = sql
  .replace(/\$\$[\s\S]*?\$\$/g, "$$ body $$")
  .replace(/--.*$/gm, "");
/** The two function bodies, by function name. */
const body = (fn: string) =>
  new RegExp(
    `CREATE FUNCTION "${fn}"\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$`,
  ).exec(sql)?.[1] ?? "";
const model = (name: string) =>
  new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";

describe("migration 4_recommendation_identity: order and scope", () => {
  test("it is the fifth migration, after 3_crawl_mode, for PostgreSQL", () => {
    const names = readdirSync(migrations, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(names).toEqual([
      "0_baseline",
      "1_business_facts",
      "2_recommendation_events",
      "3_crawl_mode",
      NAME,
    ]);
    expect(
      readFileSync(join(migrations, "migration_lock.toml"), "utf8"),
    ).toMatch(/provider = "postgresql"/);
  });

  test("additive only: no data written, nothing dropped, renamed or altered in place", () => {
    for (const forbidden of [
      // Not "BEFORE INSERT ON" (the tenancy trigger): only data inserts.
      /\bINSERT\s+INTO\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bTRUNCATE\b/i,
      /\bDROP\b/i,
      /\bRENAME\b/i,
      /\bALTER\s+COLUMN\b/i,
      /(^|;)\s*UPDATE\s+"/im,
    ])
      expect(statements).not.toMatch(forbidden);
  });

  test("the rollback is written down, for review only (comments)", () => {
    expect(sql).toMatch(/^-- Rollback \(review only\)/m);
    expect(sql).toMatch(/^-- DROP TABLE "recommendation_evidence";$/m);
    expect(sql).toMatch(/IDENTITY_CHANGED and IDENTITY_LINK_DECLINED/);
  });
});

describe("migration 4_recommendation_identity: required objects", () => {
  test("both event types", () => {
    expect(statements).toContain(
      `ALTER TYPE "RecommendationEventType" ADD VALUE 'IDENTITY_CHANGED';`,
    );
    expect(statements).toContain(
      `ALTER TYPE "RecommendationEventType" ADD VALUE 'IDENTITY_LINK_DECLINED';`,
    );
  });

  test("two nullable recommendations columns, a unique follow-up link and its tenant-safe NO ACTION foreign key", () => {
    expect(statements).toMatch(
      /ALTER TABLE "recommendations" ADD COLUMN\s+"identityKey" TEXT,\s*ADD COLUMN\s+"recurrenceOfId" TEXT;/,
    );
    expect(statements).toContain(
      `CREATE UNIQUE INDEX "${M1_OBJECTS.recurrenceIndex}" ON "recommendations"("recurrenceOfId");`,
    );
    expect(statements).toContain(
      `ADD CONSTRAINT "${M1_OBJECTS.recurrenceForeignKey}" FOREIGN KEY ("recurrenceOfId", "websiteId", "organizationId") REFERENCES "recommendations"("id", "websiteId", "organizationId") ON DELETE NO ACTION ON UPDATE NO ACTION;`,
    );
    expect(statements).toMatch(
      /"recommendations_recurrence_not_self"\s+CHECK \("recurrenceOfId" IS NULL OR "recurrenceOfId" <> "id"\)/,
    );
  });

  test("the evidence enums and table, with every required column NOT NULL", () => {
    for (const e of [
      `CREATE TYPE "EvidenceRole" AS ENUM ('OBSERVED', 'INFERRED', 'MISSING');`,
      `CREATE TYPE "EvidenceProvenance" AS ENUM ('RECORDED', 'LEGACY_UNAVAILABLE', 'RECONSTRUCTED');`,
      `CREATE TYPE "EvidenceConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');`,
    ])
      expect(statements).toContain(e);
    const table =
      /CREATE TABLE "recommendation_evidence" \(([\s\S]*?)\n\);/.exec(
        statements,
      )?.[1] ?? "";
    for (const column of [
      "id",
      "organizationId",
      "websiteId",
      "recommendationId",
      "setId",
      "setDigest",
      "capturedAt",
      "role",
      "kind",
      "source",
      "summary",
      "provenance",
    ])
      expect(table).toMatch(new RegExp(`"${column}" [^,\\n]+ NOT NULL`));
    for (const column of [
      "supersededAt",
      "sourceVersion",
      "observedAt",
      "crawlRunId",
      "seoFindingId",
      "businessFactId",
      "refType",
      "refId",
      "url",
      "payload",
      "factStatus",
      "freshnessDimension",
      "confidence",
      "rationale",
    ]) {
      expect(table).toMatch(new RegExp(`"${column}" `));
      expect(table).not.toMatch(new RegExp(`"${column}" [^,\\n]+ NOT NULL`));
    }
    expect(table).toMatch(/"capturedAt" [^,\n]+ DEFAULT CURRENT_TIMESTAMP/);
  });

  test("evidence belongs to its task by the composite key (cascade); sources are SET NULL references", () => {
    expect(statements).toMatch(
      /FOREIGN KEY \("recommendationId", "websiteId", "organizationId"\) REFERENCES "recommendations"\("id", "websiteId", "organizationId"\) ON DELETE CASCADE/,
    );
    expect(statements).toMatch(
      /"recommendation_evidence_organizationId_fkey" FOREIGN KEY \("organizationId"\) REFERENCES "organizations"\("id"\) ON DELETE CASCADE/,
    );
    for (const [column, table] of [
      ["crawlRunId", "crawl_runs"],
      ["seoFindingId", "seo_findings"],
      ["businessFactId", "business_facts"],
    ])
      expect(statements).toContain(
        `FOREIGN KEY ("${column}") REFERENCES "${table}"("id") ON DELETE SET NULL ON UPDATE NO ACTION;`,
      );
  });

  test("indexes for reading the current set and for each source reference", () => {
    for (const columns of [
      `"recommendationId", "supersededAt"`,
      `"websiteId", "capturedAt"`,
      `"organizationId"`,
      `"crawlRunId"`,
      `"seoFindingId"`,
      `"businessFactId"`,
    ])
      expect(statements).toContain(`ON "recommendation_evidence"(${columns});`);
  });

  test("summary length CHECK and RLS on, with no policies", () => {
    expect(statements).toMatch(
      /"recommendation_evidence_summary_length"\s+CHECK \(char_length\("summary"\) <= 500\)/,
    );
    expect(statements).toContain(
      `ALTER TABLE "recommendation_evidence" ENABLE ROW LEVEL SECURITY;`,
    );
    expect(statements).not.toMatch(/CREATE POLICY/i);
  });
});

describe("migration 4_recommendation_identity: triggers", () => {
  test("both triggers exist, on the evidence table, for the intended events", () => {
    const [tenancy, appendOnly] = M1_OBJECTS.triggers;
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER "${tenancy}"\\s+BEFORE INSERT ON "recommendation_evidence"\\s+FOR EACH ROW EXECUTE FUNCTION "${tenancy}"\\(\\);`,
      ),
    );
    expect(statements).toMatch(
      new RegExp(
        `CREATE TRIGGER "${appendOnly}"\\s+BEFORE UPDATE ON "recommendation_evidence"\\s+FOR EACH ROW EXECUTE FUNCTION "${appendOnly}"\\(\\);`,
      ),
    );
    for (const fn of M1_OBJECTS.triggers)
      expect(sql).toMatch(
        new RegExp(
          `CREATE FUNCTION "${fn}"\\(\\) RETURNS trigger\\s+LANGUAGE plpgsql SET search_path = pg_catalog, public AS`,
        ),
      );
  });

  test("tenancy: each source must be the item's own website and organization", () => {
    const fn = body("recommendation_evidence_tenancy");
    for (const [column, table] of [
      ["crawlRunId", "crawl_runs"],
      ["seoFindingId", "seo_findings"],
      ["businessFactId", "business_facts"],
    ]) {
      expect(fn).toContain(`NEW."${column}" IS NOT NULL AND NOT EXISTS`);
      expect(fn).toContain(`FROM public."${table}" s`);
      expect(fn).toContain(`s."id" = NEW."${column}"`);
    }
    expect(fn.match(/s\."websiteId" = NEW\."websiteId"/g)).toHaveLength(3);
    expect(
      fn.match(/s\."organizationId" = NEW\."organizationId"/g),
    ).toHaveLength(3);
    expect(fn).toMatch(/RETURN NEW;/);
  });

  test("append-only: every other column fixed; supersededAt set once from NULL; references only cleared", () => {
    const fn = body("recommendation_evidence_append_only");
    const table =
      /CREATE TABLE "recommendation_evidence" \(([\s\S]*?)\n\);/.exec(
        sql,
      )?.[1] ?? "";
    const columns = [...table.matchAll(/^\s+"(\w+)" /gm)].map((m) => m[1]);
    const mutable = [
      "supersededAt",
      "crawlRunId",
      "seoFindingId",
      "businessFactId",
    ];
    // Every column of the table is either compared unchanged or one of the four.
    for (const c of columns.filter((c) => !mutable.includes(c)))
      expect(fn, c).toMatch(new RegExp(`NEW\\."${c}"(::text)?,?[\\s)]`));
    expect(fn).toMatch(
      /NEW\."supersededAt" IS DISTINCT FROM OLD\."supersededAt"\s+AND \(OLD\."supersededAt" IS NOT NULL OR NEW\."supersededAt" IS NULL\)/,
    );
    for (const ref of mutable.slice(1))
      expect(fn).toMatch(
        new RegExp(
          `NEW\\."${ref}" IS DISTINCT FROM OLD\\."${ref}"\\s+AND NEW\\."${ref}" IS NOT NULL`,
        ),
      );
    expect(fn).toContain(
      `RAISE EXCEPTION 'recommendation_evidence is append-only'`,
    );
    // Deletes stay possible (cascades): no DELETE trigger.
    expect(statements).not.toMatch(
      /BEFORE DELETE ON "recommendation_evidence"/,
    );
  });
});

describe("schema.prisma and the capability check match the migration", () => {
  test("the two recommendations columns and their relation are @ignore (option A, P1)", () => {
    const rec = model("Recommendation");
    expect(rec).toMatch(/identityKey\s+String\?\s+@ignore/);
    expect(rec).toMatch(/recurrenceOfId\s+String\?\s+@unique @ignore/);
    expect(rec).toMatch(
      /recurrenceOf\s+Recommendation\?\s+@relation\("Recurrence"[^\n]*@ignore/,
    );
    expect(rec).toMatch(
      /recurrences\s+Recommendation\[\]\s+@relation\("Recurrence"\) @ignore/,
    );
  });

  test("the event types and the evidence model are in the schema", () => {
    expect(schema).toMatch(
      /enum RecommendationEventType \{[\s\S]*?IDENTITY_CHANGED\s+IDENTITY_LINK_DECLINED\s*\}/,
    );
    expect(model("RecommendationEvidence")).toMatch(
      /@@map\("recommendation_evidence"\)/,
    );
  });

  test("every object the capability check requires is created by this migration", () => {
    for (const trigger of M1_OBJECTS.triggers)
      expect(statements).toContain(`CREATE TRIGGER "${trigger}"`);
    expect(statements).toContain(
      `CREATE UNIQUE INDEX "${M1_OBJECTS.recurrenceIndex}"`,
    );
    expect(statements).toContain(
      `ADD CONSTRAINT "${M1_OBJECTS.recurrenceForeignKey}"`,
    );
    const capabilities = readFileSync(
      join(root, "src/lib/recommendations/capabilities.ts"),
      "utf8",
    );
    for (const name of [
      "recommendation_events",
      "recommendation_evidence",
      "identityKey",
      "recurrenceOfId",
      "IDENTITY_CHANGED",
      "IDENTITY_LINK_DECLINED",
    ]) {
      expect(capabilities).toContain(name);
      expect(
        sql +
          readFileSync(
            join(migrations, "2_recommendation_events", "migration.sql"),
            "utf8",
          ),
      ).toContain(name);
    }
  });
});
