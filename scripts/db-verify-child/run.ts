import { homedir } from "node:os";
import path from "node:path";
import {
  NEON_NEVER_REHEARSE,
  NEON_PRODUCTION_ENDPOINTS,
  NEON_REHEARSAL_TARGETS,
  NEON_SHARED_ENDPOINTS,
  NEON_TEST_ENDPOINTS,
  neonEndpointId,
  parseDbTarget,
  safeTargetLabel,
} from "../../prisma/safety";
import { readOnlyUrl, scrub } from "../db-drift/run";
import { unsavableProblem } from "../db-readiness/definitions-run";
import {
  CollectionError,
  FINGERPRINT_FORMAT,
  FINGERPRINT_VERSION,
  NORMALIZATION,
  SEARCH_PATH,
  serializeFingerprint,
  type Categories,
  type Fingerprint,
} from "../db-readiness/definitions";
import {
  unsafeOutputProblem,
  type ReadinessReport,
  type ReadOnlyTx,
} from "../db-readiness/report";
import {
  inReadOnlyTransaction,
  reason,
  ServerRefusal,
  type ReadinessDb,
} from "../db-readiness/run";
import {
  BASELINE_COUNTS,
  classify,
  FINISHED_STAGE,
  HISTORY_EVIDENCE,
  TARGET,
  type ServerState,
} from "../db-reconcile-shared/run";

/**
 * Read-only verification of a disposable dress-rehearsal child branch of
 * integration-tests (docs/operations/shared-reconciliation-runbook.md,
 * section 6), without a rehearsal marker and without the rehearsal
 * allowlist (owner decision B1, option B).
 *
 * - The expected branch and endpoint come from the command line and must be
 *   new: never a protected, production, shared, test or rehearsal-allowlist
 *   ID. The URL comes from its own private settings file only, and must be
 *   that endpoint's direct host, database and role `upsitehealth_test`.
 * - One connection on the read-only URL (default_transaction_read_only),
 *   one READ ONLY transaction (readiness's inReadOnlyTransaction, always
 *   rolled back). Identity is proven first, exactly; nothing else is read
 *   unless it matches. Every statement is a fixed SELECT reused from the
 *   readiness, reconciliation and definitions code. No Prisma CLI, no
 *   writes, no marker.
 * - Then the reconciliation's own state machine (classify) must report the
 *   expected stage (0 before, 8 after); readiness must agree (history,
 *   checksums, objects 0–5, migration 5 absent and unrecorded, Stage 2
 *   identity, M2 collisions, counts). Optionally a definitions fingerprint
 *   is saved for db:definitions:compare against the 3Nov and itest-ci
 *   references.
 */

/** The child's private settings file and its only key. */
export const CHILD_SETTINGS_FILE = path.join(
  homedir(),
  ".config/upsitehealth/neon-dress-child.env",
);
export const CHILD_URL_VAR = "DRESS_CHILD_DATABASE_URL";

export const USAGE = `Usage: node --experimental-transform-types --import ./scripts/ts-loader/register.mjs \\
         scripts/db-verify-child.ts --expect-branch=<br-…> --expect-endpoint=<ep-…> \\
         --expect-stage=<0|8> [--fingerprint-out=<absolute path of a new file>]

Read-only: one READ ONLY transaction, always rolled back. The URL is
${CHILD_URL_VAR} in ${CHILD_SETTINGS_FILE} (0600). Exit 0 every
expectation met, 1 refused or not met, 2 usage.`;

export type VerifyArgs = {
  branch: string;
  endpoint: string;
  stage: 0 | 8;
  fingerprintOut: string | null;
};

const FLAGS = [
  "expect-branch",
  "expect-endpoint",
  "expect-stage",
  "fingerprint-out",
];

export function parseVerifyArgs(
  argv: string[],
): VerifyArgs | { error: string } {
  const seen = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z][a-z-]*)=(.+)$/s.exec(arg);
    // Only the flag's name is ever echoed.
    if (!m || !FLAGS.includes(m[1]))
      return {
        error: `Unknown or malformed argument: ${/^--[a-z][a-z-]{0,30}/.exec(arg)?.[0] ?? "(a value)"}`,
      };
    if (seen.has(m[1])) return { error: `--${m[1]} is given more than once.` };
    seen.set(m[1], m[2]);
  }
  const branch = seen.get("expect-branch");
  const endpoint = seen.get("expect-endpoint");
  const stage = seen.get("expect-stage");
  if (!branch || !endpoint || !stage)
    return {
      error:
        "--expect-branch, --expect-endpoint and --expect-stage are required.",
    };
  if (stage !== "0" && stage !== "8")
    return { error: "--expect-stage must be 0 (before) or 8 (after)." };
  const out = seen.get("fingerprint-out") ?? null;
  if (out !== null && !path.isAbsolute(out))
    return { error: "--fingerprint-out must be an absolute path." };
  return {
    branch,
    endpoint,
    stage: Number(stage) as 0 | 8,
    fingerprintOut: out,
  };
}

