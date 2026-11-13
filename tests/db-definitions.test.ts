import * as nodeFs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chooseDatabase } from "../scripts/crawl-worker/database";
import { SESSION_DEFAULT_QUERY } from "../scripts/db-drift/run";
import {
  compareFingerprints,
  formatComparison,
  inventory,
  prismaNames,
  runCompare,
  type Comparison,
} from "../scripts/db-readiness/compare-definitions";
import {
  buildCategories,
  buildCategory,
  CATEGORIES,
  CollectionError,
  DEFINITION_QUERIES,
  EXCLUSION_RULES,
  FINGERPRINT_FORMAT,
  ident,
  parseFingerprint,
  serializeFingerprint,
  type CategoryName,
  type Fingerprint,
} from "../scripts/db-readiness/definitions";
import {
  parseDefinitionsArgs,
  runDefinitions,
  unsavableProblem,
  type DefinitionsDeps,
} from "../scripts/db-readiness/definitions-run";
import {
  outputPathProblem,
  writeNewFile,
  type OutputFs,
} from "../scripts/db-readiness/secure-output";
import { QUERIES } from "../scripts/db-readiness/report";
import type { ReadinessDb } from "../scripts/db-readiness/run";

// Nothing in these tests may build a database driver: if anything did, it
// would fail here rather than connect.
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: vi.fn(() => {
    throw new Error("tests must not build a database adapter");
  }),
}));

const ROOT = path.resolve(import.meta.dirname, "..");
const PRISMA = prismaNames(
  readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8"),
);

// ─── Catalog fixtures (rows as the catalog queries return them) ─────────────

type Row = Record<string, unknown>;
type Raw = Record<CategoryName, Row[]>;

const con = (
  table: string,
  name: string,
  type: string,
  definition: string,
) => ({
  schema: "public",
  table,
  name,
  type,
  definition,
  validated: true,
  deferrable: false,
  deferred: false,
  noInherit: false,
});

function idx(
  table: string,
  name: string,
  o: {
    columns: string[];
    include?: string[];
    unique?: boolean;
    primary?: boolean;
    predicate?: string;
    expressions?: boolean;
  },
) {
  const include = o.include ?? [];
  return {
    schema: "public",
    table,
    name,
    definition: `CREATE ${o.unique ? "UNIQUE " : ""}INDEX ${ident(name)} ON public.${table} USING btree (${o.columns.join(", ")})${include.length ? ` INCLUDE (${include.join(", ")})` : ""}${o.predicate ? ` WHERE ${o.predicate}` : ""}`,
    unique: !!o.unique,
    primary: !!o.primary,
    method: "btree",
    keyCount: o.columns.length,
    columns: [...o.columns, ...include],
    hasExpressions: !!o.expressions,
    predicate: o.predicate ?? null,
    nullsNotDistinct: false,
    valid: true,
    ready: true,
  };
}

const APPEND_ONLY_TRIGGER =
  "CREATE TRIGGER recommendation_events_append_only BEFORE DELETE OR UPDATE ON public.recommendation_events FOR EACH ROW EXECUTE FUNCTION public.recommendation_events_append_only()";
const APPEND_ONLY_BODY = `CREATE OR REPLACE FUNCTION public.recommendation_events_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'recommendation_events is append-only';
END;
$function$
`;
const TENANCY_BODY = `CREATE OR REPLACE FUNCTION public.recommendation_evidence_tenancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RETURN NEW;
END;
$function$
`;
const PENDING = `(status = 'PENDING'::public."BusinessFactStatus")`;
const TENANT_USING = `("organizationId" = current_setting('app.organization_id'::text))`;

const fn = (name: string, o: Partial<Row> = {}) => ({
  schema: "public",
  name,
  identityArguments: "",
  returns: "trigger",
  kind: "f",
  language: "plpgsql",
  securityDefiner: false,
  volatility: "v",
  strict: false,
  leakproof: false,
  config: [],
  extension: null,
  definition: APPEND_ONLY_BODY,
  ...o,
});

