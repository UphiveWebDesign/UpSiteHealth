import { safeTargetLabel } from "../../prisma/safety";
import { type DatabaseTarget } from "../crawl-worker/database";
import {
  readOnlyUrl,
  scrub,
  SESSION_DEFAULT_QUERY,
  type DriftDeps,
} from "../db-drift/run";
import {
  CATEGORIES,
  CollectionError,
  FINGERPRINT_FORMAT,
  FINGERPRINT_VERSION,
  NORMALIZATION,
  parseFingerprint,
  SEARCH_PATH,
  serializeFingerprint,
  collectDefinitions,
  type Fingerprint,
} from "./definitions";
import { unsafeOutputProblem } from "./report";
import {
  inReadOnlyTransaction,
  proveTarget,
  reason,
  ServerRefusal,
} from "./run";
import {
  outputPathProblem,
  writeNewFile,
  type OutputFs,
} from "./secure-output";

/**
 * Collecting a definitions fingerprint (scripts/db-definitions.ts;
 * docs/operations/database-definitions-fingerprint.md). The database is
 * chosen, refused and proven exactly as the scoped drift check does it
 * (settings file only, read-only startup option, endpoint, database and for
 * `test` the marker, branch and role, then the session default), and
 * everything is read in the readiness report's read-only transaction, which
 * is always rolled back. The fingerprint is checked (it must read back as a
 * fingerprint with every category collected, and carry no URL or password)
 * and saved as a new 0600 file (secure-output.ts); it is never printed.
 * Comparing two saved fingerprints is offline (compare-definitions.ts).
 */

export const COLLECT_USAGE = `Usage: npm run db:definitions -- --target=<test|app|rehearsal> --out=<absolute path>

  --target=test       the isolated integration-test database (itest-ci)
  --target=app        the local app's database (DATABASE_URL in .env): only the
                      shared manual-testing database or a database on this machine
  --target=rehearsal  the owner-verified rehearsal branch (read access)
  --out           the new file to save the fingerprint in: an absolute path
                  in an existing folder; an existing file is never replaced

Read-only: one READ ONLY transaction, always rolled back. Each collection
needs its own approval. Exit 0 saved, 1 refused or failed, 2 usage.`;

export type DefinitionsArgs = { target: DatabaseTarget; out: string };

/** How an unaccepted argument is named in an error, without its value. */
function argName(arg: string): string {
  if (!arg.startsWith("--")) return "(a value without a --flag)";
  const name = arg.split("=", 1)[0];
  return /^--[a-z][a-z-]{0,30}$/.test(name) ? name : "(an unrecognised --flag)";
}

/** Exactly --target and --out, each once; nothing else. */
export function parseDefinitionsArgs(
  argv: string[],
): DefinitionsArgs | { error: string } {
  const seen = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--(target|out)=(.*)$/s.exec(arg);
    // Only the flag's name is echoed: a value could be a database URL.
    if (!m) return { error: `Unknown or malformed argument: ${argName(arg)}` };
    const [, name, value] = m;
    if (seen.has(name)) return { error: `--${name} is given more than once.` };
    if (!value) return { error: `--${name} needs a value.` };
    seen.set(name, value);
  }
  const target = seen.get("target");
  const out = seen.get("out");
  if (!target)
    return {
      error:
        "Choose the database explicitly with --target=test or --target=app.",
    };
  if (target !== "test" && target !== "app" && target !== "rehearsal")
    return {
      error:
        "Unknown target: use --target=test (itest-ci), --target=app or --target=rehearsal.",
    };
  if (!out)
    return { error: "Name the new output file with --out=<absolute path>." };
  return { target, out };
}

/**
 * Null when `text` is a fingerprint fit to save: it reads back as one and
 * every category was collected. Else why not.
 */
