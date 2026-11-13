/**
 * Scoped schema drift check: `prisma migrate diff` from one database to
 * prisma/schema.prisma, with the database chosen and proven as the
 * readiness report does it, on sessions the server makes read-only. Unlike
 * `npm run db:drift`, a DATABASE_URL or DIRECT_URL in the shell cannot pick
 * the database. Usage: docs/operations/environment-readiness.md.
 *
 *   npm run db:drift:scoped -- --target=app
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { REPO_ROOT } from "../tests/integration/test-db-guard";
import {
  chooseDatabase,
  readSettings,
  TARGET_SETTINGS_FILES,
} from "./crawl-worker/database";
import { DIFF_ARGS, runDrift, type DiffResult } from "./db-drift/run";

process.exitCode = await runDrift(process.argv.slice(2), {
  readSettings,
  chooseDatabase: (target, settings) => chooseDatabase(target, settings),
  settingsFile: (target) => TARGET_SETTINGS_FILES[target],
  connect: (url) =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        application_name: "upsitehealth-db-drift",
      }),
    }),
  diff: (env) =>
    new Promise<DiffResult>((resolve, reject) => {
      const child = spawn(
        path.join(REPO_ROOT, "node_modules/.bin/prisma"),
        [...DIFF_ARGS],
        {
          cwd: REPO_ROOT,
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    }),
  baseEnv: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
