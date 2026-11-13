import { TEST_DB_MARKER } from "../../tests/integration/test-db-guard";
import {
  CATEGORIES,
  ident,
  stableJson,
  type CategoryName,
  type DefinitionItem,
  parseFingerprint,
  type Fingerprint,
} from "./definitions";
import { EXPECTED_OBJECTS, type MigrationName } from "./expected";

/**
 * Compares two definitions fingerprints (definitions.ts): a pure function of
 * two local files' contents, with no database access. The reference is the
 * database built by the migrations (itest-ci); the candidate is the one
 * being judged. MISSING: in the reference only. EXTRA: in the candidate
 * only. DIFFERENT: on both, with at least one field unequal. A category
 * either side did not collect is not compared and the result is
 * "incomplete": it never counts as a match.
 */

export const COMPARISON_FORMAT = "upsitehealth-db-definitions-comparison";

export type ComparisonStatus = "MATCH" | "MISSING" | "EXTRA" | "DIFFERENT";

export type FieldDifference = {
  field: string;
  reference: unknown;
  candidate: unknown;
};

export type ObjectComparison = {
  id: string;
  status: ComparisonStatus;
  /** Unequal fields, for DIFFERENT; empty otherwise. */
  differences: FieldDifference[];
  description: string;
  /** A MISSING and an EXTRA object identical apart from the name. */
  note?: string;
};

export type CategoryComparison =
  | {
      category: CategoryName;
      compared: true;
      counts: Record<ComparisonStatus, number>;
      objects: ObjectComparison[];
      /** Objects each side left out by rule (definitions.ts). */
      excluded: { reference: number; candidate: number };
    }
  | { category: CategoryName; compared: false; reason: string };

/** An object outside what prisma/schema.prisma models. */
export type InventoryEntry = {
  category: CategoryName;
  id: string;
  what: string;
  /** The migration or tool that creates it; null when nothing known does. */
  origin: string | null;
};

type Side = {
  generatedAt: string;
  target: Fingerprint["target"];
  server: Fingerprint["server"];
};

export type Comparison = {
  format: typeof COMPARISON_FORMAT;
  version: 1;
  reference: Side;
  candidate: Side;
  result: "identical" | "different" | "incomplete";
  warnings: string[];
  categories: CategoryComparison[];
  inventory: { reference: InventoryEntry[]; candidate: InventoryEntry[] };
};

/** The table and enum names prisma/schema.prisma models. */
export type PrismaNames = { tables: Set<string>; enums: Set<string> };

export function prismaNames(schema: string): PrismaNames {
  const tables = new Set<string>();
  const enums = new Set<string>();
  for (const m of schema.matchAll(
    /^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm,
  )) {
    const name = /@@map\("([^"]+)"\)/.exec(m[3])?.[1] ?? m[2];
    (m[1] === "model" ? tables : enums).add(name);
  }
  return { tables, enums };
}

// ─── Labels and descriptions ─────────────────────────────────────────────────

const NOUNS: Record<CategoryName, string> = {
  constraints: "constraint",
  indexes: "index",
  triggers: "trigger",
  functions: "function",
  rowSecurity: "row security of",
  policies: "policy",
  relations: "relation",
  types: "type",
  extensions: "extension",
  schemas: "schema",
};

function noun(category: CategoryName, item: DefinitionItem): string {
  if (category === "constraints") return `${String(item.type)} constraint`;
  if (category === "relations") return String(item.kind);
  if (category === "types") return `${String(item.kind)} type`;
  return NOUNS[category];
}

const show = (v: unknown) => JSON.stringify(v);

function objectDescription(
  category: CategoryName,
  item: DefinitionItem,
  status: ComparisonStatus,
  differences: FieldDifference[],
): string {
  const head = `${noun(category, item)} ${item.id}`;
  if (status === "MATCH") return `${head}: matches`;
  if (status === "MISSING")
    return `${head}: in the reference, missing from the candidate`;
  if (status === "EXTRA") return `${head}: in the candidate only`;
  return `${head}: ${differences
    .map((d) => `${d.field} ${show(d.reference)} → ${show(d.candidate)}`)
    .join("; ")}`;
}