function base(): Raw {
  return {
    constraints: [
      con("business_facts", "business_facts_pkey", "p", "PRIMARY KEY (id)"),
      con(
        "business_facts",
        "business_facts_value_check",
        "c",
        "CHECK (((length(btrim(value)) >= 1) AND (length(btrim(value)) <= 160)))",
      ),
      con(
        "business_facts",
        "business_facts_review_check",
        "c",
        `CHECK ((${PENDING} = ("reviewedAt" IS NULL)))`,
      ),
      con(
        "business_facts",
        "business_facts_organizationId_fkey",
        "f",
        `FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE`,
      ),
    ],
    indexes: [
      idx("business_facts", "business_facts_pkey", {
        columns: ["id"],
        unique: true,
        primary: true,
      }),
      idx(
        "business_facts",
        "business_facts_websiteId_kind_normalizedValue_key",
        {
          columns: ['"websiteId"', "kind", '"normalizedValue"'],
          unique: true,
        },
      ),
      idx("business_facts", "business_facts_organizationId_idx", {
        columns: ['"organizationId"'],
      }),
      idx("business_facts", "business_facts_pending_idx", {
        columns: ['"websiteId"'],
        predicate: PENDING,
      }),
    ],
    triggers: [
      {
        schema: "public",
        table: "recommendation_events",
        name: "recommendation_events_append_only",
        definition: APPEND_ONLY_TRIGGER,
        enabled: "O",
        internal: false,
        constraintTrigger: false,
        functionSchema: "public",
        functionName: "recommendation_events_append_only",
        functionArguments: "",
      },
      {
        schema: "public",
        table: "business_facts",
        name: "RI_ConstraintTrigger_c_16501",
        definition:
          'CREATE CONSTRAINT TRIGGER "RI_ConstraintTrigger_c_16501" AFTER INSERT ON public.business_facts FROM public.organizations NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "RI_FKey_check_ins"()',
        enabled: "O",
        internal: true,
        constraintTrigger: true,
        functionSchema: "pg_catalog",
        functionName: "RI_FKey_check_ins",
        functionArguments: "",
      },
    ],
    functions: [
      fn("recommendation_events_append_only"),
      fn("recommendation_evidence_tenancy", {
        config: ["search_path=pg_catalog, public"],
        definition: TENANCY_BODY,
      }),
      fn("gen_random_uuid", {
        returns: "uuid",
        language: "c",
        extension: "pgcrypto",
        definition: null,
      }),
    ],
    rowSecurity: [
      {
        schema: "public",
        table: "business_facts",
        enabled: true,
        forced: false,
      },
      {
        schema: "public",
        table: "recommendation_events",
        enabled: true,
        forced: false,
      },
      { schema: "public", table: "websites", enabled: false, forced: false },
    ],
    policies: [
      {
        schema: "public",
        table: "business_facts",
        name: "business_facts_tenant",
        mode: "PERMISSIVE",
        roles: ["app_user"],
        command: "ALL",
        using: TENANT_USING,
        withCheck: null,
      },
    ],
    relations: [
      { schema: "public", name: "business_facts", kind: "r", definition: null },
      {
        schema: "public",
        name: "recommendation_events",
        kind: "r",
        definition: null,
      },
      { schema: "public", name: "websites", kind: "r", definition: null },
      {
        schema: "public",
        name: "_prisma_migrations",
        kind: "r",
        definition: null,
      },
    ],
    types: [
      {
        schema: "public",
        name: "BusinessFactStatus",
        kind: "e",
        extension: null,
        definition: "'PENDING', 'APPROVED', 'REJECTED'",
      },
    ],
    extensions: [
      { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
      { name: "pgcrypto", schema: "public", version: "1.3" },
    ],
    schemas: [{ name: "public" }],
  };
}

const ITEST_SERVER = {
  endpoint: "ep-long-surf-b4hm6pyi",
  branch: "br-noisy-glade-b4rjvu65",
  database: "upsitehealth_test",
  role: "upsitehealth_tester",
  serverVersion: "18.6 (4e5fd08)",
};
const SHARED_SERVER = {
  endpoint: "ep-dark-rain-b4ve04n3",
  branch: "br-noisy-dust-b4i1uvhg",
  database: "upsitehealth_test",
  role: "upsitehealth_test",
  serverVersion: "18.6 (4e5fd08)",
};

function fingerprint(raw: Raw, server = ITEST_SERVER): Fingerprint {
  return {
    format: FINGERPRINT_FORMAT,
    version: 1,
    generatedAt: "2026-10-30T12:00:00.000Z",
    target: { name: "test", label: "x" },
    server,
    transaction: {
      readOnly: true,
      sessionDefaultReadOnly: true,
      isolation: "repeatable read",
      endedBy: "rollback",
    },
    scope: { schema: "public", searchPath: "pg_catalog", normalization: [] },
    categories: buildCategories(raw),
  };
}

/** Compares base() with base() changed by `change`. */
function compareWith(change: (raw: Raw) => void): Comparison {
  const candidate = base();
  change(candidate);
  return compareFingerprints(
    fingerprint(base()),
    fingerprint(candidate, SHARED_SERVER),
    PRISMA,
  );
}

const nonMatches = (c: Comparison) =>
  c.categories.flatMap((cat) =>
    cat.compared
      ? cat.objects
          .filter((o) => o.status !== "MATCH")
          .map((o) => `${o.status} ${o.description}`)
      : [],
  );

const find = (raw: Raw, category: CategoryName, name: string) => {
  const row = raw[category].find((r) => (r.name ?? r.table) === name);
  if (!row) throw new Error(`fixture has no ${category} ${name}`);
  return row;
};
const drop = (raw: Raw, category: CategoryName, name: string) => {
  raw[category] = raw[category].filter((r) => (r.name ?? r.table) !== name);
};

// ─── Collection mapping ─────────────────────────────────────────────────────

describe("collection mapping", () => {
  const cats = buildCategories(base());
  const items = <C extends CategoryName>(c: C) => {
    const cat = cats[c];
    if (!cat.collected) throw new Error("not collected");
    return cat.items as Array<Record<string, unknown>>;
  };

  test("CHECK definitions are kept as the catalog prints them", () => {
    expect(
      items("constraints").find(
        (i) => i.name === "business_facts_review_check",
      ),
    ).toEqual({
      id: "public.business_facts.business_facts_review_check",
      schema: "public",
      table: "business_facts",
      name: "business_facts_review_check",
      type: "check",
      definition: `CHECK ((${PENDING} = ("reviewedAt" IS NULL)))`,
      validated: true,
      deferrable: false,
      deferred: false,
      noInherit: false,
    });
  });

  test("a NOT VALID check keeps its validation state", () => {
    const raw = base();
    Object.assign(find(raw, "constraints", "business_facts_value_check"), {
      validated: false,
    });
    const cat = buildCategory("constraints", raw.constraints);
    expect(
      cat.collected &&
        cat.items.find((i) => i.name === "business_facts_value_check")
          ?.validated,
    ).toBe(false);
  });

  test("trigger definitions, enabled states and functions are kept", () => {
    expect(items("triggers")).toEqual([
      {
        id: "public.recommendation_events.recommendation_events_append_only",
        schema: "public",
        table: "recommendation_events",
        name: "recommendation_events_append_only",
        definition: APPEND_ONLY_TRIGGER,
        enabled: "enabled",
        function: "public.recommendation_events_append_only()",
        constraintTrigger: false,
      },
    ]);
    for (const [code, state] of [
      ["D", "disabled"],
      ["R", "replica only"],
      ["A", "always"],
    ]) {
      const raw = base();
      find(raw, "triggers", "recommendation_events_append_only").enabled = code;
      const cat = buildCategory("triggers", raw.triggers);
      expect(cat.collected && cat.items[0].enabled).toBe(state);
    }
  });

  test("internal foreign-key triggers are excluded by the documented rule, and counted", () => {
    const cat = cats.triggers;
    expect(cat.collected && cat.excluded).toEqual([
      { rule: EXCLUSION_RULES.foreignKeyTriggers, count: 1 },
    ]);
  });

  test("an internal trigger that is not foreign-key enforcement is kept", () => {
    const raw = base();
    raw.triggers.push({
      ...find(raw, "triggers", "RI_ConstraintTrigger_c_16501"),
      name: "unique_recheck_17000",
      functionName: "unique_key_recheck",
    });
    raw.triggers.push({
      ...find(raw, "triggers", "RI_ConstraintTrigger_c_16501"),
      name: "user_made_ri_lookalike",
      internal: false,
    });
    const cat = buildCategory("triggers", raw.triggers);
    expect(cat.collected && cat.items.map((i) => i.name)).toEqual([
      "unique_recheck_17000",
      "user_made_ri_lookalike",
      "recommendation_events_append_only",
    ]);
  });

  test("overloaded functions stay distinguishable", () => {
    const raw = base();
    raw.functions.push(
      fn("normalize_value", {
        identityArguments: "value text",
        returns: "text",
      }),
      fn("normalize_value", {
        identityArguments: "value text, max_length integer",
        returns: "text",
      }),
    );
    const cat = buildCategory("functions", raw.functions);
    expect(cat.collected && cat.items.map((i) => i.id)).toEqual([
      "public.normalize_value(value text)",
      "public.normalize_value(value text, max_length integer)",
      "public.recommendation_events_append_only()",
      "public.recommendation_evidence_tenancy()",
    ]);
  });

  test("function security, volatility and settings are kept; extension functions are counted, not read", () => {
    const raw = base();
    Object.assign(find(raw, "functions", "recommendation_evidence_tenancy"), {
      securityDefiner: true,
      volatility: "s",
      leakproof: true,
      strict: true,
      config: ["statement_timeout=5s", "search_path=pg_catalog, public"],
    });
    const cat = buildCategory("functions", raw.functions);
    if (!cat.collected) throw new Error("not collected");
    expect(
      cat.items.find((i) => i.name === "recommendation_evidence_tenancy"),
    ).toMatchObject({
      securityDefiner: true,
      volatility: "stable",
      leakproof: true,
      strict: true,
      language: "plpgsql",
      config: ["search_path=pg_catalog, public", "statement_timeout=5s"],
      definition: TENANCY_BODY,
    });
    expect(cat.items.some((i) => i.name === "gen_random_uuid")).toBe(false);
    expect(cat.excluded).toEqual([
      { rule: EXCLUSION_RULES.extensionFunctions, count: 1 },
    ]);
  });

  test("RLS enabled and forced are separate flags", () => {
    const raw = base();
    Object.assign(find(raw, "rowSecurity", "websites"), {
      enabled: false,
      forced: true,
    });
    const cat = buildCategory("rowSecurity", raw.rowSecurity);
    expect(cat.collected && cat.items).toEqual([
      {
        id: "public.business_facts",
        schema: "public",
        table: "business_facts",
        enabled: true,
        forced: false,
      },
      {
        id: "public.recommendation_events",
        schema: "public",
        table: "recommendation_events",
        enabled: true,
        forced: false,
      },
      {
        id: "public.websites",
        schema: "public",
        table: "websites",
        enabled: false,
        forced: true,
      },
    ]);
  });

  test("policy roles and expressions are kept", () => {
    expect(items("policies")).toEqual([
      {
        id: "public.business_facts.business_facts_tenant",
        schema: "public",
        table: "business_facts",
        name: "business_facts_tenant",
        command: "ALL",
        mode: "PERMISSIVE",
        roles: ["app_user"],
        using: TENANT_USING,
        withCheck: null,
      },
    ]);
  });

  test("partial predicates, uniqueness and key/include columns are kept", () => {
    const raw = base();
    raw.indexes.push(
      idx("business_facts", "business_facts_lower_value_idx", {
        columns: ["lower(value)"],
        include: ['"websiteId"'],
        expressions: true,
      }),
    );
    const cat = buildCategory("indexes", raw.indexes);
    if (!cat.collected) throw new Error("not collected");
    const byName = (n: string) => cat.items.find((i) => i.name === n);
    expect(byName("business_facts_pending_idx")).toMatchObject({
      predicate: PENDING,
      unique: false,
      definition: `CREATE INDEX business_facts_pending_idx ON public.business_facts USING btree ("websiteId") WHERE ${PENDING}`,
    });
    expect(
      byName("business_facts_websiteId_kind_normalizedValue_key"),
    ).toMatchObject({
      unique: true,
      primary: false,
      predicate: null,
      keyColumns: ['"websiteId"', "kind", '"normalizedValue"'],
      includeColumns: [],
    });
    expect(byName("business_facts_lower_value_idx")).toMatchObject({
      hasExpressions: true,
      keyColumns: ["lower(value)"],
      includeColumns: ['"websiteId"'],
    });
  });

  test("unmodelled objects appear in the inventory with the migration that creates them", () => {
    expect(inventory(fingerprint(base()), PRISMA)).toEqual([
      {
        category: "constraints",
        id: "public.business_facts.business_facts_review_check",
        what: "check constraint",
        origin: "migration 1_business_facts",
      },
      {
        category: "constraints",
        id: "public.business_facts.business_facts_value_check",
        what: "check constraint",
        origin: "migration 1_business_facts",
      },
      {
        category: "indexes",
        id: "public.business_facts.business_facts_pending_idx",
        what: "partial index",
        origin: null,
      },
      {
        category: "triggers",
        id: "public.recommendation_events.recommendation_events_append_only",
        what: "trigger (enabled)",
        origin: "migration 2_recommendation_events",
      },
      {
        category: "functions",
        id: "public.recommendation_events_append_only()",
        what: "function",
        origin: "migration 2_recommendation_events",
      },
      {
        category: "functions",
        id: "public.recommendation_evidence_tenancy()",
        what: "function",
        origin: "migration 4_recommendation_identity",
      },
      {
        category: "rowSecurity",
        id: "public.business_facts",
        what: "row-level security enabled",
        origin: "migration 1_business_facts",
      },
      {
        category: "rowSecurity",
        id: "public.recommendation_events",
        what: "row-level security enabled",
        origin: "migration 2_recommendation_events",
      },
      {
        category: "policies",
        id: "public.business_facts.business_facts_tenant",
        what: "row-level security policy",
        origin: null,
      },
      {
        category: "relations",
        id: "public._prisma_migrations",
        what: "table not in schema.prisma",
        origin: "Prisma Migrate history",
      },
      {
        category: "extensions",
        id: "pgcrypto",
        what: "extension",
        origin: null,
      },
    ]);
  });

  test("prisma names come from @@map and enum names", () => {
    expect(PRISMA.tables.has("business_facts")).toBe(true);
    expect(PRISMA.tables.has("BusinessFact")).toBe(false);
    expect(PRISMA.tables.has("_prisma_migrations")).toBe(false);
    expect(PRISMA.enums.has("BusinessFactStatus")).toBe(true);
  });
});

// ─── Fingerprint format ─────────────────────────────────────────────────────

describe("fingerprint", () => {
  test("is the same whatever order the catalog returns rows in", () => {
    const shuffled = base();
    for (const c of CATEGORIES) shuffled[c].reverse();
    shuffled.functions.push(shuffled.functions.shift() as Row);
    expect(serializeFingerprint(fingerprint(shuffled))).toBe(
      serializeFingerprint(fingerprint(base())),
    );
  });

  test("serialises deterministically: sorted keys, version and format first-class", () => {
    const text = serializeFingerprint(fingerprint(base()));
    const data = JSON.parse(text);
    expect(data.format).toBe("upsitehealth-db-definitions");
    expect(data.version).toBe(1);
    expect(Object.keys(data)).toEqual([...Object.keys(data)].sort());
    expect(Object.keys(data.categories.indexes.items[0])).toEqual(
      [...Object.keys(data.categories.indexes.items[0])].sort(),
    );
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = parseFingerprint(text);
    expect(
      "fingerprint" in parsed && serializeFingerprint(parsed.fingerprint),
    ).toBe(text);
  });

  test("only line endings are normalised: whitespace inside SQL is a difference", () => {
    const crlf = compareWith((raw) => {
      find(raw, "functions", "recommendation_events_append_only").definition =
        APPEND_ONLY_BODY.replace(/\n/g, "\r\n");
    });
    expect(crlf.result).toBe("identical");

    const spaced = compareWith((raw) => {
      find(raw, "functions", "recommendation_events_append_only").definition =
        APPEND_ONLY_BODY.replace("append-only'", "append-only '");
    });
    expect(spaced.result).toBe("different");
    expect(nonMatches(spaced)).toHaveLength(1);
  });

  test("index columns and enum labels keep their order", () => {
    const c = compareWith((raw) => {
      find(
        raw,
        "indexes",
        "business_facts_websiteId_kind_normalizedValue_key",
      ).columns = ["kind", '"websiteId"', '"normalizedValue"'];
      find(raw, "types", "BusinessFactStatus").definition =
        "'APPROVED', 'PENDING', 'REJECTED'";
    });
    expect(nonMatches(c).map((d) => d.split(":")[0])).toEqual([
      'DIFFERENT index public.business_facts."business_facts_websiteId_kind_normalizedValue_key"',
      'DIFFERENT enum type public."BusinessFactStatus"',
    ]);
  });

  test.each([
    [
      "no rows list",
      undefined,
      /constraints: the catalog query returned no rows list/,
    ],
    [
      "a row that is not an object",
      [null],
      /constraints: a row is not an object/,
    ],
    [
      "a missing definition",
      [{ ...con("t", "x", "c", ""), definition: undefined }],
      /constraints: definition is not text/,
    ],
    [
      "an unknown constraint type",
      [con("t", "x", "?", "CHECK (true)")],
      /constraints: type is not one of/,
    ],
    [
      "two objects with one id",
      [con("t", "x", "c", "CHECK (a)"), con("t", "x", "c", "CHECK (b)")],
      /two objects share the id public\.t\.x/,
    ],
  ])(
    "a collection with %s fails instead of becoming empty",
    (_n, rows, message) => {
      expect(() => buildCategory("constraints", rows)).toThrow(CollectionError);
      expect(() => buildCategory("constraints", rows)).toThrow(message);
    },
  );

  test("a function without a definition fails (only aggregates have none)", () => {
    expect(() =>
      buildCategory("functions", [fn("f", { definition: null })]),
    ).toThrow(/functions: no definition for f/);
    const agg = buildCategory("functions", [
      fn("total", { kind: "a", definition: null }),
    ]);
    expect(agg.collected && agg.items[0].definition).toBeNull();
  });
});

// ─── Comparison ─────────────────────────────────────────────────────────────

describe("comparison", () => {
  const show = JSON.stringify;

  test("1. identical fingerprints", () => {
    const c = compareWith(() => {});
    expect(c.result).toBe("identical");
    expect(nonMatches(c)).toEqual([]);
    expect(c.warnings).toEqual([]);
    for (const cat of c.categories)
      expect(cat.compared && cat.counts.MATCH).toBe(
        cat.compared && cat.objects.length,
      );
  });

  test("2. missing CHECK constraint", () => {
    const c = compareWith((raw) =>
      drop(raw, "constraints", "business_facts_value_check"),
    );
    expect(c.result).toBe("different");
    expect(nonMatches(c)).toEqual([
      "MISSING check constraint public.business_facts.business_facts_value_check: in the reference, missing from the candidate",
    ]);
  });

  test("3. extra CHECK constraint", () => {
    const c = compareWith((raw) =>
      raw.constraints.push(
        con(
          "business_facts",
          "business_facts_note_check",
          "c",
          "CHECK ((length(value) < 80))",
        ),
      ),
    );
    expect(nonMatches(c)).toEqual([
      "EXTRA check constraint public.business_facts.business_facts_note_check: in the candidate only",
    ]);
  });

  test("4. changed trigger definition", () => {
    const changed = APPEND_ONLY_TRIGGER.replace("DELETE OR UPDATE", "UPDATE");
    const c = compareWith((raw) => {
      find(raw, "triggers", "recommendation_events_append_only").definition =
        changed;
    });
    expect(nonMatches(c)).toEqual([
      `DIFFERENT trigger public.recommendation_events.recommendation_events_append_only: definition ${show(APPEND_ONLY_TRIGGER)} → ${show(changed)}`,
    ]);
  });

  test("5. changed trigger enabled state", () => {
    const c = compareWith((raw) => {
      find(raw, "triggers", "recommendation_events_append_only").enabled = "D";
    });
    expect(nonMatches(c)).toEqual([
      'DIFFERENT trigger public.recommendation_events.recommendation_events_append_only: enabled "enabled" → "disabled"',
    ]);
  });

  test("6. missing function", () => {
    const c = compareWith((raw) =>
      drop(raw, "functions", "recommendation_evidence_tenancy"),
    );
    expect(nonMatches(c)).toEqual([
      "MISSING function public.recommendation_evidence_tenancy(): in the reference, missing from the candidate",
    ]);
  });

  test("7. changed function body", () => {
    const changed = APPEND_ONLY_BODY.replace(
      "RAISE EXCEPTION",
      "RAISE WARNING",
    );
    const c = compareWith((raw) => {
      find(raw, "functions", "recommendation_events_append_only").definition =
        changed;
    });
    expect(nonMatches(c)).toEqual([
      `DIFFERENT function public.recommendation_events_append_only(): definition ${show(APPEND_ONLY_BODY)} → ${show(changed)}`,
    ]);
  });

  test("8. changed security-definer state", () => {
    const changed = APPEND_ONLY_BODY.replace(
      " LANGUAGE plpgsql\n",
      " LANGUAGE plpgsql\n SECURITY DEFINER\n",
    );
    const c = compareWith((raw) =>
      Object.assign(
        find(raw, "functions", "recommendation_events_append_only"),
        {
          securityDefiner: true,
          definition: changed,
        },
      ),
    );
    expect(nonMatches(c)).toEqual([
      `DIFFERENT function public.recommendation_events_append_only(): definition ${show(APPEND_ONLY_BODY)} → ${show(changed)}; securityDefiner false → true`,
    ]);
  });

  test("9. RLS enabled versus disabled", () => {
    const c = compareWith((raw) => {
      find(raw, "rowSecurity", "business_facts").enabled = false;
    });
    expect(nonMatches(c)).toEqual([
      "DIFFERENT row security of public.business_facts: enabled true → false",
    ]);
  });

  test("10. RLS forced versus not forced", () => {
    const c = compareWith((raw) => {
      find(raw, "rowSecurity", "business_facts").forced = true;
    });
    expect(nonMatches(c)).toEqual([
      "DIFFERENT row security of public.business_facts: forced false → true",
    ]);
  });

  test("11. changed policy expression", () => {
    const changed = TENANT_USING.replace("app.organization_id", "app.org_id");
    const c = compareWith((raw) => {
      find(raw, "policies", "business_facts_tenant").using = changed;
    });
    expect(nonMatches(c)).toEqual([
      `DIFFERENT policy public.business_facts.business_facts_tenant: using ${show(TENANT_USING)} → ${show(changed)}`,
    ]);
  });

  test("12. changed policy roles", () => {
    const c = compareWith((raw) => {
      find(raw, "policies", "business_facts_tenant").roles = [
        "reporting",
        "app_user",
      ];
    });
    expect(nonMatches(c)).toEqual([
      'DIFFERENT policy public.business_facts.business_facts_tenant: roles ["app_user"] → ["app_user","reporting"]',
    ]);
  });

  test("13. missing partial index", () => {
    const c = compareWith((raw) =>
      drop(raw, "indexes", "business_facts_pending_idx"),
    );
    expect(nonMatches(c)).toEqual([
      "MISSING index public.business_facts.business_facts_pending_idx: in the reference, missing from the candidate",
    ]);
  });

  test("14. changed partial-index predicate", () => {
    const changed = PENDING.replace("PENDING", "APPROVED");
    const c = compareWith((raw) => {
      const r = find(raw, "indexes", "business_facts_pending_idx");
      r.predicate = changed;
      r.definition = String(r.definition).replace(PENDING, changed);
    });
    const ref = idx("business_facts", "business_facts_pending_idx", {
      columns: ['"websiteId"'],
      predicate: PENDING,
    }).definition;
    expect(nonMatches(c)).toEqual([
      `DIFFERENT index public.business_facts.business_facts_pending_idx: definition ${show(ref)} → ${show(ref.replace(PENDING, changed))}; predicate ${show(PENDING)} → ${show(changed)}`,
    ]);
  });

  test("15. changed index uniqueness", () => {
    const c = compareWith((raw) => {
      const r = find(
        raw,
        "indexes",
        "business_facts_websiteId_kind_normalizedValue_key",
      );
      r.unique = false;
      r.definition = String(r.definition).replace(
        "CREATE UNIQUE INDEX",
        "CREATE INDEX",
      );
    });
    const [line] = nonMatches(c);
    expect(line).toMatch(
      /^DIFFERENT index public\.business_facts\."business_facts_websiteId_kind_normalizedValue_key": definition "CREATE UNIQUE INDEX .*" → "CREATE INDEX .*"; unique true → false$/,
    );
    expect(nonMatches(c)).toHaveLength(1);
  });

  test("16. unexpected user-defined objects are extra and in the candidate's inventory", () => {
    const c = compareWith((raw) => {
      raw.functions.push(
        fn("debug_dump", { securityDefiner: true, returns: "void" }),
      );
      raw.relations.push({
        schema: "public",
        name: "open_tasks",
        kind: "v",
        definition: " SELECT id FROM public.recommendations",
      });
    });
    expect(nonMatches(c)).toEqual([
      "EXTRA function public.debug_dump(): in the candidate only",
      "EXTRA view public.open_tasks: in the candidate only",
    ]);
    expect(c.inventory.candidate).toEqual(
      expect.arrayContaining([
        {
          category: "functions",
          id: "public.debug_dump()",
          what: "function (security definer)",
          origin: null,
        },
        {
          category: "relations",
          id: "public.open_tasks",
          what: "view",
          origin: null,
        },
      ]),
    );
    expect(
      c.inventory.reference.some((e) => e.id === "public.debug_dump()"),
    ).toBe(false);
  });

  test("a renamed index is missing plus extra, with a note, not a match", () => {
    const c = compareWith((raw) => {
      const r = find(raw, "indexes", "business_facts_pending_idx");
      r.name = "business_facts_open_idx";
      r.definition = String(r.definition).replace(
        "business_facts_pending_idx",
        "business_facts_open_idx",
      );
    });
    const cat = c.categories.find((x) => x.category === "indexes");
    expect(cat?.compared && cat.counts).toEqual({
      MATCH: 3,
      MISSING: 1,
      EXTRA: 1,
      DIFFERENT: 0,
    });
    expect(
      cat?.compared && cat.objects.filter((o) => o.note).map((o) => o.note),
    ).toEqual([
      "same definition apart from the name as missing public.business_facts.business_facts_pending_idx (renamed?)",
      "same definition apart from the name as extra public.business_facts.business_facts_open_idx (renamed?)",
    ]);
  });

  test("17. an unsupported fingerprint version is refused", () => {
    const text = serializeFingerprint(fingerprint(base())).replace(
      '"version": 1',
      '"version": 2',
    );
    expect(parseFingerprint(text)).toEqual({
      error: "unsupported fingerprint version 2 (this tool reads version 1)",
    });
    expect(parseFingerprint('{"format":"something-else","version":1}')).toEqual(
      {
        error: "the file is not a definitions fingerprint",
      },
    );
    expect(parseFingerprint("not json")).toEqual({
      error: "the file is not JSON",
    });
  });

  test("18. an incomplete collection is never a match", () => {
    const candidate = fingerprint(base(), SHARED_SERVER);
    candidate.categories.policies = {
      collected: false,
      reason: "the query failed",
    };
    const c = compareFingerprints(fingerprint(base()), candidate, PRISMA);
    expect(c.result).toBe("incomplete");
    expect(c.categories.find((x) => x.category === "policies")).toEqual({
      category: "policies",
      compared: false,
      reason: "not collected (candidate: the query failed)",
    });
    expect(formatComparison(c)).toContain(
      "policies: NOT COMPARED, not collected (candidate: the query failed)",
    );

    // A category absent from, or malformed in, a file is read as not collected.
    const data = JSON.parse(serializeFingerprint(fingerprint(base())));
    delete data.categories.functions;
    data.categories.triggers.items = "oops";
    const parsed = parseFingerprint(JSON.stringify(data));
    if (!("fingerprint" in parsed)) throw new Error(parsed.error);
    expect(parsed.fingerprint.categories.functions).toEqual({
      collected: false,
      reason: "absent from the file",
    });
    expect(parsed.fingerprint.categories.triggers).toEqual({
      collected: false,
      reason: "malformed in the file",
    });
    expect(
      compareFingerprints(fingerprint(base()), parsed.fingerprint, PRISMA)
        .result,
    ).toBe("incomplete");
  });

  test("warns about different major versions, the same database, and different exclusion counts", () => {
    const candidate = base();
    candidate.triggers.push({
      ...find(candidate, "triggers", "RI_ConstraintTrigger_c_16501"),
      name: "RI_ConstraintTrigger_c_16502",
    });
    const c = compareFingerprints(
      fingerprint(base()),
      fingerprint(candidate, { ...ITEST_SERVER, serverVersion: "17.4" }),
      PRISMA,
    );
    expect(c.warnings).toEqual([
      "the servers run different PostgreSQL major versions (18.6 (4e5fd08) and 17.4); catalog output can differ between versions",
      "both fingerprints come from the same database",
      "triggers: 1 objects excluded by rule in the reference, 2 in the candidate",
    ]);
  });

  test("the text report lists every non-match and the inventory", () => {
    const text = formatComparison(
      compareWith((raw) =>
        drop(raw, "constraints", "business_facts_value_check"),
      ),
    );
    expect(text).toContain("Result: different");
    expect(text).toContain(
      "constraints: 3 match, 1 missing, 0 extra, 0 different",
    );
    expect(text).toContain(
      "  MISSING check constraint public.business_facts.business_facts_value_check: in the reference, missing from the candidate",
    );
    expect(text).toContain("Not modelled by Prisma (candidate):");
    expect(text).toContain(
      "  public.business_facts.business_facts_pending_idx: partial index; created by no known migration",
    );
  });
});

// ─── The offline comparison command ─────────────────────────────────────────

describe("runCompare", () => {
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  function run(argv: string[], files: Record<string, string>) {
    const out: string[] = [];
    const err: string[] = [];
    const readFile = vi.fn((f: string) => {
      if (!(f in files))
        throw Object.assign(new Error(`ENOENT ${f}`), { code: "ENOENT" });
      return files[f];
    });
    const code = runCompare(argv, {
      readFile,
      prismaSchema: () => schema,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });
    return { code, out, err, readFile };
  }
  const ref = serializeFingerprint(fingerprint(base()));
  const same = serializeFingerprint(fingerprint(base(), SHARED_SERVER));
  const changed = (() => {
    const raw = base();
    drop(raw, "constraints", "business_facts_value_check");
    return serializeFingerprint(fingerprint(raw, SHARED_SERVER));
  })();

  test("exit 0 identical, 2 different, 1 incomplete", () => {
    expect(
      run(["a.json", "b.json"], { "a.json": ref, "b.json": same }).code,
    ).toBe(0);
    expect(
      run(["a.json", "b.json"], { "a.json": ref, "b.json": changed }).code,
    ).toBe(2);
    const data = JSON.parse(same);
    data.categories.types = { collected: false, reason: "x" };
    expect(
      run(["a.json", "b.json"], {
        "a.json": ref,
        "b.json": JSON.stringify(data),
      }).code,
    ).toBe(1);
  });

  test("--json prints the comparison as stable JSON", () => {
    const r = run(["a.json", "b.json", "--json"], {
      "a.json": ref,
      "b.json": changed,
    });
    const c = JSON.parse(r.out[0]);
    expect(c.format).toBe("upsitehealth-db-definitions-comparison");
    expect(c.result).toBe("different");
  });

  test("usage errors and unreadable files compare nothing", () => {
    expect(run(["a.json"], {}).code).toBe(2);
    expect(run(["a.json", "b.json", "--target=app"], {}).code).toBe(2);
    const missing = run(["a.json", "b.json"], { "a.json": ref });
    expect(missing.code).toBe(1);
    expect(missing.err).toEqual([
      "Not compared: b.json cannot be read (ENOENT).",
    ]);
    expect(missing.out).toEqual([]);
  });

  test("a file carrying a database URL is refused", () => {
    const leaky = ref.replace(
      '"label": "x"',
      '"label": "postgresql://u:pw@h/db"',
    );
    const r = run(["a.json", "b.json"], { "a.json": leaky, "b.json": same });
    expect(r.code).toBe(1);
    expect(r.err.join("")).toBe(
      "Not compared: a.json: the file contains a database URL.",
    );
    expect(r.err.join("")).not.toContain("pw@");
  });
});

// ─── The collector (scripted server; nothing connects) ──────────────────────

const PASSWORD = "s3cr3t-Pa55";
const ITEST = `postgresql://upsitehealth_tester:${PASSWORD}@ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;
const SHARED = `postgresql://upsitehealth_test:${PASSWORD}@ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech/upsitehealth_test?sslmode=require`;
const itestSettings = {
  TEST_DATABASE_URL: ITEST,
  UPSITEHEALTH_ISOLATED_TEST_DB: "yes",
  UPSITEHEALTH_TEST_DB_HOST:
    "ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech",
};
const itestMarker = [
  {
    purpose: "integration-tests",
    endpoint_id: "ep-long-surf-b4hm6pyi",
    database_name: "upsitehealth_test",
  },
];

type Server = {
  identity: Record<string, unknown> | null;
  marker?: unknown[];
  readOnly?: string;
  defaultReadOnly?: string;
  searchPath?: string;
  raw?: Partial<Record<CategoryName, unknown>>;
  failOn?: CategoryName;
};

const CATEGORY_BY_SQL = new Map<string, CategoryName>(
  CATEGORIES.map((c) => [DEFINITION_QUERIES[c], c]),
);

function fakeDb(server: Server, log: string[]) {
  const raw = { ...base(), ...server.raw };
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      log.push(`exec ${sql}`);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      const category = CATEGORY_BY_SQL.get(sql);
      log.push(`query ${category ?? sql.split("\n")[0].slice(0, 48)}`);
      if (sql === QUERIES.transactionMode)
        return [
          { readOnly: server.readOnly ?? "on", isolation: "repeatable read" },
        ];
      if (sql === QUERIES.identity)
        return server.identity ? [server.identity] : [];
      if (sql === QUERIES.marker)
        return (server.marker ?? []).map((row) => ({ row }));
      if (sql === SESSION_DEFAULT_QUERY)
        return [{ defaultReadOnly: server.defaultReadOnly ?? "on" }];
      if (sql === DEFINITION_QUERIES.confirmSearchPath)
        return [{ searchPath: server.searchPath ?? "pg_catalog" }];
      if (category) {
        if (category === server.failOn)
          throw new Error(
            `relation "x" does not exist\nwhile connected to ${ITEST.replace("?sslmode=require", "")}`,
          );
        return raw[category];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    $queryRaw: vi.fn(),
  };
  return {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      log.push("BEGIN");
      try {
        const v = await fn(tx);
        log.push("COMMIT");
        return v;
      } catch (e) {
        log.push("ROLLBACK");
        throw e;
      }
    }),
    $disconnect: vi.fn(async () => {
      log.push("disconnect");
    }),
  } as unknown as ReadinessDb;
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "upsitehealth-definitions-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const outFile = (name = "fingerprint.json") => path.join(dir, name);
const filesIn = () => readdirSync(dir).sort();

