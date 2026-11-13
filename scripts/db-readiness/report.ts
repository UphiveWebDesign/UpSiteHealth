import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import { identityCapabilities } from "@/lib/recommendations/capabilities";
import { historyAvailable } from "@/lib/recommendations/events";
import { REHEARSAL_MARKER } from "../../prisma/safety";
import {
  REPO_ROOT,
  TEST_DB_MARKER,
} from "../../tests/integration/test-db-guard";
import {
  EXPECTED_OBJECTS,
  MIGRATIONS,
  type MigrationName,
  type MigrationObjects,
} from "./expected";

/**
 * The readiness report (docs/operations/environment-readiness.md): what a
 * database has of migrations 0–4, what the Stage 2 capability checks say,
 * and the counts M2 depends on. Everything here reads; run.ts runs it in a
 * read-only transaction that is always rolled back.
 *
 * Output is counts, booleans, object and migration names, and sanitised
 * identity fields (endpoint, branch, database, role, server version): never
 * a connection string, credentials, or row data.
 */

/** The client a report reads through: a read-only transaction. */
export type ReadOnlyTx = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "$queryRawUnsafe" | "$executeRawUnsafe"
>;

/**
 * Every statement the report sends, apart from the two capability checks it
 * calls (src/lib/recommendations, SELECT only). Fixed text, no parameters.
 * The first three run before anything else (run.ts); the static test
 * requires every one to be a SELECT or a transaction-local SET.
 */
export const QUERIES = {
  readOnly: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
  statementTimeout: "SET LOCAL statement_timeout = '30s'",
  lockTimeout: "SET LOCAL lock_timeout = '5s'",
  transactionMode: `SELECT current_setting('transaction_read_only') AS "readOnly",
    current_setting('transaction_isolation') AS isolation`,
  identity: `SELECT current_database() AS database, current_user AS role,
    current_setting('server_version') AS "serverVersion",
    current_setting('neon.endpoint_id', true) AS endpoint,
    current_setting('neon.branch_id', true) AS branch`,
  marker: `SELECT to_jsonb(m) AS row FROM "${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}" m`,
  // Rehearsal only: either marker table may be absent there, so its presence
  // is read first (a missing table would abort the transaction).
  testMarkerTable: `SELECT to_regclass('"${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}"') IS NOT NULL AS present`,
  rehearsalMarkerTable: `SELECT to_regclass('"${REHEARSAL_MARKER.schema}"."${REHEARSAL_MARKER.table}"') IS NOT NULL AS present`,
  rehearsalMarker: `SELECT to_jsonb(m) AS row FROM "${REHEARSAL_MARKER.schema}"."${REHEARSAL_MARKER.table}" m`,
  historyTable: `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
  history: `SELECT migration_name AS name, checksum,
    finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS "rolledBack"
    FROM public._prisma_migrations ORDER BY started_at, migration_name`,
  enums: `SELECT n.nspname AS schema, t.typname AS type, e.enumlabel AS label
    FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  tables: `SELECT n.nspname AS schema, c.relname AS "table", c.relrowsecurity AS rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
  columns: `SELECT c.relname AS "table", a.attname AS "column"
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped`,
  indexes: `SELECT c.relname AS name FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('i', 'I')`,
  constraints: `SELECT k.conname AS name FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_namespace n ON n.oid = k.connamespace
    WHERE n.nspname = 'public'`,
  functions: `SELECT p.proname AS name FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'`,
  triggers: `SELECT c.relname AS "table", tr.tgname AS name,
    tr.tgenabled <> 'D' AS enabled
    FROM pg_catalog.pg_trigger tr
    JOIN pg_catalog.pg_class c ON c.oid = tr.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tr.tgisinternal`,
  // M2 (design doc, section 5): at most one PROPOSED, IN_PROGRESS or
  // DISMISSED row per (websiteId, identityKey). Needs M1's column.
  identityDuplicates: `SELECT count(*)::int AS groups,
    COALESCE(sum(n), 0)::int AS "rowCount",
    count(DISTINCT "websiteId")::int AS websites
    FROM (SELECT "websiteId", count(*) AS n FROM public.recommendations
      WHERE "identityKey" IS NOT NULL
        AND status IN ('PROPOSED', 'IN_PROGRESS', 'DISMISSED')
      GROUP BY "websiteId", "identityKey" HAVING count(*) > 1) d`,
  keyedRows: `SELECT count(*)::int AS keyed FROM public.recommendations
    WHERE "identityKey" IS NOT NULL`,
  // docs/specs/seo-engagement-workflow.md: open tasks of one website that
  // share a title (the duplicates D5 would resolve before an index).
  titleDuplicates: `SELECT count(*)::int AS groups,
    COALESCE(sum(n), 0)::int AS "rowCount",
    count(DISTINCT "websiteId")::int AS websites
    FROM (SELECT "websiteId", count(*) AS n FROM public.recommendations
      WHERE status IN ('PROPOSED', 'IN_PROGRESS')
      GROUP BY "websiteId", title HAVING count(*) > 1) d`,
} as const;

