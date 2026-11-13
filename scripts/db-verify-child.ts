/**
 * Read-only verification of a disposable dress-rehearsal child branch
 * (scripts/db-verify-child/run.ts; docs/operations/shared-reconciliation-runbook.md,
 * section 6). Each run needs its own approval.
 *
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/ts-loader/register.mjs scripts/db-verify-child.ts \
 *     --expect-branch=<br-…> --expect-endpoint=<ep-…> --expect-stage=<0|8> \
 *     [--fingerprint-out=<absolute path>]
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { appUrlsFromEnvFiles } from "../tests/integration/test-db-guard";
import { readSettings } from "./crawl-worker/database";
import { collectDefinitions } from "./db-readiness/definitions";
import { inspect, type ReadOnlyTx } from "./db-readiness/report";
import { outputPathProblem, writeNewFile } from "./db-readiness/secure-output";
import { readState, type SqlSession } from "./db-reconcile-shared/run";
import {
  CHILD_SETTINGS_FILE,
  IDENTITY_QUERY,
  runVerifyChild,
  type ChildIdentity,
} from "./db-verify-child/run";

// stdout carries only the report: the capability checks' log lines go to
// stderr with the warnings and errors.
console.log = (...args: unknown[]) => console.error(...args);

/** The reconciliation's reader over the read-only transaction. */
const asSession = (tx: ReadOnlyTx): SqlSession => ({
  query: async (text) => ({
    rows: await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(text),
  }),
  end: async () => {},
});

process.exitCode = await runVerifyChild(process.argv.slice(2), {
  // "rehearsal" makes readSettings require mode 0600.
  readSettings: () => readSettings(CHILD_SETTINGS_FILE, "rehearsal"),
  appUrls: () => [
    process.env.DATABASE_URL ?? "",
    process.env.DIRECT_URL ?? "",
    ...appUrlsFromEnvFiles(),
  ],
  connect: (url) =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        application_name: "upsitehealth-db-verify-child",
      }),
    }),
  readIdentity: async (tx) =>
    (await tx.$queryRawUnsafe<ChildIdentity[]>(IDENTITY_QUERY))[0],
  readState: (tx) => readState(asSession(tx)),
  inspect: (tx) => inspect(tx),
  collect: (tx) => collectDefinitions(tx),
  outputProblem: (file) => outputPathProblem(file),
  writeNew: (file, text) => {
    const saved = writeNewFile(file, text);
    return saved.ok ? null : saved.error;
  },
  now: () => new Date(),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
