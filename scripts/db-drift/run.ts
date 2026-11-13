import { safeTargetLabel } from "../../prisma/safety";
import {
  type DatabaseChoice,
  type DatabaseTarget,
} from "../crawl-worker/database";
import { type ServerIdentity } from "../db-readiness/report";
import {
  inReadOnlyTransaction,
  proveTarget,
  reason,
  ServerRefusal,
  type ReadinessDb,
  type ReadinessDeps,
} from "../db-readiness/run";

/**
 * The scoped schema drift check (scripts/db-drift.ts): `prisma migrate diff`
 * from one database to prisma/schema.prisma, with the database chosen and
 * proven exactly as the readiness report does it
 * (docs/operations/environment-readiness.md).
 *
 * - The database comes from the target's settings file only
 *   (chooseWorkerDatabase): never from DATABASE_URL or DIRECT_URL in the
 *   shell, which `npm run db:drift` would follow.
 * - Its URL gets `options=-c default_transaction_read_only=on`, so every
 *   session opened with it is read-only by default on the server.
 * - Before the diff, one connection with that same URL proves the server
 *   (endpoint, database, and for `test` the marker, branch and role) and
 *   that the server applied the read-only default. Anything else is
 *   refused and the diff never runs.
 * - The diff runs as a child process with no shell, with every database and
 *   PRISMA_ variable removed and DIRECT_URL / DATABASE_URL set to that URL.
 *   Its output is printed without URLs or the password.
 */

export const USAGE = `Usage: npm run db:drift:scoped -- --target=<test|app|rehearsal>

  --target=test       the isolated integration-test database
  --target=app        the local app's database (DATABASE_URL in .env): only the
                      shared manual-testing database or a database on this machine
  --target=rehearsal  the owner-verified rehearsal branch (read access)

Read-only: prisma migrate diff against prisma/schema.prisma, on sessions the
server makes read-only by default. Exit 0 no drift, 2 drift, 1 refused or
failed.`;

/** The startup option that makes every transaction read-only by default. */
export const READ_ONLY_OPTION = "-c default_transaction_read_only=on";

/** Exactly what `npm run db:drift` runs, minus its target selection. */
export const DIFF_ARGS = [
  "migrate",
  "diff",
  "--from-config-datasource",
  "--to-schema",
  "prisma/schema.prisma",
  "--exit-code",
] as const;

/** The session default, as opposed to the current transaction's mode. */
export const SESSION_DEFAULT_QUERY = `SELECT current_setting('default_transaction_read_only') AS "defaultReadOnly"`;

export function parseDriftArgs(
  argv: string[],
): { target: DatabaseTarget } | { error: string } {
  let target: DatabaseTarget | undefined;
  for (const arg of argv) {
    const [name, value] = arg.split(/=(.*)/s, 2);
    if (
      name === "--target" &&
      (value === "test" || value === "app" || value === "rehearsal")
    )
      target = value;
    else return { error: `Unknown or incomplete argument: ${arg}` };
  }
  return target
    ? { target }
    : {
        error:
          "Choose the database explicitly with --target=test, --target=app or --target=rehearsal.",
      };
}

/** `url` with the read-only startup option added. */
export function readOnlyUrl(url: string): string | { error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: "the database URL cannot be read" };
  }
  if (u.searchParams.has("options"))
    return { error: "the database URL already sets options" };
  u.searchParams.set("options", READ_ONLY_OPTION);
  // URLSearchParams writes a space as "+"; a literal "+" would be "%2B".
  u.search = u.search.replace(/\+/g, "%20");
  return u.toString();
}

/** The child's environment: no inherited database or Prisma settings. */
export function childEnv(
  base: Record<string, string | undefined>,
  url: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base))
    if (
      v !== undefined &&
      !/^(DATABASE_URL|DIRECT_URL|TEST_DATABASE_URL|SHADOW_DATABASE_URL|REHEARSAL_DATABASE_URL|REHEARSAL_WRITE_DATABASE_URL|UPSITEHEALTH_REHEARSAL_ATTESTATION)$/.test(
        k,
      ) &&
      !k.startsWith("PRISMA_")
    )
      env[k] = v;
  env.DIRECT_URL = url;
  env.DATABASE_URL = url;
  return env;
}