const BRANCH_ID = /^br-[a-z0-9]+(-[a-z0-9]+)*$/;
const ENDPOINT_ID = /^ep-[a-z0-9]+(-[a-z0-9]+)*$/;

/** Null when the expected IDs may name a disposable child, else why not. */
export function expectationProblem(a: VerifyArgs): string | null {
  if (!BRANCH_ID.test(a.branch) || !ENDPOINT_ID.test(a.endpoint))
    return "the expected branch or endpoint ID is malformed";
  const known = new Set<string>([
    ...NEON_NEVER_REHEARSE.branches,
    ...NEON_NEVER_REHEARSE.endpoints,
    ...NEON_PRODUCTION_ENDPOINTS,
    ...NEON_SHARED_ENDPOINTS,
    ...NEON_TEST_ENDPOINTS,
    ...NEON_REHEARSAL_TARGETS.flatMap((t) => [t.branch, t.endpoint]),
    TARGET.branch,
    TARGET.endpoint,
  ]);
  if (known.has(a.branch) || known.has(a.endpoint))
    return "the expected IDs name a protected, production, shared, test or rehearsal branch, not a new disposable child";
  return null;
}

/** The settings file must hold the child's URL and nothing else. */
export function childUrl(
  settings: Record<string, string | undefined>,
): string | { error: string } {
  const foreign = Object.keys(settings).filter((k) => k !== CHILD_URL_VAR);
  if (foreign.length)
    return {
      error: `the child settings file must hold only ${CHILD_URL_VAR} (it also sets ${foreign.length} other key(s))`,
    };
  const url = settings[CHILD_URL_VAR]?.trim();
  return url ? url : { error: `${CHILD_URL_VAR} is not set` };
}

/** Null when the URL is exactly the expected child's direct host. */
export function childUrlProblem(
  url: string,
  a: VerifyArgs,
  appUrls: string[],
): string | null {
  const t = parseDbTarget(url);
  if ("error" in t) return `the child URL is unusable: ${t.error}`;
  if (t.local) return "the child URL is a local database";
  if (
    t.host.split(".")[0] !== a.endpoint ||
    neonEndpointId(t.host) !== a.endpoint
  )
    return `the child URL is not the direct host of ${a.endpoint}`;
  if (t.database !== TARGET.database)
    return `the child URL names another database, not ${TARGET.database}`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "the child URL cannot be read";
  }
  if (decodeURIComponent(u.username) !== TARGET.role)
    return `the child URL names another role, not ${TARGET.role}`;
  const ssl = u.searchParams.get("sslmode");
  if (ssl !== "require" && ssl !== "verify-full")
    return "the child URL must use sslmode=require or verify-full";
  if (u.searchParams.has("options"))
    return "the child URL must not set options";
  for (const app of appUrls) {
    const other = parseDbTarget(app);
    if (!("error" in other) && other.host === t.host)
      return "the child URL is on the server of an app database URL";
  }
  return null;
}

export type ChildIdentity = {
  branch: string | null;
  endpoint: string | null;
  database: string;
  role: string;
  sessionRole: string;
  serverVersion: string;
  readOnly: string;
  defaultReadOnly: string;
};

export const IDENTITY_QUERY = `SELECT current_setting('neon.branch_id', true) AS branch,
    current_setting('neon.endpoint_id', true) AS endpoint,
    current_database() AS database, current_user AS role,
    session_user AS "sessionRole",
    current_setting('server_version') AS "serverVersion",
    current_setting('transaction_read_only') AS "readOnly",
    current_setting('default_transaction_read_only') AS "defaultReadOnly"`;

