/**
 * Database readiness report: which of migrations 0–4 a database has, what
 * the Stage 2 capability checks say, and the counts M2 depends on. Read-only
 * (one READ ONLY transaction, always rolled back); counts, booleans and
 * names only. Usage and the decisions it informs:
 * docs/operations/environment-readiness.md.
 *
 *   npm run db:readiness -- --target=test
 */
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { chooseDatabase, readSettings } from "./crawl-worker/database";
import { runReadiness } from "./db-readiness/run";

// stdout carries only the report (--json can be piped): the capability
// checks' log lines go to stderr with the warnings and errors.
console.log = (...args: unknown[]) => console.error(...args);

process.exitCode = await runReadiness(process.argv.slice(2), {
  readSettings,
  chooseDatabase: (target, settings) => chooseDatabase(target, settings),
  connect: (choice) =>
    new PrismaClient({
      // One connection: nothing runs in parallel, and a `prisma dev`
      // (PGlite) database serves one session at a time.
      adapter: new PrismaPg({
        connectionString: choice.url,
        max: 1,
        application_name: "upsitehealth-db-readiness",
      }),
    }),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  resolvePath: (file) => path.resolve(file),
});
