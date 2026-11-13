import type { ReadOnlyTx, ServerIdentity } from "./report";

/**
 * The definitions fingerprint (docs/operations/database-definitions-fingerprint.md):
 * the definitions in schema `public` that `prisma migrate diff` does not
 * compare — CHECK constraints, triggers, functions, row-level security and
 * policies, index predicates and expressions, views, types — read from the
 * catalog as PostgreSQL itself prints them (pg_get_constraintdef,
 * pg_get_indexdef, pg_get_triggerdef, pg_get_functiondef, pg_policies).
 *
 * Everything here reads; definitions-run.ts runs it inside the readiness
 * report's read-only transaction, after the server is proven. A fingerprint
 * holds definitions and names only: never a connection string, credentials
 * or row data. Two fingerprints are compared offline
 * (compare-definitions.ts), never two databases at once.
 */

export const FINGERPRINT_FORMAT = "upsitehealth-db-definitions";
export const FINGERPRINT_VERSION = 1;

/**
 * The search path every catalog query runs with. The pg_get_* functions
 * qualify a name only when the search path does not find it, so a fixed
 * path that excludes `public` makes every definition print `public.` the
 * same way on every server.
 */
export const SEARCH_PATH = "pg_catalog";

/** The only normalisation applied to collected text. */
export const NORMALIZATION = [
  "line endings CRLF to LF in definitions and expressions",
  "role and setting lists sorted (PostgreSQL treats them as sets)",
] as const;

export const CATEGORIES = [
  "constraints",
  "indexes",
  "triggers",
  "functions",
  "rowSecurity",
  "policies",
  "relations",
  "types",
  "extensions",
  "schemas",
] as const;
export type CategoryName = (typeof CATEGORIES)[number];

/** A system or extension object left out, by a documented rule. */
export type Exclusion = { rule: string; count: number };

/**
 * A category is either collected in full or not collected: a category that
 * could not be read is never an empty list.
 */
export type Category<T> =
  | { collected: true; items: T[]; excluded: Exclusion[] }
  | { collected: false; reason: string };

export type ConstraintDef = {
  id: string;
  schema: string;
  table: string;
  name: string;
  type:
    | "check"
    | "foreign key"
    | "primary key"
    | "unique"
    | "exclusion"
    | "constraint trigger"
    | "not null";
  definition: string;
  validated: boolean;
  deferrable: boolean;
  deferred: boolean;
  noInherit: boolean;
};

export type IndexDef = {
  id: string;
  schema: string;
  table: string;
  name: string;
  definition: string;
  unique: boolean;
  primary: boolean;
  method: string;
  /** Key columns or expressions, in index order. */
  keyColumns: string[];
  /** INCLUDE columns, in index order. */
  includeColumns: string[];
  hasExpressions: boolean;
  /** The partial-index predicate; null for a full index. */
  predicate: string | null;
  nullsNotDistinct: boolean;
  valid: boolean;
  ready: boolean;
};

export type TriggerDef = {
  id: string;
  schema: string;
  table: string;
  name: string;
  definition: string;
  enabled: "enabled" | "disabled" | "replica only" | "always";
  /** schema.name(identity arguments) of the trigger function. */
  function: string;
  constraintTrigger: boolean;
};

export type FunctionDef = {
  id: string;
  schema: string;
  name: string;
  identityArguments: string;
  returns: string;
  kind: "function" | "procedure" | "aggregate" | "window";
  language: string;
  securityDefiner: boolean;
  volatility: "immutable" | "stable" | "volatile";
  strict: boolean;
  leakproof: boolean;
  /** SET clauses (e.g. search_path=…), sorted. */
  config: string[];
  /** pg_get_functiondef; null for an aggregate, which it cannot print. */
  definition: string | null;
};

export type RowSecurityDef = {
  id: string;
  schema: string;
  table: string;
  enabled: boolean;
  forced: boolean;
};

export type PolicyDef = {
  id: string;
  schema: string;
  table: string;
  name: string;
  command: string;
  mode: "PERMISSIVE" | "RESTRICTIVE";
  roles: string[];
  using: string | null;
  withCheck: string | null;
};