/** Null when the server is exactly the expected child, read-only. */
export function childIdentityProblem(
  id: ChildIdentity | undefined,
  a: VerifyArgs,
): string | null {
  if (!id) return "the server did not report its identity";
  const facts: Array<[string, unknown, string]> = [
    ["branch", id.branch, a.branch],
    ["endpoint", id.endpoint, a.endpoint],
    ["database", id.database, TARGET.database],
    ["role", id.role, TARGET.role],
    ["session role", id.sessionRole, TARGET.role],
    ["transaction_read_only", id.readOnly, "on"],
    ["default_transaction_read_only", id.defaultReadOnly, "on"],
  ];
  for (const [what, got, want] of facts)
    if (got !== want)
      return `the server reports ${what} ${typeof got === "string" && got ? got : "(none)"}, not ${want}`;
  return null;
}

type Readiness = Pick<
  ReadinessReport,
  "history" | "migrations" | "capabilities" | "duplicates" | "counts"
>;

/** Where readiness disagrees with the expected stage (none: agreement). */
export function readinessProblems(r: Readiness, stage: 0 | 8): string[] {
  const problems: string[] = [];
  const done = stage === FINISHED_STAGE;
  for (const m of r.migrations) {
    const five = m.name === "5_finding_resolution_events";
    const wantHistory = done
      ? five
        ? "not-recorded"
        : "finished"
      : "no-history-table";
    const wantObjects =
      five ||
      (!done &&
        (m.name === "2_recommendation_events" ||
          m.name === "4_recommendation_identity"))
        ? "absent"
        : "present";
    if (m.history !== wantHistory)
      problems.push(`${m.name}: history ${m.history}, expected ${wantHistory}`);
    if (done && !five && m.checksumMatchesFile !== true)
      problems.push(
        `${m.name}: the recorded checksum is not the repository file's`,
      );
    if (m.objects && m.objects.state !== wantObjects)
      problems.push(
        `${m.name}: objects ${m.objects.state} (${m.objects.found}/${m.objects.expected}), expected ${wantObjects}`,
      );
  }
  if (r.history.unknown.length)
    problems.push(
      `the history records unknown migrations: ${r.history.unknown.join(", ")}`,
    );
  if (r.capabilities.history !== done)
    problems.push(
      `task history is ${r.capabilities.history ? "available" : "unavailable"}`,
    );
  if (r.capabilities.identity.enabled !== done)
    problems.push(
      `Stage 2 identity is ${r.capabilities.identity.enabled ? "on" : "off"}`,
    );
  if (
    done &&
    (r.duplicates.identity === null || r.duplicates.identity.groups !== 0)
  )
    problems.push("M2 identity collisions are not 0");
  for (const [table, n] of Object.entries(BASELINE_COUNTS))
    if (r.counts[table] !== n)
      problems.push(`${table} has ${r.counts[table] ?? "no"} rows, not ${n}`);
  for (const table of ["recommendation_events", "recommendation_evidence"])
    if (table in r.counts && r.counts[table] !== 0)
      problems.push(`${table} is not empty`);
  return problems;
}

export type VerifyDeps = {
  readSettings: () => Record<string, string> | { error: string };
  appUrls: () => string[];
  connect: (url: string) => ReadinessDb;
  readIdentity: (tx: ReadOnlyTx) => Promise<ChildIdentity | undefined>;
  readState: (tx: ReadOnlyTx) => Promise<ServerState>;
  inspect: (tx: ReadOnlyTx) => Promise<Readiness>;
  collect: (tx: ReadOnlyTx) => Promise<Categories>;
  outputProblem: (file: string) => string | null;
  writeNew: (file: string, text: string) => string | null;
  now: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
};

