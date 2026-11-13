import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Offline checks of the migration SQL that the migration plans rely on
 * (docs/operations/rehearsal-target.md, "Migration safety audit"). They read
 * the files only; nothing connects.
 */

const DIR = path.resolve(import.meta.dirname, "../prisma/migrations");
const MIGRATIONS = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const raw = (name: string) =>
  readFileSync(path.join(DIR, name, "migration.sql"), "utf8");
/** The SQL without comments or dollar-quoted bodies. */
const code = (name: string) =>
  raw(name)
    .replace(/\$\$[\s\S]*?\$\$/g, "$$$$")
    .replace(/--.*$/gm, "");

const cols = (list: string) =>
  [...list.matchAll(/"(\w+)"/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

/** Unique keys and foreign keys, in the order the migrations create them. */
function events() {
  const out: Array<
    | { kind: "unique"; table: string; columns: string; at: string }
    | {
        kind: "fk";
        name: string;
        table: string;
        refTable: string;
        refColumns: string;
        at: string;
      }
  > = [];
  for (const m of MIGRATIONS) {
    const sql = code(m);
    const statements = sql.split(/;\s*\n/);
    for (const s of statements) {
      const table = /CREATE TABLE "(\w+)"/.exec(s);
      if (table) {
        const pk = /PRIMARY KEY \(([^)]*)\)/.exec(s);
        if (pk)
          out.push({
            kind: "unique",
            table: table[1],
            columns: cols(pk[1]),
            at: m,
          });
      }
      const idx = /CREATE UNIQUE INDEX "\w+" ON "(\w+)"\(([^)]*)\)/.exec(s);
      if (idx)
        out.push({
          kind: "unique",
          table: idx[1],
          columns: cols(idx[2]),
          at: m,
        });
      const fk =
        /ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" FOREIGN KEY \(([^)]*)\) REFERENCES "(\w+)"\(([^)]*)\)/.exec(
          s,
        );
      if (fk)
        out.push({
          kind: "fk",
          name: fk[2],
          table: fk[1],
          refTable: fk[4],
          refColumns: cols(fk[5]),
          at: m,
        });
    }
  }
  return out;
}

describe("foreign-key prerequisites", () => {
  test("every foreign key references an exactly matching unique key created before it", () => {
    const seen: Array<{ table: string; columns: string }> = [];
    const missing: string[] = [];
    let fks = 0;
    for (const e of events()) {
      if (e.kind === "unique") seen.push(e);
      else {
        fks++;
        // PostgreSQL needs a unique index or constraint on exactly the
        // referenced columns; a primary key on a subset does not count.
        if (
          !seen.some(
            (u) => u.table === e.refTable && u.columns === e.refColumns,
          )
        )
          missing.push(`${e.at}: ${e.name} → ${e.refTable}(${e.refColumns})`);
      }
    }
    expect(fks).toBeGreaterThan(60);
    expect(missing).toEqual([]);
  });

  test("migration 4's composite keys on recommendations rest on migration 2's index", () => {
    const all = events();
    const composite = all.filter(
      (e) =>
        e.kind === "fk" &&
        e.refTable === "recommendations" &&
        e.refColumns.includes(","),
    );
    expect(
      composite.map((e) => e.kind === "fk" && `${e.at} ${e.name}`),
    ).toEqual([
      "2_recommendation_events recommendation_events_recommendationId_websiteId_organizat_fkey",
      "4_recommendation_identity recommendations_recurrenceOfId_websiteId_organizationId_fkey",
      "4_recommendation_identity recommendation_evidence_recommendationId_websiteId_organiz_fkey",
    ]);
    const keys = all.filter(
      (e) => e.kind === "unique" && e.table === "recommendations",
    );
    expect(
      keys.map((e) => `${e.at} ${e.kind === "unique" && e.columns}`),
    ).toEqual([
      "0_baseline id",
      "2_recommendation_events id,organizationId,websiteId",
      "4_recommendation_identity recurrenceOfId",
    ]);
    // Within migration 2, the index comes before the foreign key using it.
    const m2 = code("2_recommendation_events");
    expect(
      m2.indexOf(
        'CREATE UNIQUE INDEX "recommendations_id_websiteId_organizationId_key"',
      ),
    ).toBeLessThan(
      m2.indexOf(
        'ADD CONSTRAINT "recommendation_events_recommendationId_websiteId_organizat_fkey"',
      ),
    );
  });

  test("migration 4 also needs migration 2's enum", () => {
    expect(code("4_recommendation_identity")).toMatch(
      /ALTER TYPE "RecommendationEventType" ADD VALUE/,
    );
    expect(code("2_recommendation_events")).toMatch(
      /CREATE TYPE "RecommendationEventType"/,
    );
  });
});