export type RelationDef = {
  id: string;
  schema: string;
  name: string;
  kind:
    | "table"
    | "partitioned table"
    | "view"
    | "materialized view"
    | "sequence"
    | "foreign table";
  /** A view's query or a sequence's parameters; null for tables. */
  definition: string | null;
};

export type TypeDef = {
  id: string;
  schema: string;
  name: string;
  kind: "enum" | "domain" | "composite" | "range" | "multirange";
  /** Enum labels in order, a domain's base type and constraints, … */
  definition: string | null;
};

export type ExtensionDef = {
  id: string;
  name: string;
  schema: string;
  version: string;
};

export type SchemaDef = { id: string; name: string };

export type Categories = {
  constraints: Category<ConstraintDef>;
  indexes: Category<IndexDef>;
  triggers: Category<TriggerDef>;
  functions: Category<FunctionDef>;
  rowSecurity: Category<RowSecurityDef>;
  policies: Category<PolicyDef>;
  relations: Category<RelationDef>;
  types: Category<TypeDef>;
  extensions: Category<ExtensionDef>;
  schemas: Category<SchemaDef>;
};

export type DefinitionItem = { id: string } & Record<string, unknown>;

export type Fingerprint = {
  format: typeof FINGERPRINT_FORMAT;
  version: typeof FINGERPRINT_VERSION;
  generatedAt: string;
  target: { name: "test" | "app" | "rehearsal"; label: string };
  server: ServerIdentity;
  transaction: {
    readOnly: true;
    sessionDefaultReadOnly: true;
    isolation: string;
    endedBy: "rollback";
  };
  scope: {
    schema: "public";
    searchPath: typeof SEARCH_PATH;
    normalization: string[];
  };
  categories: Categories;
};

/**
 * Every statement the collector sends, after the readiness report's own
 * (read-only marker, timeouts, identity). Fixed text, no parameters; the
 * static test requires each to be a SELECT or this one transaction-local SET.
 */
