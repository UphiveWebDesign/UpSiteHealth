/**
 * Applies the one approved migration to the integration-test database
 * (itest-ci) with `prisma migrate deploy`, after a read-only proof of the
 * live server and its migration history, and checks it afterwards
 * (scripts/db-migrate-test/run.ts). Each run needs its own approval.
 *
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/ts-loader/register.mjs scripts/db-migrate-test.ts \
 *     --migration=<name> --sha256=<hash> --confirm-branch=<br-…>
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
// Side-effect free: constants and pure functions (REPO_ROOT is computed from
// that module's own location); scripts/crawl-worker/database imports it too.
import { REPO_ROOT } from "../tests/integration/test-db-guard";
import {
  chooseWorkerDatabase,
  readSettings,
  TARGET_SETTINGS_FILES,
} from "./crawl-worker/database";
import { fsReason } from "./db-readiness/secure-output";
import {
  NODE_RUNTIME_FS,
  PRISMA_LIMITS,
  runMigrateTest,
  runPrismaChild,
  trustedNodeDir,
} from "./db-migrate-test/run";

process.exitCode = await runMigrateTest(process.argv.slice(2), {
  readSettings: () => readSettings(TARGET_SETTINGS_FILES.test, "test"),
  chooseTest: (settings) => chooseWorkerDatabase("test", settings),
  connect: (url) =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        application_name: "upsitehealth-db-migrate-test",
      }),
    }),
  prisma: (args, env) =>
    runPrismaChild(
      () =>
        spawn(path.join(REPO_ROOT, "node_modules/.bin/prisma"), args, {
          cwd: REPO_ROOT,
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      PRISMA_LIMITS,
    ),
  nodeRuntime: () => trustedNodeDir(process.execPath, NODE_RUNTIME_FS),
  migrations: () => {
    try {
      const dir = path.join(REPO_ROOT, "prisma/migrations");
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({
          name: d.name,
          text: readFileSync(path.join(dir, d.name, "migration.sql"), "utf8"),
        }));
    } catch (error) {
      return { error: fsReason(error) };
    }
  },
  baseEnv: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