function collector(
  settings: Record<string, string> | { error: string },
  server: Server,
  o: { fs?: OutputFs; onConnect?: () => void } = {},
) {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const connect = vi.fn((url: string) => {
    log.push(
      `connect ${url.includes("options=-c%20default_transaction_read_only%3Don") ? "read-only" : "PLAIN"}`,
    );
    o.onConnect?.();
    return fakeDb(server, log);
  });
  const readSettings = vi.fn(
    (_file: string, _target: "test" | "app" | "rehearsal") => settings,
  );
  const settingsFile = vi.fn(
    (t: "test" | "app" | "rehearsal") => `/settings/${t}.env`,
  );
  const d: DefinitionsDeps = {
    readSettings,
    chooseDatabase: (t, s) => chooseDatabase(t, s, []),
    settingsFile,
    connect,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fs: o.fs,
    now: () => new Date("2026-10-30T12:00:00Z"),
  };
  return { d, log, out, err, connect, readSettings };
}

const itestServer: Server = { identity: ITEST_SERVER, marker: itestMarker };

describe("parseDefinitionsArgs", () => {
  test("needs exactly one --target and one --out", () => {
    expect(parseDefinitionsArgs(["--target=test", "--out=/a/b.json"])).toEqual({
      target: "test",
      out: "/a/b.json",
    });
    expect(parseDefinitionsArgs(["--out=/a/b.json", "--target=app"])).toEqual({
      target: "app",
      out: "/a/b.json",
    });
  });

  test.each([
    ["missing target", ["--out=/a/b.json"], /Choose the database explicitly/],
    ["missing output path", ["--target=test"], /Name the new output file/],
    ["no arguments", [], /Choose the database explicitly/],
    [
      "a target name that is not a target",
      ["--target=itest-ci", "--out=/a"],
      /Unknown target: use --target=test \(itest-ci\), --target=app or --target=rehearsal\./,
    ],
    ["production", ["--target=production", "--out=/a"], /Unknown target/],
    [
      "duplicate --target",
      ["--target=test", "--target=app", "--out=/a"],
      /--target is given more than once/,
    ],
    [
      "duplicate --out",
      ["--target=test", "--out=/a", "--out=/b"],
      /--out is given more than once/,
    ],
    ["an empty value", ["--target=test", "--out="], /--out needs a value/],
    [
      "a flag without a value",
      ["--target", "--out=/a"],
      /Unknown or malformed argument: --target$/,
    ],
    [
      "no leading dashes",
      ["target=test", "--out=/a"],
      /Unknown or malformed argument: \(a value without a --flag\)$/,
    ],
    [
      "--json",
      ["--target=test", "--out=/a", "--json"],
      /Unknown or malformed argument: --json$/,
    ],
    [
      "--settings",
      ["--target=test", "--out=/a", "--settings=x.env"],
      /Unknown or malformed argument: --settings$/,
    ],
  ])("%s is a usage error", (_n, argv, message) => {
    const r = parseDefinitionsArgs(argv);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(message);
  });

  test("a database URL given as an argument is refused and never echoed", () => {
    for (const arg of [
      `--url=${ITEST}`,
      `--database-url=${ITEST}`,
      ITEST,
      `--target=${ITEST}`,
    ]) {
      const r = parseDefinitionsArgs([arg, "--out=/a"]);
      expect(r).toHaveProperty("error");
      expect(JSON.stringify(r)).not.toContain(PASSWORD);
      expect(JSON.stringify(r)).not.toMatch(/postgres(ql)?:/);
    }
  });
});