export const DEFINITION_QUERIES = {
  searchPath: `SET LOCAL search_path = ${SEARCH_PATH}`,
  confirmSearchPath: `SELECT current_setting('search_path') AS "searchPath"`,
  constraints: `SELECT n.nspname AS schema, c.relname AS "table", k.conname AS name,
    k.contype::text AS type, pg_catalog.pg_get_constraintdef(k.oid) AS definition,
    k.convalidated AS validated, k.condeferrable AS deferrable,
    k.condeferred AS deferred, k.connoinherit AS "noInherit"
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'`,
  indexes: `SELECT n.nspname AS schema, t.relname AS "table", i.relname AS name,
    pg_catalog.pg_get_indexdef(x.indexrelid) AS definition,
    x.indisunique AS "unique", x.indisprimary AS "primary", am.amname AS method,
    x.indnkeyatts::int AS "keyCount",
    ARRAY(SELECT pg_catalog.pg_get_indexdef(x.indexrelid, k, false)
      FROM pg_catalog.generate_series(1, x.indnatts::int) AS k ORDER BY k) AS columns,
    x.indexprs IS NOT NULL AS "hasExpressions",
    pg_catalog.pg_get_expr(x.indpred, x.indrelid) AS predicate,
    x.indnullsnotdistinct AS "nullsNotDistinct",
    x.indisvalid AS valid, x.indisready AS ready
    FROM pg_catalog.pg_index x
    JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public'`,
  triggers: `SELECT n.nspname AS schema, c.relname AS "table", tr.tgname AS name,
    pg_catalog.pg_get_triggerdef(tr.oid) AS definition,
    tr.tgenabled::text AS enabled, tr.tgisinternal AS internal,
    tr.tgconstraint <> 0::oid AS "constraintTrigger",
    fn.nspname AS "functionSchema", p.proname AS "functionName",
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS "functionArguments"
    FROM pg_catalog.pg_trigger tr
    JOIN pg_catalog.pg_class c ON c.oid = tr.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = tr.tgfoid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
    WHERE n.nspname = 'public'`,
  // An extension's functions are listed (to be counted) but their bodies
  // are not read: the extension and its version stand for them.
  functions: `SELECT n.nspname AS schema, p.proname AS name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS "identityArguments",
    pg_catalog.pg_get_function_result(p.oid) AS "returns",
    p.prokind::text AS kind, l.lanname AS language,
    p.prosecdef AS "securityDefiner", p.provolatile::text AS volatility,
    p.proisstrict AS strict, p.proleakproof AS leakproof,
    COALESCE(p.proconfig, '{}')::text[] AS config, e.extname AS extension,
    CASE WHEN p.prokind <> 'a' AND e.extname IS NULL
      THEN pg_catalog.pg_get_functiondef(p.oid) END AS definition
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_proc'::regclass
      AND d.objid = p.oid AND d.deptype = 'e'
    LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    WHERE n.nspname = 'public'`,
  rowSecurity: `SELECT n.nspname AS schema, c.relname AS "table",
    c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
  policies: `SELECT schemaname AS schema, tablename AS "table", policyname AS name,
    permissive AS mode, roles::text[] AS roles, cmd AS command,
    qual AS "using", with_check AS "withCheck"
    FROM pg_catalog.pg_policies WHERE schemaname = 'public'`,
  relations: `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
    CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid)
      WHEN c.relkind = 'S' THEN (SELECT pg_catalog.format(
        '%s start %s increment %s minimum %s maximum %s cache %s cycle %s',
        pg_catalog.format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement,
        s.seqmin, s.seqmax, s.seqcache, s.seqcycle)
        FROM pg_catalog.pg_sequence s WHERE s.seqrelid = c.oid) END AS definition
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
  types: `SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS kind,
    e.extname AS extension,
    CASE t.typtype
      WHEN 'e' THEN (SELECT pg_catalog.string_agg(pg_catalog.quote_literal(v.enumlabel),
        ', ' ORDER BY v.enumsortorder) FROM pg_catalog.pg_enum v WHERE v.enumtypid = t.oid)
      WHEN 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod)
        || CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END
        || COALESCE(' DEFAULT ' || t.typdefault, '')
        || COALESCE((SELECT ' ' || pg_catalog.string_agg(pg_catalog.pg_get_constraintdef(k.oid),
          ' ' ORDER BY k.conname) FROM pg_catalog.pg_constraint k WHERE k.contypid = t.oid), '')
      WHEN 'c' THEN (SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname) || ' '
        || pg_catalog.format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
      WHEN 'r' THEN (SELECT pg_catalog.format_type(r.rngsubtype, NULL)
        FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid)
    END AS definition
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
    LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_type'::regclass
      AND d.objid = t.oid AND d.deptype = 'e'
    LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c', 'r', 'm')
      AND (t.typtype <> 'c' OR c.relkind = 'c')`,
  extensions: `SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace`,
  schemas: `SELECT n.nspname AS name FROM pg_catalog.pg_namespace n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname !~ '^pg_(toast_)?temp_[0-9]+$'`,
} as const satisfies Record<
  CategoryName | "searchPath" | "confirmSearchPath",
  string
>;

// ─── Exclusion rules ─────────────────────────────────────────────────────────

/**
 * The only objects left out, each counted in the category's `excluded`.
 * Anything else, user-created or not, is kept.
 */
export const EXCLUSION_RULES = {
  foreignKeyTriggers:
    "internal triggers that run pg_catalog.RI_FKey_* (PostgreSQL's foreign-key enforcement; their names contain OIDs, and the foreign keys themselves are compared under constraints)",
  extensionFunctions:
    "functions that belong to an extension (compared through the extension and its version under extensions)",
  extensionTypes:
    "types that belong to an extension (compared through the extension and its version under extensions)",
} as const;

// ─── Mapping catalog rows ────────────────────────────────────────────────────

/** A catalog result the collector cannot trust: the collection fails. */
export class CollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionError";
  }
}

type Row = Record<string, unknown>;

