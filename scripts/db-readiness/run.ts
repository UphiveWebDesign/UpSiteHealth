import { safeTargetLabel } from "../../prisma/safety";
import {
  rehearsalServerProblem,
  serverProblem,
  TARGET_SETTINGS_FILES,
  type DatabaseChoice,
  type DatabaseTarget,
} from "../crawl-worker/database";
import { TEST_TARGET_IDENTITY } from "./expected";
import {
  formatText,
  inspect,
  QUERIES,
  unsafeOutputProblem,
  type ReadinessReport,
  type ReadOnlyTx,
  type ServerIdentity,
} from "./report";

/**
 * The readiness report's command line (scripts/db-readiness.ts). The
 * database is chosen exactly as the local crawl worker chooses it
 * (scripts/crawl-worker/database.ts): `test` is the isolated test database
 * from its private settings file, `app` the local app's DATABASE_URL, only
 * when it is the shared manual-testing database or on this machine.
 * Production and anything else are refused before a connection is opened.
 */

export const USAGE = `Usage: npm run db:readiness -- --target=<test|app|rehearsal> [--json] [--settings=<file>]

  --target=test       the isolated integration-test database
                      (TEST_DATABASE_URL in ${TARGET_SETTINGS_FILES.test})
  --target=app        the local app's database (DATABASE_URL in .env): only the
                      shared manual-testing database or a database on this machine
  --target=rehearsal  the owner-verified rehearsal branch
                      (REHEARSAL_DATABASE_URL in ${TARGET_SETTINGS_FILES.rehearsal})
  --json              print the report as JSON
  --settings          read the database settings from another file (not for
                      rehearsal, which has only its own file)

Read-only: one transaction marked READ ONLY, always rolled back.`;

export type ReadinessArgs = {
  target: DatabaseTarget;
  settingsFile: string;
  json: boolean;
};

export function parseReadinessArgs(
  argv: string[],
  resolve: (file: string) => string = (f) => f,
): ReadinessArgs | { error: string } {
  let target: DatabaseTarget | undefined;
  let settingsFile: string | undefined;
  let json = false;
  for (const arg of argv) {
    const [name, value] = arg.split(/=(.*)/s, 2);
    if (
      name === "--target" &&
      (value === "test" || value === "app" || value === "rehearsal")
    )
      target = value;
    else if (name === "--settings" && value) settingsFile = resolve(value);
    else if (arg === "--json") json = true;
    else return { error: `Unknown or incomplete argument: ${arg}` };
  }
  if (!target)
    return {
      error:
        "Choose the database explicitly with --target=test, --target=app or --target=rehearsal.",
    };
  if (target === "rehearsal" && settingsFile)
    return {
      error: `--settings is not accepted for rehearsal: it reads only ${TARGET_SETTINGS_FILES.rehearsal}.`,
    };
  return {
    target,
    settingsFile: settingsFile ?? TARGET_SETTINGS_FILES[target],
    json,
  };
}

/** What run needs from a Prisma client. */
export type ReadinessDb = {
  $transaction<T>(
    fn: (tx: ReadOnlyTx) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
  $disconnect(): Promise<void>;
};

export type ReadinessDeps = {
  readSettings: (
    file: string,
    target: DatabaseTarget,
  ) => Record<string, string> | { error: string };
  chooseDatabase: (
    target: DatabaseTarget,
    settings: Record<string, string | undefined>,
  ) => DatabaseChoice;
  /** Called only after the target is accepted. */
  connect: (choice: Extract<DatabaseChoice, { ok: true }>) => ReadinessDb;
  out: (text: string) => void;
  err: (text: string) => void;
  now?: () => Date;
  resolvePath?: (file: string) => string;
};

/** Thrown to end the transaction with a rollback once the report is read. */
class ReadOnlyRollback extends Error {
  constructor() {
    super("read-only report finished; rolling back");
    this.name = "ReadOnlyRollback";
  }
}

/** A refusal found after connecting: nothing is reported. */
export class ServerRefusal extends Error {}

/**
 * Runs `fn` in one transaction that is read-only before anything is read:
 * the first statement marks it READ ONLY (and repeatable read, so every
 * query sees one snapshot), and the server must confirm that before `fn`
 * runs. The transaction always ends with a rollback, also on success.
 */
export async function inReadOnlyTransaction<T>(
  db: ReadinessDb,
  fn: (tx: ReadOnlyTx, mode: { isolation: string }) => Promise<T>,
): Promise<T> {
  const box: { done: boolean; value?: T } = { done: false };
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(QUERIES.readOnly);
        await tx.$executeRawUnsafe(QUERIES.statementTimeout);
        await tx.$executeRawUnsafe(QUERIES.lockTimeout);
        const [mode] = await tx.$queryRawUnsafe<
          Array<{ readOnly: string; isolation: string }>
        >(QUERIES.transactionMode);
        if (mode?.readOnly !== "on")
          throw new ServerRefusal(
            "the server did not confirm a read-only transaction",
          );
        box.value = await fn(tx, { isolation: mode.isolation });
        box.done = true;
        throw new ReadOnlyRollback();
      },
      { maxWait: 15_000, timeout: 120_000 },
    );
  } catch (error) {
    if (!(error instanceof ReadOnlyRollback)) throw error;
  }
  if (!box.done) throw new Error("the report did not finish");
  return box.value as T;
}

