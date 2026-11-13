/**
 * Database definitions fingerprint: one database's CHECKs, triggers,
 * functions, RLS and policies, indexes and other unmodelled objects in
 * schema `public`, saved as a new 0600 JSON file. Read-only (one READ ONLY
 * transaction, always rolled back), with the database chosen and proven as
 * `npm run db:drift:scoped` does it. Each collection needs its own approval.
 * Usage: docs/operations/database-definitions-fingerprint.md.
 *
 *   npm run db:definitions -- --target=test --out=/abs/path/itest-ci.json
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  chooseDatabase,
  readSettings,
  TARGET_SETTINGS_FILES,
} from "./crawl-worker/database";
import { runDefinitions } from "./db-readiness/definitions-run";

process.exitCode = await runDefinitions(process.argv.slice(2), {
  readSettings,
  chooseDatabase: (target, settings) => chooseDatabase(target, settings),
  settingsFile: (target) => TARGET_SETTINGS_FILES[target],
  connect: (url) =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        application_name: "upsitehealth-db-definitions",
      }),
    }),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