/** Reads one row's fields, failing on anything unexpected. */
function fields(category: CategoryName, row: unknown) {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new CollectionError(`${category}: a row is not an object`);
  const r = row as Row;
  const bad = (key: string, what: string): never => {
    throw new CollectionError(`${category}: ${key} is not ${what}`);
  };
  const text = (key: string) =>
    typeof r[key] === "string"
      ? normalizeText(r[key] as string)
      : bad(key, "text");
  const optionalText = (key: string) => (r[key] === null ? null : text(key));
  const flag = (key: string) =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : bad(key, "a boolean");
  const count = (key: string) =>
    Number.isInteger(r[key]) ? (r[key] as number) : bad(key, "an integer");
  const list = (key: string) =>
    Array.isArray(r[key]) &&
    (r[key] as unknown[]).every((v) => typeof v === "string")
      ? (r[key] as string[]).map(normalizeText)
      : bad(key, "a list of text");
  const code = <M extends Record<string, string>>(key: string, map: M) => {
    const v = r[key];
    return typeof v === "string" && Object.hasOwn(map, v)
      ? (map[v] as M[keyof M])
      : bad(key, `one of ${Object.keys(map).join(", ")}`);
  };
  return { text, optionalText, flag, count, list, code };
}

/** CRLF to LF: nothing else in a definition is rewritten. */
export function normalizeText(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** A name as PostgreSQL would print it: quoted unless plain lower case. */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

const qualified = (...parts: string[]) => parts.map(ident).join(".");

const CONSTRAINT_TYPES = {
  c: "check",
  f: "foreign key",
  p: "primary key",
  u: "unique",
  x: "exclusion",
  t: "constraint trigger",
  n: "not null",
} as const;
const TRIGGER_STATES = {
  O: "enabled",
  D: "disabled",
  R: "replica only",
  A: "always",
} as const;
const FUNCTION_KINDS = {
  f: "function",
  p: "procedure",
  a: "aggregate",
  w: "window",
} as const;
const VOLATILITY = { i: "immutable", s: "stable", v: "volatile" } as const;
const RELATION_KINDS = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialized view",
  S: "sequence",
  f: "foreign table",
} as const;
const TYPE_KINDS = {
  e: "enum",
  d: "domain",
  c: "composite",
  r: "range",
  m: "multirange",
} as const;
const POLICY_MODES = {
  PERMISSIVE: "PERMISSIVE",
  RESTRICTIVE: "RESTRICTIVE",
} as const;

type Mapped<T> = { item: T } | { excluded: keyof typeof EXCLUSION_RULES };