/** Tables whose rows are counted, when they exist (fixed names only). */
export const COUNTED_TABLES = [
  "organizations",
  "websites",
  "crawl_runs",
  "recommendations",
  "recommendation_events",
  "recommendation_evidence",
  "business_facts",
] as const;

/** One SELECT counting the given tables (names from COUNTED_TABLES only). */
export function countsQuery(tables: readonly string[]): string {
  const known = new Set<string>(COUNTED_TABLES);
  const parts = tables
    .filter((t) => known.has(t))
    .map((t) => `(SELECT count(*) FROM public."${t}")::int AS "${t}"`);
  return parts.length ? `SELECT ${parts.join(",\n    ")}` : "";
}

// ─── Catalog and comparison ──────────────────────────────────────────────────

export type Catalog = {
  enumValues: Array<{ schema: string; type: string; label: string }>;
  tables: Array<{ schema: string; table: string; rls: boolean }>;
  columns: Array<{ table: string; column: string }>;
  indexes: string[];
  constraints: string[];
  functions: string[];
  triggers: Array<{ table: string; name: string; enabled: boolean }>;
};

export type ObjectCheck = {
  state: "present" | "partial" | "absent";
  expected: number;
  found: number;
  /** Plain names of what is missing (a disabled trigger counts as missing). */
  missing: string[];
  /** Types or tables of this migration found in another schema only. */
  outsidePublic: string[];
};

/** Compares one migration's objects with the catalog. */
export function checkObjects(
  expected: MigrationObjects,
  catalog: Catalog,
): ObjectCheck {
  const items: Array<[string, boolean]> = [];
  const outside = new Set<string>();
  const inPublic = (schema: string) => schema === "public";

  for (const [type, labels] of Object.entries(expected.enumValues)) {
    for (const label of labels)
      items.push([
        `enum value "${type}".${label}`,
        catalog.enumValues.some(
          (e) => inPublic(e.schema) && e.type === type && e.label === label,
        ),
      ]);
    const elsewhere = catalog.enumValues
      .filter((e) => e.type === type && !inPublic(e.schema))
      .map((e) => e.schema);
    for (const schema of new Set(elsewhere))
      outside.add(`type "${type}" in schema ${schema}`);
  }
  const table = (name: string) =>
    catalog.tables.find((t) => inPublic(t.schema) && t.table === name);
  for (const name of expected.tables) {
    items.push([`table ${name}`, !!table(name)]);
    for (const t of catalog.tables)
      if (t.table === name && !inPublic(t.schema))
        outside.add(`table ${name} in schema ${t.schema}`);
  }
  for (const [tableName, columns] of Object.entries(expected.columns))
    for (const column of columns)
      items.push([
        `column ${tableName}."${column}"`,
        catalog.columns.some(
          (c) => c.table === tableName && c.column === column,
        ),
      ]);
  for (const name of expected.indexes)
    items.push([`index ${name}`, catalog.indexes.includes(name)]);
  for (const name of expected.constraints)
    items.push([`constraint ${name}`, catalog.constraints.includes(name)]);
  for (const name of expected.functions)
    items.push([`function ${name}`, catalog.functions.includes(name)]);
  for (const [tableName, names] of Object.entries(expected.triggers))
    for (const name of names) {
      const t = catalog.triggers.find(
        (x) => x.table === tableName && x.name === name,
      );
      items.push([
        t && !t.enabled
          ? `trigger ${name} on ${tableName} (disabled)`
          : `trigger ${name} on ${tableName}`,
        !!t?.enabled,
      ]);
    }
  for (const name of expected.rowLevelSecurity)
    items.push([`row-level security on ${name}`, !!table(name)?.rls]);

  const missing = items.filter(([, ok]) => !ok).map(([label]) => label);
  const found = items.length - missing.length;
  return {
    state:
      missing.length === 0 ? "present" : found === 0 ? "absent" : "partial",
    expected: items.length,
    found,
    missing,
    outsidePublic: [...outside],
  };
}