describe("ordering and independence", () => {
  const names = (m: string) =>
    new Set(
      [
        ...code(m).matchAll(
          /(?:CREATE (?:TYPE|TABLE|UNIQUE INDEX|INDEX|FUNCTION|TRIGGER)|ADD CONSTRAINT|ADD COLUMN\s+)\s*"(\w+)"/g,
        ),
      ].map((x) => x[1]),
    );

  test("migrations 2 and 3 create nothing in common and do not refer to each other", () => {
    const two = names("2_recommendation_events");
    const three = names("3_crawl_mode");
    expect([...two].filter((n) => three.has(n))).toEqual([]);
    for (const n of three)
      expect(code("2_recommendation_events")).not.toContain(`"${n}"`);
    for (const n of two) expect(code("3_crawl_mode")).not.toContain(`"${n}"`);
  });

  test("migration 4's new enum values are not used in the same migration", () => {
    const sql = code("4_recommendation_identity");
    for (const v of ["IDENTITY_CHANGED", "IDENTITY_LINK_DECLINED"])
      expect(sql.split(`'${v}'`).length - 1).toBe(1);
  });
});

describe("migrations 2 and 4 leave existing rows alone", () => {
  test.each(["2_recommendation_events", "4_recommendation_identity"])(
    "%s: no UPDATE, DELETE, DROP, TRUNCATE, rename or type change of existing columns",
    (m) => {
      const sql = code(m);
      expect(sql).not.toMatch(
        /\b(UPDATE\s+"|DELETE\s+FROM|DROP\s|TRUNCATE|RENAME|ALTER COLUMN|SET DEFAULT|SET NOT NULL)\b/i,
      );
      // Only CREATE TABLE statements may declare NOT NULL or DEFAULT.
      for (const s of sql.split(/;\s*\n/).filter((x) => /ALTER TABLE/.test(x)))
        expect(s).not.toMatch(/NOT NULL|DEFAULT/);
    },
  );

  test("the only columns added to existing tables are nullable, without defaults", () => {
    const added = [
      ...code("4_recommendation_identity").matchAll(
        /ADD COLUMN\s+"(\w+)" ([^,;]+)/g,
      ),
    ].map((m) => `${m[1]} ${m[2].trim()}`);
    expect(added).toEqual(["identityKey TEXT", "recurrenceOfId TEXT"]);
    expect(code("2_recommendation_events")).not.toMatch(/ADD COLUMN/);
  });

  test("constraints added to recommendations involve only the new nullable column", () => {
    const sql = code("4_recommendation_identity");
    expect(sql).toMatch(
      /CHECK \("recurrenceOfId" IS NULL OR "recurrenceOfId" <> "id"\)/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "recommendations_recurrenceOfId_key" ON "recommendations"\("recurrenceOfId"\)/,
    );
    expect(sql).not.toMatch(/NULLS NOT DISTINCT/);
  });

  test("triggers are attached only to the tables these migrations create", () => {
    const on = (m: string) =>
      [
        ...raw(m).matchAll(/CREATE TRIGGER "\w+"\s+\w+ [\w\s]+? ON "(\w+)"/g),
      ].map((x) => x[1]);
    expect(on("2_recommendation_events")).toEqual(["recommendation_events"]);
    expect(on("4_recommendation_identity")).toEqual([
      "recommendation_evidence",
      "recommendation_evidence",
    ]);
  });

  test("no migration file contains explicit transaction control", () => {
    for (const m of MIGRATIONS)
      expect(code(m)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });
});