const MAPPERS: {
  [C in CategoryName]: (
    row: unknown,
  ) => Mapped<Extract<Categories[C], { collected: true }>["items"][number]>;
} = {
  constraints(row) {
    const f = fields("constraints", row);
    const [schema, table, name] = [
      f.text("schema"),
      f.text("table"),
      f.text("name"),
    ];
    return {
      item: {
        id: qualified(schema, table, name),
        schema,
        table,
        name,
        type: f.code("type", CONSTRAINT_TYPES),
        definition: f.text("definition"),
        validated: f.flag("validated"),
        deferrable: f.flag("deferrable"),
        deferred: f.flag("deferred"),
        noInherit: f.flag("noInherit"),
      },
    };
  },
  indexes(row) {
    const f = fields("indexes", row);
    const [schema, table, name] = [
      f.text("schema"),
      f.text("table"),
      f.text("name"),
    ];
    const columns = f.list("columns");
    const keyCount = f.count("keyCount");
    if (keyCount > columns.length)
      throw new CollectionError("indexes: keyCount exceeds the columns read");
    return {
      item: {
        id: qualified(schema, table, name),
        schema,
        table,
        name,
        definition: f.text("definition"),
        unique: f.flag("unique"),
        primary: f.flag("primary"),
        method: f.text("method"),
        keyColumns: columns.slice(0, keyCount),
        includeColumns: columns.slice(keyCount),
        hasExpressions: f.flag("hasExpressions"),
        predicate: f.optionalText("predicate"),
        nullsNotDistinct: f.flag("nullsNotDistinct"),
        valid: f.flag("valid"),
        ready: f.flag("ready"),
      },
    };
  },
  triggers(row) {
    const f = fields("triggers", row);
    const [schema, table, name] = [
      f.text("schema"),
      f.text("table"),
      f.text("name"),
    ];
    const fnSchema = f.text("functionSchema");
    const fnName = f.text("functionName");
    if (
      f.flag("internal") &&
      fnSchema === "pg_catalog" &&
      /^RI_FKey_/.test(fnName)
    )
      return { excluded: "foreignKeyTriggers" };
    return {
      item: {
        id: qualified(schema, table, name),
        schema,
        table,
        name,
        definition: f.text("definition"),
        enabled: f.code("enabled", TRIGGER_STATES),
        function: `${qualified(fnSchema, fnName)}(${f.text("functionArguments")})`,
        constraintTrigger: f.flag("constraintTrigger"),
      },
    };
  },
  functions(row) {
    const f = fields("functions", row);
    if (f.optionalText("extension") !== null)
      return { excluded: "extensionFunctions" };
    const [schema, name] = [f.text("schema"), f.text("name")];
    const identityArguments = f.text("identityArguments");
    const kind = f.code("kind", FUNCTION_KINDS);
    const definition = f.optionalText("definition");
    if (definition === null && kind !== "aggregate")
      throw new CollectionError(`functions: no definition for ${name}`);
    return {
      item: {
        id: `${qualified(schema, name)}(${identityArguments})`,
        schema,
        name,
        identityArguments,
        returns: f.text("returns"),
        kind,
        language: f.text("language"),
        securityDefiner: f.flag("securityDefiner"),
        volatility: f.code("volatility", VOLATILITY),
        strict: f.flag("strict"),
        leakproof: f.flag("leakproof"),
        config: [...f.list("config")].sort(),
        definition,
      },
    };
  },
  rowSecurity(row) {
    const f = fields("rowSecurity", row);
    const [schema, table] = [f.text("schema"), f.text("table")];
    return {
      item: {
        id: qualified(schema, table),
        schema,
        table,
        enabled: f.flag("enabled"),
        forced: f.flag("forced"),
      },
    };
  },
  policies(row) {
    const f = fields("policies", row);
    const [schema, table, name] = [
      f.text("schema"),
      f.text("table"),
      f.text("name"),
    ];
    return {
      item: {
        id: qualified(schema, table, name),
        schema,
        table,
        name,
        command: f.text("command"),
        mode: f.code("mode", POLICY_MODES),
        roles: [...f.list("roles")].sort(),
        using: f.optionalText("using"),
        withCheck: f.optionalText("withCheck"),
      },
    };
  },
  relations(row) {
    const f = fields("relations", row);
    const [schema, name] = [f.text("schema"), f.text("name")];
    return {
      item: {
        id: qualified(schema, name),
        schema,
        name,
        kind: f.code("kind", RELATION_KINDS),
        definition: f.optionalText("definition"),
      },
    };
  },
  types(row) {
    const f = fields("types", row);
    if (f.optionalText("extension") !== null)
      return { excluded: "extensionTypes" };
    const [schema, name] = [f.text("schema"), f.text("name")];
    return {
      item: {
        id: qualified(schema, name),
        schema,
        name,
        kind: f.code("kind", TYPE_KINDS),
        definition: f.optionalText("definition"),
      },
    };
  },
  extensions(row) {
    const f = fields("extensions", row);
    const name = f.text("name");
    return {
      item: {
        id: ident(name),
        name,
        schema: f.text("schema"),
        version: f.text("version"),
      },
    };
  },
  schemas(row) {
    const name = fields("schemas", row).text("name");
    return { item: { id: ident(name), name } };
  },
};

/**
 * One category from its catalog rows: mapped, excluded by rule, sorted by
 * id. Anything but a list of well-formed rows fails the collection.
 */