// ─── Comparing ───────────────────────────────────────────────────────────────

function fieldDifferences(
  reference: DefinitionItem,
  candidate: DefinitionItem,
): FieldDifference[] {
  const keys = [
    ...new Set([...Object.keys(reference), ...Object.keys(candidate)]),
  ]
    .filter((k) => k !== "id")
    .sort();
  return keys
    .filter((k) => stableJson(reference[k]) !== stableJson(candidate[k]))
    .map((k) => ({
      field: k,
      reference: reference[k],
      candidate: candidate[k],
    }));
}

/**
 * The object without its own name, so a renamed object can be recognised:
 * its name is removed from its definition too (an index or trigger
 * definition names itself). Only used for a note, never for the status.
 */
function shape(item: DefinitionItem): string {
  const { id: _id, name, ...rest } = item;
  if (typeof name === "string" && typeof rest.definition === "string")
    rest.definition = rest.definition.split(ident(name)).join("?");
  return stableJson(rest);
}

function compareCategory(
  category: CategoryName,
  reference: DefinitionItem[],
  candidate: DefinitionItem[],
): ObjectComparison[] {
  const theirs = new Map(candidate.map((i) => [i.id, i]));
  const ours = new Map(reference.map((i) => [i.id, i]));
  const ids = [...new Set([...ours.keys(), ...theirs.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out = ids.map((id): ObjectComparison & { item: DefinitionItem } => {
    const r = ours.get(id);
    const c = theirs.get(id);
    const item = (r ?? c) as DefinitionItem;
    const differences = r && c ? fieldDifferences(r, c) : [];
    const status: ComparisonStatus = !c
      ? "MISSING"
      : !r
        ? "EXTRA"
        : differences.length
          ? "DIFFERENT"
          : "MATCH";
    return {
      id,
      status,
      differences,
      description: objectDescription(category, item, status, differences),
      item,
    };
  });
  const missing = out.filter((o) => o.status === "MISSING");
  const extra = out.filter((o) => o.status === "EXTRA");
  for (const m of missing)
    for (const e of extra)
      if (shape(m.item) === shape(e.item)) {
        m.note = `same definition apart from the name as extra ${e.id} (renamed?)`;
        e.note = `same definition apart from the name as missing ${m.id} (renamed?)`;
      }
  return out.map(({ item: _item, ...o }) => o);
}

const majorVersion = (v: string) => /^\d+/.exec(v)?.[0] ?? v;

export function compareFingerprints(
  reference: Fingerprint,
  candidate: Fingerprint,
  prisma: PrismaNames,
): Comparison {
  const warnings: string[] = [];
  const [rs, cs] = [reference.server, candidate.server];
  if (majorVersion(rs.serverVersion) !== majorVersion(cs.serverVersion))
    warnings.push(
      `the servers run different PostgreSQL major versions (${rs.serverVersion} and ${cs.serverVersion}); catalog output can differ between versions`,
    );
  if (
    rs.endpoint &&
    rs.endpoint === cs.endpoint &&
    rs.branch === cs.branch &&
    rs.database === cs.database
  )
    warnings.push("both fingerprints come from the same database");

  const categories = CATEGORIES.map((category): CategoryComparison => {
    const r = reference.categories[category];
    const c = candidate.categories[category];
    if (!r.collected || !c.collected) {
      const why = [
        !r.collected ? `reference: ${r.reason}` : null,
        !c.collected ? `candidate: ${c.reason}` : null,
      ].filter(Boolean);
      return {
        category,
        compared: false,
        reason: `not collected (${why.join("; ")})`,
      };
    }
    const objects = compareCategory(
      category,
      r.items as DefinitionItem[],
      c.items as DefinitionItem[],
    );
    const counts: Record<ComparisonStatus, number> = {
      MATCH: 0,
      MISSING: 0,
      EXTRA: 0,
      DIFFERENT: 0,
    };
    for (const o of objects) counts[o.status]++;
    const excluded = {
      reference: r.excluded.reduce((n, e) => n + e.count, 0),
      candidate: c.excluded.reduce((n, e) => n + e.count, 0),
    };
    if (excluded.reference !== excluded.candidate)
      warnings.push(
        `${category}: ${excluded.reference} objects excluded by rule in the reference, ${excluded.candidate} in the candidate`,
      );
    return { category, compared: true, counts, objects, excluded };
  });

  const result = categories.some((c) => !c.compared)
    ? "incomplete"
    : categories.every((c) => c.compared && c.counts.MATCH === c.objects.length)
      ? "identical"
      : "different";
  const side = (fp: Fingerprint): Side => ({
    generatedAt: fp.generatedAt,
    target: fp.target,
    server: fp.server,
  });
  return {
    format: COMPARISON_FORMAT,
    version: 1,
    reference: side(reference),
    candidate: side(candidate),
    result,
    warnings,
    categories,
    inventory: {
      reference: inventory(reference, prisma),
      candidate: inventory(candidate, prisma),
    },
  };
}

// ─── Inventory of unmodelled objects ─────────────────────────────────────────

const MIGRATION_NAMES = Object.keys(EXPECTED_OBJECTS) as Array<
  Exclude<MigrationName, "0_baseline">
>;

/** The migration whose expected objects (expected.ts) include this one. */
function migrationOf(
  pick: (
    o: (typeof EXPECTED_OBJECTS)[keyof typeof EXPECTED_OBJECTS],
  ) => boolean,
): string | null {
  const m = MIGRATION_NAMES.find((name) => pick(EXPECTED_OBJECTS[name]));
  return m ? `migration ${m}` : null;
}

/** Why an object is not modelled by Prisma, or null when it is. */
function unmodelled(
  category: CategoryName,
  item: DefinitionItem,
  prisma: PrismaNames,
): string | null {
  switch (category) {
    case "constraints":
      return ["check", "exclusion", "constraint trigger"].includes(
        String(item.type),
      )
        ? `${String(item.type)} constraint`
        : null;
    case "indexes":
      return item.predicate !== null
        ? "partial index"
        : item.hasExpressions
          ? "expression index"
          : null;
    case "triggers":
      return `trigger (${String(item.enabled)})`;
    case "functions":
      return item.securityDefiner
        ? `${String(item.kind)} (security definer)`
        : String(item.kind);
    case "rowSecurity":
      return item.forced
        ? "row-level security enabled and forced"
        : item.enabled
          ? "row-level security enabled"
          : null;
    case "policies":
      return "row-level security policy";
    case "relations":
      return item.kind === "table" && prisma.tables.has(String(item.name))
        ? null
        : item.kind === "table"
          ? "table not in schema.prisma"
          : String(item.kind);
    case "types":
      return item.kind === "enum" && prisma.enums.has(String(item.name))
        ? null
        : item.kind === "enum"
          ? "enum not in schema.prisma"
          : `${String(item.kind)} type`;
    case "extensions":
      return item.name === "plpgsql" ? null : "extension";
    case "schemas":
      return item.name === "public" ? null : "schema";
  }
}

function origin(category: CategoryName, item: DefinitionItem): string | null {
  const name = String(item.name ?? "");
  const table = String(item.table ?? "");
  switch (category) {
    case "constraints":
      return migrationOf((o) => o.constraints.includes(name));
    case "indexes":
      return migrationOf((o) => o.indexes.includes(name));
    case "functions":
      return migrationOf((o) => o.functions.includes(name));
    case "triggers":
      return migrationOf((o) => (o.triggers[table] ?? []).includes(name));
    case "rowSecurity":
      return item.forced
        ? null
        : migrationOf((o) => o.rowLevelSecurity.includes(table));
    case "relations":
      return name === "_prisma_migrations" ? "Prisma Migrate history" : null;
    case "schemas":
      // REHEARSAL_MARKER.schema (prisma/safety.ts; a test keeps them equal).
      return name === TEST_DB_MARKER.schema
        ? "integration-test marker"
        : name === "upsitehealth_rehearsal"
          ? "rehearsal marker"
          : null;
    default:
      return null;
  }
}

/**
 * Every collected object Prisma does not model, with the migration that
 * creates it. An object no migration creates is reported, not judged: the
 * comparison says whether the other database has it too.
 */
export function inventory(
  fp: Fingerprint,
  prisma: PrismaNames,
): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  for (const category of CATEGORIES) {
    const c = fp.categories[category];
    if (!c.collected) continue;
    for (const item of c.items as DefinitionItem[]) {
      const what = unmodelled(category, item, prisma);
      if (what)
        out.push({
          category,
          id: item.id,
          what,
          origin: origin(category, item),
        });
    }
  }
  return out;
}

// ─── Output ──────────────────────────────────────────────────────────────────

const sideLine = (s: Side) =>
  `${s.target.name}, ${s.target.label}; endpoint ${s.server.endpoint ?? "(not reported)"}, branch ${s.server.branch ?? "(not reported)"}, database ${s.server.database}, PostgreSQL ${s.server.serverVersion}; collected ${s.generatedAt}`;

export function formatComparison(c: Comparison): string {
  const lines = [
    "Database definitions comparison (offline, from two fingerprint files)",
    `Reference: ${sideLine(c.reference)}`,
    `Candidate: ${sideLine(c.candidate)}`,
    `Result: ${c.result}`,
    ...c.warnings.map((w) => `Warning: ${w}`),
    "",
  ];
  for (const cat of c.categories) {
    if (!cat.compared) {
      lines.push(`${cat.category}: NOT COMPARED, ${cat.reason}`);
      continue;
    }
    const n = cat.counts;
    lines.push(
      `${cat.category}: ${n.MATCH} match, ${n.MISSING} missing, ${n.EXTRA} extra, ${n.DIFFERENT} different`,
    );
    for (const o of cat.objects)
      if (o.status !== "MATCH")
        lines.push(
          `  ${o.status} ${o.description}${o.note ? ` (${o.note})` : ""}`,
        );
  }
  for (const side of ["reference", "candidate"] as const) {
    lines.push("", `Not modelled by Prisma (${side}):`);
    const entries = c.inventory[side];
    if (!entries.length) lines.push("  (none)");
    for (const e of entries)
      lines.push(
        `  ${e.id}: ${e.what}; ${e.origin ?? "created by no known migration"}`,
      );
  }
  return lines.join("\n");
}

// ─── Command line ────────────────────────────────────────────────────────────

export const COMPARE_USAGE = `Usage: npm run db:definitions:compare -- <reference.json> <candidate.json> [--json]

  reference.json  the fingerprint of the database built by the migrations
  candidate.json  the fingerprint of the database being judged
  --json          print the comparison as JSON

Offline: reads the two files only, never a database. Exit 0 identical,
2 different, 1 incomplete or unreadable.`;

export type CompareDeps = {
  readFile: (file: string) => string;
  /** prisma/schema.prisma, for the inventory of unmodelled objects. */
  prismaSchema: () => string;
  out: (text: string) => void;
  err: (text: string) => void;
};

/** Exit codes: 0 identical, 2 different, 1 incomplete or unreadable, 2 usage. */
export function runCompare(argv: string[], deps: CompareDeps): number {
  const files = argv.filter((a) => !a.startsWith("--"));
  const flags = argv.filter((a) => a.startsWith("--"));
  const bad = flags.find((f) => f !== "--json");
  if (bad || files.length !== 2) {
    deps.err(
      `${bad ? `Unknown argument: ${bad}` : "Give exactly two fingerprint files."}\n\n${COMPARE_USAGE}`,
    );
    return 2;
  }
  const read = (file: string): Fingerprint | string => {
    let text: string;
    try {
      text = deps.readFile(file);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return `${file} cannot be read (${typeof code === "string" ? code : "error"})`;
    }
    const parsed = parseFingerprint(text);
    return "error" in parsed ? `${file}: ${parsed.error}` : parsed.fingerprint;
  };
  const [reference, candidate] = files.map(read);
  for (const side of [reference, candidate])
    if (typeof side === "string") {
      deps.err(`Not compared: ${side}.`);
      return 1;
    }
  const comparison = compareFingerprints(
    reference as Fingerprint,
    candidate as Fingerprint,
    prismaNames(deps.prismaSchema()),
  );
  deps.out(
    flags.includes("--json")
      ? stableJson(comparison)
      : formatComparison(comparison),
  );
  return comparison.result === "identical"
    ? 0
    : comparison.result === "different"
      ? 2
      : 1;
}
