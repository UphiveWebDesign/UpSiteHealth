/**
 * Reconciles the shared integration-tests database, one approved operation
 * at a time, with direct `pg` (scripts/db-reconcile-shared/run.ts;
 * docs/operations/shared-reconciliation-runbook.md). Every write is refused
 * until SNAPSHOT is recorded by a reviewed change.
 *
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/ts-loader/register.mjs scripts/db-reconcile-shared.ts plan
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import pg from "pg";
// Side-effect free: constants and pure functions (REPO_ROOT is computed from
// that module's own location); scripts/crawl-worker/database imports it too.
import { REPO_ROOT } from "../tests/integration/test-db-guard";
import {
  chooseWorkerDatabase,
  readSettings,
  TARGET_SETTINGS_FILES,
} from "./crawl-worker/database";
import { fsReason } from "./db-readiness/secure-output";
import { haltStore } from "./db-reconcile-shared/halt";
import { runReconcile } from "./db-reconcile-shared/run";

/**
 * Where a failure after the first write statement is recorded: two
 * directories, so one unusable directory alone cannot lose it. Both must be
 * creatable before any command runs; either file present halts.
 */
const HALT_FILES = [
  path.join(homedir(), ".config/upsitehealth/reconcile-shared.halt"),
  path.join(REPO_ROOT, ".reconcile-shared.halt"),
];

/** A repository file, only if it resolves inside the repository. */
function readRepoFile(relPath: string): string | { error: string } {
  try {
    const real = realpathSync(path.join(REPO_ROOT, relPath));
    if (!real.startsWith(`${realpathSync(REPO_ROOT)}${path.sep}`))
      return { error: "it resolves outside the repository" };
    return readFileSync(real, "utf8");
  } catch (error) {
    return { error: fsReason(error) };
  }
}

process.exitCode = await runReconcile(process.argv.slice(2), {
  readSettings: () => readSettings(TARGET_SETTINGS_FILES.app, "app"),
  chooseApp: (settings) => chooseWorkerDatabase("app", settings),
  connect: async (url) => {
    const client = new pg.Client({
      connectionString: url,
      application_name: "upsitehealth-reconcile-shared",
    });
    await client.connect();
    return {
      // Without values: the simple protocol (a migration's statements go as
      // one, and pg returns an array of results). With values: one bound
      // statement.
      query: async (text, values) => {
        const result = values
          ? await client.query(text, values)
          : await client.query(text);
        return { rows: Array.isArray(result) ? [] : result.rows };
      },
      end: () => client.end(),
    };
  },
  readFile: readRepoFile,
  prismaVersion: () => {
    const text = readRepoFile("node_modules/prisma/package.json");
    if (typeof text !== "string") return text;
    try {
      const version: unknown = JSON.parse(text).version;
      return typeof version === "string"
        ? version
        : { error: "it has no version" };
    } catch {
      return { error: "it is not valid JSON" };
    }
  },
  halt: haltStore(HALT_FILES),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