/**
 * Null when a test target's Neon endpoint reports the branch and role
 * recorded for it (TEST_TARGET_IDENTITY), else why not. A local test
 * database reports no endpoint and is pinned by serverProblem instead.
 */
export function testIdentityProblem(server: ServerIdentity): string | null {
  const endpoint = server.endpoint?.trim();
  if (!endpoint) return null;
  const recorded = TEST_TARGET_IDENTITY[endpoint];
  if (!recorded)
    return `no branch and role are recorded for endpoint ${endpoint}`;
  if (server.branch !== recorded.branch)
    return `the server reports Neon branch ${server.branch ?? "(none)"}, not ${recorded.branch}`;
  if (server.role !== recorded.role)
    return `the server reports role ${server.role}, not ${recorded.role}`;
  return null;
}

/**
 * The server proof every database tool runs first, inside its read-only
 * transaction and before reading anything else: the server is the database
 * the URL names. For `test`, the marker and the recorded branch and role;
 * for `app`, the endpoint and database; for `rehearsal`, the recorded
 * endpoint, branch, database and role as the server reports them, and the
 * rehearsal marker unless `requireMarker` is false (the bootstrap
 * preflight). Throws ServerRefusal.
 */
export async function proveTarget(
  tx: ReadOnlyTx,
  choice: Extract<DatabaseChoice, { ok: true }>,
  { requireMarker = true }: { requireMarker?: boolean } = {},
): Promise<ServerIdentity & { markerRows?: unknown[] | null }> {
  const [server] = await tx.$queryRawUnsafe<ServerIdentity[]>(QUERIES.identity);
  if (!server)
    throw new ServerRefusal("the server did not report its identity");
  if (choice.target === "rehearsal") {
    if (!choice.rehearsal)
      throw new ServerRefusal("the rehearsal target has no recorded identity");
    const rows = async (table: string, select: string) => {
      const [{ present }] =
        await tx.$queryRawUnsafe<Array<{ present: boolean }>>(table);
      return present
        ? (await tx.$queryRawUnsafe<Array<{ row: unknown }>>(select)).map(
            (r) => r.row,
          )
        : null;
    };
    const testMarkerRows = await rows(QUERIES.testMarkerTable, QUERIES.marker);
    const markerRows = await rows(
      QUERIES.rehearsalMarkerTable,
      QUERIES.rehearsalMarker,
    );
    const problem = rehearsalServerProblem(
      choice.rehearsal.entry,
      choice.rehearsal.access,
      { ...server, markerRows, testMarkerRows },
      { requireMarker },
    );
    if (problem) throw new ServerRefusal(problem);
    return { ...server, markerRows };
  }
  const markerRows =
    choice.target === "test"
      ? (await tx.$queryRawUnsafe<Array<{ row: unknown }>>(QUERIES.marker)).map(
          (r) => r.row,
        )
      : undefined;
  // The same proof the crawl worker requires before any work: the server is
  // the database the URL names (and, for test, the marker).
  const problem =
    serverProblem(choice, {
      currentDatabase: server.database,
      serverEndpoint: server.endpoint,
      markerRows,
    }) ?? (choice.target === "test" ? testIdentityProblem(server) : null);
  if (problem) throw new ServerRefusal(problem);
  return server;
}

/** The driver's reason, without anything a URL could put in a message. */
export function reason(error: unknown): string {
  const e = error as Error & { code?: unknown };
  const lines = (e?.message ?? "").split("\n").map((l) => l.trim());
  const why =
    lines.filter(Boolean).at(-1) ?? String(e?.code ?? e?.name ?? error);
  return why.replace(/postgres(ql)?:\/\/\S+/gi, "[database URL]");
}

/** Exit codes: 0 report printed, 1 refused or failed, 2 usage. */
export async function runReadiness(
  argv: string[],
  deps: ReadinessDeps,
): Promise<number> {
  const args = parseReadinessArgs(argv, deps.resolvePath);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const refuse = (why: string, connected = false) => {
    deps.err(
      `Refused: ${why} ${connected ? "No report was printed." : "No connection was opened."}`,
    );
    return 1;
  };
  const settings = deps.readSettings(args.settingsFile, args.target);
  if ("error" in settings) return refuse(settings.error);
  const choice = deps.chooseDatabase(args.target, settings);
  if (!choice.ok) return refuse(choice.reason);

  const db = deps.connect(choice);
  let report: ReadinessReport;
  try {
    report = await inReadOnlyTransaction(db, async (tx, mode) => {
      const server = await proveTarget(tx, choice);
      return {
        generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
        target: { name: choice.target, label: safeTargetLabel(choice.url) },
        server: {
          endpoint: server.endpoint || null,
          branch: server.branch || null,
          database: server.database,
          role: server.role,
          serverVersion: server.serverVersion,
        },
        transaction: {
          readOnly: true,
          isolation: mode.isolation,
          endedBy: "rollback",
        },
        ...(await inspect(tx)),
      } satisfies ReadinessReport;
    });
  } catch (error) {
    return refuse(
      error instanceof ServerRefusal
        ? `${error.message}.`
        : `the database could not be read (${reason(error)}).`,
      true,
    );
  } finally {
    await db.$disconnect().catch(() => {});
  }

  const text = args.json ? JSON.stringify(report, null, 2) : formatText(report);
  const unsafe = unsafeOutputProblem(text, choice.url);
  if (unsafe) return refuse(`the report was withheld because ${unsafe}.`, true);
  deps.out(text);
  return 0;
}