export function buildCategory<C extends CategoryName>(
  category: C,
  rows: unknown,
): Categories[C] {
  if (!Array.isArray(rows))
    throw new CollectionError(
      `${category}: the catalog query returned no rows list`,
    );
  const items: DefinitionItem[] = [];
  const excluded = new Map<keyof typeof EXCLUSION_RULES, number>();
  for (const row of rows) {
    const mapped = MAPPERS[category](row);
    if ("excluded" in mapped)
      excluded.set(mapped.excluded, (excluded.get(mapped.excluded) ?? 0) + 1);
    else items.push(mapped.item);
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < items.length; i++)
    if (items[i].id === items[i - 1].id)
      throw new CollectionError(
        `${category}: two objects share the id ${items[i].id}`,
      );
  return {
    collected: true,
    items,
    excluded: [...excluded]
      .map(([rule, count]) => ({ rule: EXCLUSION_RULES[rule], count }))
      .sort((a, b) => (a.rule < b.rule ? -1 : 1)),
  } as Categories[C];
}

/** Every category from raw catalog rows (as collectDefinitions reads them). */
export function buildCategories(
  raw: Record<CategoryName, unknown>,
): Categories {
  const out = {} as Record<CategoryName, unknown>;
  for (const c of CATEGORIES) out[c] = buildCategory(c, raw[c]);
  return out as Categories;
}

/**
 * Reads every category in the caller's read-only transaction, with the
 * search path pinned first. Any failed query or unexpected row throws:
 * there is no partial fingerprint.
 */
export async function collectDefinitions(tx: ReadOnlyTx): Promise<Categories> {
  await tx.$executeRawUnsafe(DEFINITION_QUERIES.searchPath);
  const [path] = await tx.$queryRawUnsafe<Array<{ searchPath: string }>>(
    DEFINITION_QUERIES.confirmSearchPath,
  );
  if (path?.searchPath !== SEARCH_PATH)
    throw new CollectionError(
      `the server did not confirm search_path ${SEARCH_PATH}`,
    );
  const raw = {} as Record<CategoryName, unknown>;
  for (const c of CATEGORIES)
    raw[c] = await tx.$queryRawUnsafe<unknown[]>(DEFINITION_QUERIES[c]);
  return buildCategories(raw);
}

// ─── Serialising and reading ─────────────────────────────────────────────────

/** JSON with object keys sorted at every level; arrays keep their order. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Row)
              .sort()
              .map((k) => [k, sort((v as Row)[k])]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2);
}

export function serializeFingerprint(fp: Fingerprint): string {
  return `${stableJson(fp)}\n`;
}

/**
 * A fingerprint from its JSON, or why not. A category that is absent or
 * malformed is read as not collected, never as empty.
 */
export function parseFingerprint(
  text: string,
): { fingerprint: Fingerprint } | { error: string } {
  if (/postgres(ql)?:\/\//i.test(text))
    return { error: "the file contains a database URL" };
  let data: Row;
  try {
    data = JSON.parse(text) as Row;
  } catch {
    return { error: "the file is not JSON" };
  }
  if (!data || typeof data !== "object" || data.format !== FINGERPRINT_FORMAT)
    return { error: "the file is not a definitions fingerprint" };
  if (data.version !== FINGERPRINT_VERSION)
    return {
      error: `unsupported fingerprint version ${JSON.stringify(data.version)} (this tool reads version ${FINGERPRINT_VERSION})`,
    };
  const server = data.server as Row | undefined;
  if (!server || typeof server.database !== "string")
    return { error: "the fingerprint has no server identity" };
  const given = (data.categories ?? {}) as Row;
  const categories = {} as Record<CategoryName, Category<DefinitionItem>>;
  for (const c of CATEGORIES) {
    const v = given[c] as Row | undefined;
    if (!v)
      categories[c] = { collected: false, reason: "absent from the file" };
    else if (v.collected === false)
      categories[c] = {
        collected: false,
        reason: typeof v.reason === "string" ? v.reason : "not collected",
      };
    else if (
      v.collected === true &&
      Array.isArray(v.items) &&
      v.items.every((i: unknown) => !!i && typeof (i as Row).id === "string") &&
      Array.isArray(v.excluded)
    )
      categories[c] = v as Category<DefinitionItem>;
    else categories[c] = { collected: false, reason: "malformed in the file" };
  }
  return {
    fingerprint: {
      ...(data as Fingerprint),
      categories: categories as Categories,
    },
  };
}