/** Exit codes: 0 every expectation met, 1 refused or not met, 2 usage. */
export async function runVerifyChild(
  argv: string[],
  deps: VerifyDeps,
): Promise<number> {
  const args = parseVerifyArgs(argv);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const urls: string[] = [];
  const refuse = (why: string, connected = false) => {
    deps.err(
      scrub(
        `Refused: ${why}. ${connected ? "Nothing more was read." : "No connection was opened."}`,
        urls,
      ),
    );
    return 1;
  };
  const expectation = expectationProblem(args);
  if (expectation) return refuse(expectation);
  if (args.fingerprintOut) {
    const outProblem = deps.outputProblem(args.fingerprintOut);
    if (outProblem) return refuse(outProblem);
  }
  const settings = deps.readSettings();
  if ("error" in settings) return refuse(settings.error);
  const url = childUrl(settings);
  if (typeof url !== "string") return refuse(url.error);
  urls.push(url);
  const urlProblem = childUrlProblem(url, args, deps.appUrls());
  if (urlProblem) return refuse(urlProblem);
  const ro = readOnlyUrl(url);
  if (typeof ro !== "string") return refuse(ro.error);
  urls.push(ro);

  const db = deps.connect(ro);
  let result: {
    identity: ChildIdentity;
    state: ServerState;
    readiness: Readiness;
    categories: Categories | null;
    isolation: string;
  };
  try {
    result = await inReadOnlyTransaction(db, async (tx, mode) => {
      const identity = await deps.readIdentity(tx);
      const problem = childIdentityProblem(identity, args);
      if (problem) throw new ServerRefusal(problem);
      return {
        identity: identity!,
        state: await deps.readState(tx),
        readiness: await deps.inspect(tx),
        categories: args.fingerprintOut ? await deps.collect(tx) : null,
        isolation: mode.isolation,
      };
    });
  } catch (error) {
    return refuse(
      error instanceof ServerRefusal
        ? error.message
        : error instanceof CollectionError
          ? `the definitions collection failed (${error.message})`
          : `the database could not be read (${reason(error)})`,
      true,
    );
  } finally {
    await db.$disconnect().catch(() => {});
  }

  const { identity, state, readiness } = result;
  const c = classify(state, HISTORY_EVIDENCE);
  const problems = [
    ...("stage" in c
      ? c.stage === args.stage
        ? []
        : [
            `the reconciliation state machine reports stage ${c.stage}, not ${args.stage}`,
          ]
      : c.problems.map((p) => `state: ${p}`)),
    ...readinessProblems(readiness, args.stage),
  ];
  const sp = state.searchPath;
  const lines = [
    `Child (read-only, ${result.isolation}, rolled back): branch ${identity.branch}, endpoint ${identity.endpoint}, database ${identity.database}, role ${identity.role}, PostgreSQL ${identity.serverVersion}`,
    `search_path ${sp?.searchPath ?? "?"}; current_schema() ${sp?.currentSchema ?? "?"}; current_schemas(false) ${sp?.effectiveSchemas ?? "?"}`,
    `Stage (classify): ${"stage" in c ? c.stage : "none"}`,
    `History: ${state.history ? state.history.map((r) => `${r.name} ${r.checksum.slice(0, 8)}`).join(", ") || "(empty)" : "absent"}`,
    ...readiness.migrations.map(
      (m) =>
        `  ${m.name}: history ${m.history}; objects ${m.objects ? `${m.objects.state} ${m.objects.found}/${m.objects.expected}` : "not checked"}`,
    ),
    `Task history ${readiness.capabilities.history ? "available" : "unavailable"}; Stage 2 identity ${readiness.capabilities.identity.enabled ? "on" : "off"}; M2 collisions ${readiness.duplicates.identity?.groups ?? "n/a"}`,
    `Rows: ${Object.entries(readiness.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  ];

  if (result.categories && args.fingerprintOut) {
    const fingerprint: Fingerprint = {
      format: FINGERPRINT_FORMAT,
      version: FINGERPRINT_VERSION,
      generatedAt: deps.now().toISOString(),
      target: {
        name: "rehearsal",
        label: `dress-rehearsal child, ${safeTargetLabel(url)}`,
      },
      server: {
        endpoint: identity.endpoint,
        branch: identity.branch,
        database: identity.database,
        role: identity.role,
        serverVersion: identity.serverVersion,
      },
      transaction: {
        readOnly: true,
        sessionDefaultReadOnly: true,
        isolation: result.isolation,
        endedBy: "rollback",
      },
      scope: {
        schema: "public",
        searchPath: SEARCH_PATH,
        normalization: [...NORMALIZATION],
      },
      categories: result.categories,
    };
    const text = serializeFingerprint(fingerprint);
    const withheld =
      unsafeOutputProblem(text, url) ??
      unsafeOutputProblem(text, ro) ??
      unsavableProblem(text);
    const saveProblem = withheld ?? deps.writeNew(args.fingerprintOut, text);
    if (saveProblem)
      problems.push(`the fingerprint was not saved (${saveProblem})`);
    else
      lines.push(
        `Fingerprint saved: ${args.fingerprintOut} (0600); compare with npm run db:definitions:compare`,
      );
  }
  lines.push(
    problems.length
      ? `NOT MET:\n${problems.map((p) => `  - ${p}`).join("\n")}`
      : `All expectations for stage ${args.stage} met.`,
    "Nothing was written.",
  );
  deps.out(scrub(lines.join("\n"), urls));
  return problems.length ? 1 : 0;
}