// ─── Migration history ───────────────────────────────────────────────────────

export type HistoryRow = {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
};

export type HistoryState =
  | "finished"
  | "unfinished"
  | "rolled-back"
  | "not-recorded"
  | "no-history-table";

export type MigrationStatus = {
  name: MigrationName;
  history: HistoryState;
  /** The first 8 characters of the recorded checksum. */
  checksumPrefix: string | null;
  /** The recorded checksum equals the SHA-256 of the repository's file. */
  checksumMatchesFile: boolean | null;
  /** Null for 0_baseline: its objects are not checked. */
  objects: ObjectCheck | null;
  assessment: string;
};

/** Prisma's migration checksum: the SHA-256 of the migration file. */
export function fileChecksum(
  name: string,
  root: string = REPO_ROOT,
): string | null {
  const file = path.join(root, "prisma/migrations", name, "migration.sql");
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The history state of one migration. Prisma keeps a row per attempt, so
 * the latest row decides (a rolled-back attempt followed by a finished one
 * is finished).
 */
function historyState(
  rows: HistoryRow[] | null,
  name: string,
): { state: HistoryState; row: HistoryRow | null } {
  if (rows === null) return { state: "no-history-table", row: null };
  const mine = rows.filter((r) => r.name === name);
  const row = mine.at(-1) ?? null;
  if (!row) return { state: "not-recorded", row: null };
  if (row.rolledBack) return { state: "rolled-back", row };
  return { state: row.finished ? "finished" : "unfinished", row };
}

/** What history and objects together say about one migration. */
export function assess(
  history: HistoryState,
  objects: ObjectCheck | null,
  checksumMatchesFile: boolean | null,
): string {
  const recorded = history === "finished";
  const checksum =
    recorded && checksumMatchesFile === false
      ? " The recorded checksum differs from the repository's file."
      : "";
  if (!objects) {
    if (recorded)
      return `Recorded as applied (objects not checked).${checksum}`;
    if (history === "no-history-table")
      return "No migration history table; objects not checked.";
    return `History: ${history}; objects not checked.`;
  }
  const where = objects.outsidePublic.length
    ? ` Found outside schema public: ${objects.outsidePublic.join(", ")}.`
    : "";
  if (objects.state === "partial")
    return `Partly present (${objects.found} of ${objects.expected}): must not be marked applied; review what is missing.${where}${checksum}`;
  if (recorded)
    return objects.state === "present"
      ? `Applied: recorded and every object present.${checksum}`
      : `Recorded as applied, but its objects are absent: investigate before any further migration.${where}${checksum}`;
  if (history === "unfinished" || history === "rolled-back")
    return `History shows it ${history === "unfinished" ? "started but not finished" : "rolled back"}; objects ${objects.state}. Review before any further migration.${where}`;
  if (objects.state === "present")
    return `Objects present but not recorded in migration history. Presence does not prove the migration was applied exactly as written; history would need baselining (a separate decision).${where}`;
  return `Not applied.${where}`;
}

export function migrationStatuses(
  rows: HistoryRow[] | null,
  catalog: Catalog,
  root: string = REPO_ROOT,
): MigrationStatus[] {
  return MIGRATIONS.map((name) => {
    const { state, row } = historyState(rows, name);
    const file = fileChecksum(name, root);
    const checksumMatchesFile =
      row && file !== null ? row.checksum === file : null;
    const objects =
      name === "0_baseline"
        ? null
        : checkObjects(EXPECTED_OBJECTS[name], catalog);
    return {
      name,
      history: state,
      checksumPrefix: row ? row.checksum.slice(0, 8) : null,
      checksumMatchesFile,
      objects,
      assessment: assess(state, objects, checksumMatchesFile),
    };
  });
}

// ─── The report ──────────────────────────────────────────────────────────────

export type ServerIdentity = {
  endpoint: string | null;
  branch: string | null;
  database: string;
  role: string;
  serverVersion: string;
};

export type DuplicateCount = {
  groups: number;
  rowCount: number;
  websites: number;
};

export type ReadinessReport = {
  generatedAt: string;
  target: { name: "test" | "app" | "rehearsal"; label: string };
  server: ServerIdentity;
  transaction: { readOnly: true; isolation: string; endedBy: "rollback" };
  history: {
    tablePresent: boolean;
    rows: Array<{
      name: string;
      finished: boolean;
      rolledBack: boolean;
      checksumPrefix: string;
    }>;
    /** Recorded names that are not migrations in this repository. */
    unknown: string[];
  };
  migrations: MigrationStatus[];
  capabilities: {
    /** historyAvailable(): task history (recommendation_events) exists. */
    history: boolean;
    /** identityCapabilities(): every part of M1 the Stage 2 code needs. */
    identity: { enabled: boolean; missing: string[] };
  };
  duplicates: {
    /** M2's collisions; null without the identityKey column. */
    identity: (DuplicateCount & { keyedRows: number }) | null;
    /** Open tasks of one website sharing a title; null without the table. */
    openTitles: DuplicateCount | null;
  };
  /** Row counts of the tables that exist (COUNTED_TABLES). */
  counts: Record<string, number>;
};

/** Reads the catalog: names only, no row data. */
export async function readCatalog(tx: ReadOnlyTx): Promise<Catalog> {
  const q = <T>(sql: string) => tx.$queryRawUnsafe<T[]>(sql);
  const [
    enumValues,
    tables,
    columns,
    indexes,
    constraints,
    functions,
    triggers,
  ] = [
    await q<Catalog["enumValues"][number]>(QUERIES.enums),
    await q<Catalog["tables"][number]>(QUERIES.tables),
    await q<Catalog["columns"][number]>(QUERIES.columns),
    await q<{ name: string }>(QUERIES.indexes),
    await q<{ name: string }>(QUERIES.constraints),
    await q<{ name: string }>(QUERIES.functions),
    await q<Catalog["triggers"][number]>(QUERIES.triggers),
  ];
  return {
    enumValues,
    tables,
    columns,
    indexes: indexes.map((r) => r.name),
    constraints: constraints.map((r) => r.name),
    functions: functions.map((r) => r.name),
    triggers,
  };
}

/**
 * Everything after the identity check, in an order that keeps the
 * transaction usable: plain queries first, guarded by the catalog so none
 * names a missing table, and the identity capability check last (it catches
 * its own errors, which would leave an aborted transaction behind).
 */
export async function inspect(
  tx: ReadOnlyTx,
  root: string = REPO_ROOT,
): Promise<
  Pick<
    ReadinessReport,
    "history" | "migrations" | "capabilities" | "duplicates" | "counts"
  >
> {
  const [{ present }] = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(
    QUERIES.historyTable,
  );
  const rows = present
    ? await tx.$queryRawUnsafe<HistoryRow[]>(QUERIES.history)
    : null;
  const catalog = await readCatalog(tx);
  const publicTables = catalog.tables
    .filter((t) => t.schema === "public")
    .map((t) => t.table);
  const hasColumn = (table: string, column: string) =>
    catalog.columns.some((c) => c.table === table && c.column === column);

  let identity: ReadinessReport["duplicates"]["identity"] = null;
  let openTitles: ReadinessReport["duplicates"]["openTitles"] = null;
  if (publicTables.includes("recommendations")) {
    [openTitles] = await tx.$queryRawUnsafe<DuplicateCount[]>(
      QUERIES.titleDuplicates,
    );
    if (hasColumn("recommendations", "identityKey")) {
      const [dup] = await tx.$queryRawUnsafe<DuplicateCount[]>(
        QUERIES.identityDuplicates,
      );
      const [{ keyed }] = await tx.$queryRawUnsafe<Array<{ keyed: number }>>(
        QUERIES.keyedRows,
      );
      identity = { ...dup, keyedRows: keyed };
    }
  }
  const countSql = countsQuery(publicTables);
  const [counts] = countSql
    ? await tx.$queryRawUnsafe<Array<Record<string, number>>>(countSql)
    : [{}];

  const history = await historyAvailable(tx);
  const identityCaps = await identityCapabilities(tx);

  const known = new Set<string>(MIGRATIONS);
  return {
    history: {
      tablePresent: present,
      rows: (rows ?? []).map((r) => ({
        name: r.name,
        finished: r.finished,
        rolledBack: r.rolledBack,
        checksumPrefix: r.checksum.slice(0, 8),
      })),
      unknown: [
        ...new Set(
          (rows ?? []).map((r) => r.name).filter((n) => !known.has(n)),
        ),
      ],
    },
    migrations: migrationStatuses(rows, catalog, root),
    capabilities: {
      history,
      identity: {
        enabled: identityCaps.enabled,
        missing: identityCaps.missing,
      },
    },
    duplicates: { identity, openTitles },
    counts,
  };
}

// ─── Output ──────────────────────────────────────────────────────────────────

const dup = (d: DuplicateCount) =>
  `${d.groups} groups, ${d.rowCount} rows, ${d.websites} websites`;

export function formatText(r: ReadinessReport): string {
  const s = r.server;
  const lines = [
    `Database readiness (read-only), ${r.generatedAt}`,
    `Target: ${r.target.name}, ${r.target.label}`,
    `Server: endpoint ${s.endpoint ?? "(not reported)"}, branch ${s.branch ?? "(not reported)"}, database ${s.database}, role ${s.role}, PostgreSQL ${s.serverVersion}`,
    `Transaction: read only (${r.transaction.isolation}), ended by rollback`,
    "",
    `Migration history (_prisma_migrations): ${r.history.tablePresent ? `${r.history.rows.length} rows` : "absent"}`,
    ...r.history.rows.map(
      (h) =>
        `  ${h.name}: ${h.rolledBack ? "rolled back" : h.finished ? "finished" : "not finished"}, checksum ${h.checksumPrefix}…`,
    ),
    ...(r.history.unknown.length
      ? [`  Not in this repository: ${r.history.unknown.join(", ")}`]
      : []),
    "",
    "Migrations:",
  ];
  for (const m of r.migrations) {
    const objects = m.objects
      ? `objects ${m.objects.state} (${m.objects.found}/${m.objects.expected})`
      : "objects not checked";
    const checksum =
      m.checksumMatchesFile === null
        ? ""
        : m.checksumMatchesFile
          ? ", checksum matches file"
          : ", checksum DIFFERS from file";
    lines.push(`  ${m.name}: history ${m.history}${checksum}; ${objects}`);
    lines.push(`    ${m.assessment}`);
    if (m.objects?.state === "partial")
      for (const x of m.objects.missing) lines.push(`    missing: ${x}`);
  }
  const caps = r.capabilities;
  lines.push(
    "",
    `Task history (historyAvailable): ${caps.history ? "available" : "unavailable"}`,
    `Stage 2 identity (identityCapabilities): ${caps.identity.enabled ? "enabled" : "off"}`,
    ...caps.identity.missing.map((m) => `  missing: ${m}`),
    "",
    `M2 identity collisions: ${r.duplicates.identity ? `${dup(r.duplicates.identity)}; ${r.duplicates.identity.keyedRows} rows keyed` : "not applicable (no identityKey column)"}`,
    `Open tasks sharing a title: ${r.duplicates.openTitles ? dup(r.duplicates.openTitles) : "not applicable (no recommendations table)"}`,
    "",
    `Rows: ${
      Object.entries(r.counts)
        .map(([t, n]) => `${t} ${n}`)
        .join(", ") || "(none counted)"
    }`,
  );
  return lines.join("\n");
}

/**
 * Refuses output that could carry a credential: any postgres URL, or the
 * target URL's password or user:password pair. The report never puts them
 * in; this is the second line of defence.
 */
export function unsafeOutputProblem(text: string, url: string): string | null {
  if (/postgres(ql)?:\/\//i.test(text)) return "it contains a database URL";
  let password = "";
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    return "the target URL cannot be read";
  }
  if (password && text.includes(password)) return "it contains the password";
  if (text.includes(url)) return "it contains the connection string";
  return null;
}