describe("collector refusals before any connection", () => {
  test("a usage error reads no settings, opens nothing and writes nothing", async () => {
    for (const argv of [
      [],
      ["--target=test"],
      [`--out=${outFile()}`],
      ["--target=itest-ci", `--out=${outFile()}`],
      ["--target=test", `--out=${outFile()}`, "--json"],
      ["--target=test", "--target=test", `--out=${outFile()}`],
      [`--url=${ITEST}`, `--out=${outFile()}`],
    ]) {
      const x = collector(itestSettings, itestServer);
      expect(await runDefinitions(argv, x.d)).toBe(2);
      expect(x.readSettings).not.toHaveBeenCalled();
      expect(x.connect).not.toHaveBeenCalled();
      expect(x.out).toEqual([]);
      expect(x.err.join("")).not.toContain(PASSWORD);
      expect(filesIn()).toEqual([]);
    }
  });

  test.each([
    [
      "a relative path",
      () => "fingerprint.json",
      /--out must be an absolute path/,
    ],
    [
      "a path in a missing folder",
      () => path.join(dir, "nope", "f.json"),
      /cannot be used \(its folder does not exist\)/,
    ],
    ["a folder", () => `${dir}/`, /--out must name a file, not a folder/],
    [
      "a path under a file",
      () => {
        writeFileSync(path.join(dir, "plain"), "x");
        return path.join(dir, "plain", "f.json");
      },
      /cannot be (checked|used) \(a part of the path is not a folder\)/,
    ],
  ])("%s is refused before the settings are read", async (_n, out, message) => {
    const x = collector(itestSettings, itestServer);
    expect(await runDefinitions(["--target=test", `--out=${out()}`], x.d)).toBe(
      1,
    );
    expect(x.err.join("")).toMatch(message);
    expect(x.err.join("")).toMatch(/No connection was opened\.$/);
    expect(x.readSettings).not.toHaveBeenCalled();
    expect(x.connect).not.toHaveBeenCalled();
  });

  test("an existing file is refused before connecting and left untouched", async () => {
    writeFileSync(outFile(), "keep me", { mode: 0o644 });
    const x = collector(itestSettings, itestServer);
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.err.join("")).toMatch(/already exists; it is never overwritten/);
    expect(x.connect).not.toHaveBeenCalled();
    expect(readFileSync(outFile(), "utf8")).toBe("keep me");
    expect(filesIn()).toEqual(["fingerprint.json"]);
  });

  test("an existing symbolic link, even a dangling one, is refused", async () => {
    symlinkSync(path.join(dir, "elsewhere.json"), outFile());
    const x = collector(itestSettings, itestServer);
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.err.join("")).toMatch(/already exists/);
    expect(existsSync(path.join(dir, "elsewhere.json"))).toBe(false);
  });

  test.each([
    [
      "Neon production",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`,
      },
    ],
    [
      "Supabase",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`,
      },
    ],
    [
      "an unknown hosted database",
      "app",
      {
        DATABASE_URL: `postgresql://u:${PASSWORD}@ep-other-thing-a1b2c3d4.c-2.us-east-1.aws.neon.tech/db?sslmode=require`,
      },
    ],
    ["no database in the settings", "app", {}],
    [
      "the shared database as the test target",
      "test",
      {
        ...itestSettings,
        TEST_DATABASE_URL: SHARED,
        UPSITEHEALTH_TEST_DB_HOST:
          "ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech",
      },
    ],
    [
      "a URL that already sets options",
      "app",
      {
        DATABASE_URL: `${SHARED}&options=-c%20default_transaction_read_only%3Doff`,
      },
    ],
    ["unreadable settings", "test", { error: "the settings file is missing" }],
  ])("%s", async (_n, target, settings) => {
    const x = collector(settings as Record<string, string>, itestServer);
    expect(
      await runDefinitions([`--target=${target}`, `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.err.join("\n")).toMatch(
      /^Refused: .*No connection was opened\.$/s,
    );
    expect(x.err.join("\n")).not.toContain(PASSWORD);
    expect(x.out).toEqual([]);
    expect(filesIn()).toEqual([]);
  });
});

describe("collector on a scripted server", () => {
  test("proves the server, reads every category, rolls back, then saves a 0600 file", async () => {
    const x = collector(itestSettings, itestServer);
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(0);
    expect(x.log).toEqual([
      "connect read-only",
      "BEGIN",
      `exec ${QUERIES.readOnly}`,
      `exec ${QUERIES.statementTimeout}`,
      `exec ${QUERIES.lockTimeout}`,
      `query ${QUERIES.transactionMode.split("\n")[0].slice(0, 48)}`,
      `query ${QUERIES.identity.split("\n")[0].slice(0, 48)}`,
      `query ${QUERIES.marker.slice(0, 48)}`,
      `query ${SESSION_DEFAULT_QUERY.slice(0, 48)}`,
      `exec ${DEFINITION_QUERIES.searchPath}`,
      `query ${DEFINITION_QUERIES.confirmSearchPath.slice(0, 48)}`,
      ...CATEGORIES.map((c) => `query ${c}`),
      "ROLLBACK",
      "disconnect",
    ]);
    expect(statSync(outFile()).mode & 0o777).toBe(0o600);
    expect(filesIn()).toEqual(["fingerprint.json"]);
    const text = readFileSync(outFile(), "utf8");
    const parsed = parseFingerprint(text);
    if (!("fingerprint" in parsed)) throw new Error(parsed.error);
    const fp = parsed.fingerprint;
    expect(fp.server).toEqual(ITEST_SERVER);
    expect(fp.transaction).toEqual({
      readOnly: true,
      sessionDefaultReadOnly: true,
      isolation: "repeatable read",
      endedBy: "rollback",
    });
    expect(fp.scope.searchPath).toBe("pg_catalog");
    expect(unsavableProblem(text)).toBeNull();
    expect(compareFingerprints(fingerprint(base()), fp, PRISMA).result).toBe(
      "identical",
    );
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });

  test("stdout is a short summary: no fingerprint, definitions or server details", async () => {
    const x = collector(itestSettings, itestServer);
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(0);
    expect(x.out).toEqual([
      [
        "Definitions fingerprint collected (read-only, target test).",
        `Saved: ${outFile()} (mode 0600)`,
        "Format: upsitehealth-db-definitions version 1",
        "Complete: all 10 categories collected",
      ].join("\n"),
    ]);
    expect(x.err).toEqual([]);
    const printed = [...x.out, ...x.err].join("\n");
    for (const secret of [
      PASSWORD,
      ITEST_SERVER.endpoint,
      ITEST_SERVER.branch,
      ITEST_SERVER.role,
      "CHECK (",
      "CREATE ",
      "postgres",
    ])
      expect(printed).not.toContain(secret);
  });

  test("the approved target's settings, and only them, choose the database", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o.c-2.us-east-1.aws.neon.tech/neondb`,
    );
    vi.stubEnv(
      "DIRECT_URL",
      `postgresql://u:${PASSWORD}@ep-square-mud-b4ito98o.c-2.us-east-1.aws.neon.tech/neondb`,
    );
    try {
      const x = collector(itestSettings, itestServer);
      expect(
        await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
      ).toBe(0);
      expect(x.readSettings).toHaveBeenCalledExactlyOnceWith(
        "/settings/test.env",
        "test",
      );
      const url = new URL(x.connect.mock.calls[0][0]);
      expect(url.hostname).toBe(
        "ep-long-surf-b4hm6pyi.c-6.us-east-2.aws.neon.tech",
      );
      expect(url.pathname).toBe("/upsitehealth_test");
      expect(url.searchParams.get("options")).toBe(
        "-c default_transaction_read_only=on",
      );

      const shared = collector(
        { DATABASE_URL: SHARED },
        { identity: SHARED_SERVER },
      );
      expect(
        await runDefinitions(
          ["--target=app", `--out=${outFile("shared.json")}`],
          shared.d,
        ),
      ).toBe(0);
      expect(shared.readSettings).toHaveBeenCalledExactlyOnceWith(
        "/settings/app.env",
        "app",
      );
      expect(new URL(shared.connect.mock.calls[0][0]).hostname).toBe(
        "ep-dark-rain-b4ve04n3.c-6.us-east-2.aws.neon.tech",
      );
      expect(shared.log).not.toContain(`query ${QUERIES.marker.slice(0, 48)}`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test.each([
    [
      "the wrong branch",
      {
        identity: { ...ITEST_SERVER, branch: "br-other" },
        marker: itestMarker,
      },
      /Neon branch br-other/,
    ],
    ["no marker", { identity: ITEST_SERVER, marker: [] }, /marker row missing/],
    [
      "no identity",
      { identity: null, marker: itestMarker },
      /did not report its identity/,
    ],
    [
      "a read-write transaction",
      { ...itestServer, readOnly: "off" },
      /did not confirm a read-only transaction/,
    ],
    [
      "no read-only session default",
      { ...itestServer, defaultReadOnly: "off" },
      /did not apply default_transaction_read_only/,
    ],
    [
      "a different search path",
      { ...itestServer, searchPath: '"$user", public' },
      /did not confirm search_path pg_catalog/,
    ],
  ])(
    "%s is refused before any definition is read, and nothing is saved",
    async (_n, server, message) => {
      const x = collector(itestSettings, server as Server);
      expect(
        await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
      ).toBe(1);
      expect(x.err.join("")).toMatch(message);
      expect(x.err.join("")).toMatch(/No fingerprint was saved\.$/);
      expect(
        x.log.filter((l) => CATEGORIES.some((c) => l === `query ${c}`)),
      ).toEqual([]);
      expect(x.out).toEqual([]);
      expect(x.log.slice(-2)).toEqual(["ROLLBACK", "disconnect"]);
      expect(filesIn()).toEqual([]);
    },
  );

  test("a failing category query leaves no file, and no URL or password in the error", async () => {
    const x = collector(itestSettings, { ...itestServer, failOn: "policies" });
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.out).toEqual([]);
    expect(x.log).not.toContain("query relations");
    expect(x.log.slice(-2)).toEqual(["ROLLBACK", "disconnect"]);
    const err = x.err.join("");
    expect(err).toMatch(/^Refused: the database could not be read/);
    expect(err).not.toContain(PASSWORD);
    expect(err).not.toMatch(/postgres(ql)?:\/\//);
    expect(filesIn()).toEqual([]);
  });

  test("a category that returns no rows list fails instead of saving an empty one", async () => {
    const x = collector(itestSettings, {
      ...itestServer,
      raw: { triggers: undefined },
    });
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.err.join("")).toMatch(
      /the collection failed \(triggers: the catalog query returned no rows list\)/,
    );
    expect(filesIn()).toEqual([]);
  });

  test("a fingerprint that would carry the password is withheld and not saved", async () => {
    const raw = base();
    find(raw, "policies", "business_facts_tenant").using =
      `(x = '${PASSWORD}')`;
    const x = collector(itestSettings, { ...itestServer, raw });
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.err.join("")).toMatch(
      /fingerprint was withheld because it contains the password/,
    );
    expect(x.err.join("")).not.toContain(PASSWORD);
    expect(filesIn()).toEqual([]);
  });

  test("a file that appears during the collection is not overwritten", async () => {
    const x = collector(itestSettings, itestServer, {
      onConnect: () => writeFileSync(outFile(), "someone else's"),
    });
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.err.join("")).toMatch(
      /could not be created \(it already exists\)\. No fingerprint was saved/,
    );
    expect(readFileSync(outFile(), "utf8")).toBe("someone else's");
    expect(filesIn()).toEqual(["fingerprint.json"]);
    expect(x.out).toEqual([]);
  });

  test("a saved fingerprint compares with the offline command, unchanged", async () => {
    const x = collector(itestSettings, itestServer);
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(0);
    writeFileSync(
      outFile("reference.json"),
      serializeFingerprint(fingerprint(base())),
    );
    const out: string[] = [];
    const code = runCompare([outFile("reference.json"), outFile()], {
      readFile: (f) => readFileSync(f, "utf8"),
      prismaSchema: () =>
        readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8"),
      out: (t) => out.push(t),
      err: (t) => out.push(t),
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Result: identical");
  });
});

describe("unsavableProblem", () => {
  const good = serializeFingerprint(fingerprint(base()));
  test("a complete fingerprint can be saved", () => {
    expect(unsavableProblem(good)).toBeNull();
  });
  test("an incomplete or invalid one cannot", () => {
    const data = JSON.parse(good);
    data.categories.policies = { collected: false, reason: "x" };
    delete data.categories.types;
    expect(unsavableProblem(JSON.stringify(data))).toBe(
      "categories not collected: policies, types",
    );
    expect(
      unsavableProblem(good.replace('"version": 1', '"version": 2')),
    ).toMatch(/unsupported fingerprint version 2/);
    expect(unsavableProblem("{")).toBe("the file is not JSON");
    expect(
      unsavableProblem(
        good.replace('"label": "x"', '"label": "postgres://a@b/c"'),
      ),
    ).toBe("the file contains a database URL");
  });
});

// ─── Secure output ──────────────────────────────────────────────────────────

describe("writeNewFile", () => {
  /** The real file system, with one call made to fail; logs every call. */
  function fsWith(fail: Partial<Record<keyof OutputFs, string>> = {}) {
    const calls: string[] = [];
    const wrap = <K extends keyof OutputFs>(name: K) =>
      ((...args: unknown[]) => {
        calls.push(
          `${name} ${args
            .filter((a) => typeof a === "string")
            .map((a) => path.basename(a as string))
            .join(" ")}`.trim(),
        );
        if (fail[name])
          throw Object.assign(new Error(`${name} failed at ${ITEST}`), {
            code: fail[name],
          });
        return (nodeFs[name] as (...a: unknown[]) => unknown)(...args);
      }) as OutputFs[K];
    const fs = Object.fromEntries(
      (
        [
          "lstatSync",
          "statSync",
          "openSync",
          "writeSync",
          "fsyncSync",
          "fchmodSync",
          "closeSync",
          "linkSync",
          "unlinkSync",
        ] as const
      ).map((n) => [n, wrap(n)]),
    ) as OutputFs;
    return { fs, calls };
  }

  test("writes a temporary file, links it to the final name, removes it", () => {
    const { fs, calls } = fsWith();
    const tmp = path.join(dir, ".f.json.tmp");
    expect(writeNewFile(outFile("f.json"), "content\n", fs, tmp)).toEqual({
      ok: true,
    });
    expect(calls).toEqual([
      "openSync .f.json.tmp wx",
      "fchmodSync",
      "writeSync",
      "fsyncSync",
      "closeSync",
      "linkSync .f.json.tmp f.json",
      "unlinkSync .f.json.tmp",
    ]);
    expect(readFileSync(outFile("f.json"), "utf8")).toBe("content\n");
    expect(statSync(outFile("f.json")).mode & 0o777).toBe(0o600);
    expect(filesIn()).toEqual(["f.json"]);
  });

  test("the mode is 0600 whatever the umask", () => {
    const old = process.umask(0o000);
    try {
      expect(writeNewFile(outFile("a.json"), "x").ok).toBe(true);
    } finally {
      process.umask(old);
    }
    expect(statSync(outFile("a.json")).mode & 0o777).toBe(0o600);
  });

  test("never replaces an existing file", () => {
    writeFileSync(outFile("f.json"), "original");
    const r = writeNewFile(outFile("f.json"), "new");
    expect(r).toEqual({
      ok: false,
      error: `${outFile("f.json")} could not be created (it already exists)`,
      leftover: undefined,
    });
    expect(readFileSync(outFile("f.json"), "utf8")).toBe("original");
    expect(filesIn()).toEqual(["f.json"]);
  });

  test.each([
    [
      "openSync",
      "EACCES",
      "the temporary file could not be created (permission denied)",
    ],
    [
      "writeSync",
      "ENOSPC",
      "the temporary file could not be written (no space left on the device)",
    ],
    ["fsyncSync", "EIO", "the temporary file could not be written (EIO)"],
    [
      "linkSync",
      "EXDEV",
      "could not be created (the file system does not support hard links)",
    ],
  ] as const)(
    "a failing %s leaves no final file and no temporary file",
    (call, code, message) => {
      const { fs } = fsWith({ [call]: code });
      const r = writeNewFile(outFile("f.json"), "content", fs);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain(message);
      expect(!r.ok && r.leftover).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(PASSWORD);
      expect(filesIn()).toEqual([]);
    },
  );

  test("a temporary file that cannot be removed is named, never hidden", () => {
    const failed = writeNewFile(
      outFile("f.json"),
      "content",
      fsWith({ writeSync: "ENOSPC", unlinkSync: "EPERM" }).fs,
      path.join(dir, ".t.tmp"),
    );
    expect(failed).toEqual({
      ok: false,
      error:
        "the temporary file could not be written (no space left on the device)",
      leftover: path.join(dir, ".t.tmp"),
    });
    expect(existsSync(outFile("f.json"))).toBe(false);

    const saved = writeNewFile(
      outFile("g.json"),
      "content",
      fsWith({ unlinkSync: "EPERM" }).fs,
      path.join(dir, ".u.tmp"),
    );
    expect(saved).toEqual({ ok: true, leftover: path.join(dir, ".u.tmp") });
    expect(readFileSync(outFile("g.json"), "utf8")).toBe("content");
  });

  test("the collector reports a write failure safely and leaves no artifact", async () => {
    const x = collector(itestSettings, itestServer, {
      fs: fsWith({ writeSync: "ENOSPC" }).fs,
    });
    expect(
      await runDefinitions(["--target=test", `--out=${outFile()}`], x.d),
    ).toBe(1);
    expect(x.err).toEqual([
      `Failed: the temporary file could not be written (no space left on the device). No fingerprint was saved at ${outFile()}.`,
    ]);
    expect(x.out).toEqual([]);
    expect(filesIn()).toEqual([]);
  });

  test("outputPathProblem", () => {
    expect(outputPathProblem(outFile())).toBeNull();
    expect(outputPathProblem("rel/f.json")).toBe(
      "--out must be an absolute path",
    );
    expect(
      outputPathProblem(outFile(), fsWith({ lstatSync: "EACCES" }).fs),
    ).toBe(`${outFile()} cannot be checked (permission denied)`);
  });
});

// ─── Read-only and offline by construction ──────────────────────────────────

describe("static safety", () => {
  const src = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  test.each(Object.entries(DEFINITION_QUERIES))(
    "%s is a SELECT or the transaction-local search path",
    (_n, sql) => {
      expect(sql).toMatch(/^(SELECT\s|SET LOCAL search_path = pg_catalog$)/);
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|REINDEX|nextval|setval|pg_advisory\w*|FOR (NO KEY )?UPDATE|FOR (KEY )?SHARE)\b/i,
      );
      expect(sql).not.toContain(";");
    },
  );

  test("the definitions modules execute nothing but the search path", () => {
    for (const file of [
      "scripts/db-readiness/definitions.ts",
      "scripts/db-readiness/definitions-run.ts",
      "scripts/db-readiness/compare-definitions.ts",
      "scripts/db-readiness/secure-output.ts",
      "scripts/db-definitions.ts",
    ]) {
      const text = src(file);
      for (const m of text.matchAll(/\$executeRaw\w*\(([^)]*)\)/g))
        expect(m[1]).toBe("DEFINITION_QUERIES.searchPath");
      expect(text).not.toMatch(/\$executeRaw`|\$transaction\(\[/);
    }
  });

  test("the comparison has no database dependency", () => {
    for (const file of [
      "scripts/db-readiness/compare-definitions.ts",
      "scripts/db-definitions-compare.ts",
    ]) {
      const imports = [
        ...src(file).matchAll(/^import (?!type ).*? from "([^"]+)";$/gms),
      ].map((m) => m[1]);
      expect(
        imports.filter((i) =>
          /prisma|pg|crawl-worker|\.\/run$|report|db-drift|definitions-run|@\/lib/.test(
            i,
          ),
        ),
      ).toEqual([]);
      expect(src(file)).not.toMatch(/process\.env|readSettings|connect\(/);
    }
    // definitions.ts only borrows types from the report.
    expect(src("scripts/db-readiness/definitions.ts")).toMatch(
      /^import type \{[^}]*\} from "\.\/report";$/m,
    );
    expect(
      src("scripts/db-readiness/definitions.ts").match(/^import /gm),
    ).toHaveLength(1);
  });

  test("the collector has exactly one command, and nothing else runs it", () => {
    const scripts = JSON.parse(src("package.json")).scripts as Record<
      string,
      string
    >;
    const runner =
      "node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./scripts/ts-loader/register.mjs";
    expect(
      Object.entries(scripts).filter(
        ([name, cmd]) => /definition/.test(name) || /definition/.test(cmd),
      ),
    ).toEqual([
      ["db:definitions", `${runner} scripts/db-definitions.ts`],
      ["db:definitions:compare", `${runner} scripts/db-definitions-compare.ts`],
    ]);
    const users = readdirSync(path.join(ROOT, "scripts"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.endsWith("definitions-run.ts"))
      .filter((f) => src(path.join("scripts", f)).includes("runDefinitions"));
    expect(users).toEqual(["db-definitions.ts"]);
    // The entry only wires dependencies: the database comes from the
    // target's settings file, never from the environment or arguments.
    const entry = src("scripts/db-definitions.ts");
    expect(entry).not.toMatch(/process\.env|DATABASE_URL|DIRECT_URL/);
    expect(entry).toMatch(/readSettings,\n/);
    expect(entry).toMatch(
      /settingsFile: \(target\) => TARGET_SETTINGS_FILES\[target\]/,
    );
    // No test imports (and so runs) an entry script.
    for (const f of readdirSync(path.join(ROOT, "tests"), {
      recursive: true,
    }).map(String))
      if (/\.test\.tsx?$/.test(f))
        expect(src(path.join("tests", f))).not.toMatch(
          /from "\.\.\/scripts\/db-(definitions|definitions-compare|drift|readiness)"/,
        );
  });
});