/** `text` without database URLs or the password of either URL. */
export function scrub(text: string, urls: string[]): string {
  let out = text.replace(/postgres(ql)?:\/\/\S+/gi, "[database URL]");
  for (const url of urls) {
    let password = "";
    try {
      password = decodeURIComponent(new URL(url).password);
    } catch {
      continue;
    }
    if (password) out = out.split(password).join("[password]");
  }
  return out;
}

export type DiffResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type DriftDeps = Pick<
  ReadinessDeps,
  "readSettings" | "chooseDatabase" | "out" | "err"
> & {
  /** The settings file for a target (DEFAULT_ENV_FILES). */
  settingsFile: (target: DatabaseTarget) => string;
  /** Opens the identity-check connection with the read-only URL. */
  connect: (url: string) => ReadinessDb;
  /** Runs `prisma` with DIFF_ARGS and `env`. */
  diff: (env: Record<string, string>) => Promise<DiffResult>;
  baseEnv: Record<string, string | undefined>;
};

/** Exit codes: 0 no drift, 2 drift, 1 refused or failed, 2 usage error. */
export async function runDrift(
  argv: string[],
  deps: DriftDeps,
): Promise<number> {
  const args = parseDriftArgs(argv);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const refuse = (why: string, connected = false) => {
    deps.err(
      `Refused: ${why} ${connected ? "The diff was not run." : "No connection was opened."}`,
    );
    return 1;
  };
  const settings = deps.readSettings(
    deps.settingsFile(args.target),
    args.target,
  );
  if ("error" in settings) return refuse(settings.error);
  const choice = deps.chooseDatabase(args.target, settings);
  if (!choice.ok) return refuse(choice.reason);
  const url = readOnlyUrl(choice.url);
  if (typeof url !== "string") return refuse(`${url.error}.`);

  const server = await proveServer(deps.connect(url), choice).catch(
    (error: unknown) =>
      error instanceof ServerRefusal
        ? { refused: `${error.message}.` }
        : { refused: `the database could not be read (${reason(error)}).` },
  );
  if ("refused" in server) return refuse(server.refused, true);

  const s = server.identity;
  deps.out(
    [
      `Schema drift (read-only), target ${choice.target}, ${safeTargetLabel(choice.url)}`,
      `Server: endpoint ${s.endpoint ?? "(not reported)"}, branch ${s.branch ?? "(not reported)"}, database ${s.database}, role ${s.role}, PostgreSQL ${s.serverVersion}`,
      `Sessions: read-only by default (default_transaction_read_only = on, confirmed by the server on the identity check)`,
      `Diff: prisma ${DIFF_ARGS.join(" ")}`,
      "",
    ].join("\n"),
  );

  let result: DiffResult;
  try {
    result = await deps.diff(childEnv(deps.baseEnv, url));
  } catch (error) {
    deps.err(`The diff could not be run (${reason(error)}).`);
    return 1;
  }
  const clean = (t: string) => scrub(t, [choice.url, url]).trimEnd();
  if (result.stdout.trim()) deps.out(clean(result.stdout));
  if (result.stderr.trim()) deps.err(clean(result.stderr));
  if (result.status === 0) {
    deps.out("\nNo drift: the database matches prisma/schema.prisma.");
    return 0;
  }
  if (result.status === 2) {
    deps.out("\nDrift: the database differs from prisma/schema.prisma.");
    return 2;
  }
  deps.err(`The diff failed (exit ${result.status ?? "signal"}).`);
  return 1;
}

/**
 * The readiness report's identity proof, plus the session default, in one
 * read-only transaction that is rolled back; always disconnects.
 */
async function proveServer(
  db: ReadinessDb,
  choice: Extract<DatabaseChoice, { ok: true }>,
): Promise<{ identity: ServerIdentity }> {
  try {
    return await inReadOnlyTransaction(db, async (tx) => {
      const identity: ServerIdentity = await proveTarget(tx, choice);
      const [mode] = await tx.$queryRawUnsafe<
        Array<{ defaultReadOnly: string }>
      >(SESSION_DEFAULT_QUERY);
      if (mode?.defaultReadOnly !== "on")
        throw new ServerRefusal(
          "the server did not apply default_transaction_read_only from the connection options",
        );
      return { identity };
    });
  } finally {
    await db.$disconnect().catch(() => {});
  }
}