export function unsavableProblem(text: string): string | null {
  const parsed = parseFingerprint(text);
  if ("error" in parsed) return parsed.error;
  const missing = CATEGORIES.filter(
    (c) => !parsed.fingerprint.categories[c].collected,
  );
  return missing.length
    ? `categories not collected: ${missing.join(", ")}`
    : null;
}

export type DefinitionsDeps = Pick<
  DriftDeps,
  "readSettings" | "chooseDatabase" | "settingsFile" | "connect" | "out" | "err"
> & {
  /** The file system the output is checked and written with. */
  fs?: OutputFs;
  now?: () => Date;
};

/** Exit codes: 0 fingerprint saved, 1 refused or failed, 2 usage. */
export async function runDefinitions(
  argv: string[],
  deps: DefinitionsDeps,
): Promise<number> {
  const args = parseDefinitionsArgs(argv);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${COLLECT_USAGE}`);
    return 2;
  }
  const refuse = (why: string, connected = false) => {
    deps.err(
      `Refused: ${why} ${connected ? "No fingerprint was saved." : "No connection was opened."}`,
    );
    return 1;
  };
  // The output is checked first: a run that could not save opens nothing.
  const outProblem = outputPathProblem(args.out, deps.fs);
  if (outProblem) return refuse(`${outProblem}.`);
  const settings = deps.readSettings(
    deps.settingsFile(args.target),
    args.target,
  );
  if ("error" in settings) return refuse(settings.error);
  const choice = deps.chooseDatabase(args.target, settings);
  if (!choice.ok) return refuse(choice.reason);
  const url = readOnlyUrl(choice.url);
  if (typeof url !== "string") return refuse(`${url.error}.`);

  const db = deps.connect(url);
  let fingerprint: Fingerprint;
  try {
    fingerprint = await inReadOnlyTransaction(db, async (tx, mode) => {
      const server = await proveTarget(tx, choice);
      const [session] = await tx.$queryRawUnsafe<
        Array<{ defaultReadOnly: string }>
      >(SESSION_DEFAULT_QUERY);
      if (session?.defaultReadOnly !== "on")
        throw new ServerRefusal(
          "the server did not apply default_transaction_read_only from the connection options",
        );
      return {
        format: FINGERPRINT_FORMAT,
        version: FINGERPRINT_VERSION,
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
          sessionDefaultReadOnly: true,
          isolation: mode.isolation,
          endedBy: "rollback",
        },
        scope: {
          schema: "public",
          searchPath: SEARCH_PATH,
          normalization: [...NORMALIZATION],
        },
        categories: await collectDefinitions(tx),
      } satisfies Fingerprint;
    });
  } catch (error) {
    const why =
      error instanceof ServerRefusal
        ? `${error.message}.`
        : error instanceof CollectionError
          ? `the collection failed (${error.message}).`
          : `the database could not be read (${reason(error)}).`;
    return refuse(scrub(why, [choice.url, url]), true);
  } finally {
    await db.$disconnect().catch(() => {});
  }

  const text = serializeFingerprint(fingerprint);
  const problem =
    unsafeOutputProblem(text, choice.url) ??
    unsafeOutputProblem(text, url) ??
    unsavableProblem(text);
  if (problem)
    return refuse(`the fingerprint was withheld because ${problem}.`, true);
  const saved = writeNewFile(args.out, text, deps.fs);
  if (!saved.ok) {
    deps.err(
      `Failed: ${saved.error}. No fingerprint was saved at ${args.out}.${saved.leftover ? ` A temporary file could not be removed: ${saved.leftover}` : ""}`,
    );
    return 1;
  }
  if (saved.leftover)
    deps.err(`Note: a temporary file could not be removed: ${saved.leftover}`);
  deps.out(
    [
      `Definitions fingerprint collected (read-only, target ${args.target}).`,
      `Saved: ${args.out} (mode 0600)`,
      `Format: ${FINGERPRINT_FORMAT} version ${FINGERPRINT_VERSION}`,
      `Complete: all ${CATEGORIES.length} categories collected`,
    ].join("\n"),
  );
  return 0;
}
