/**
 * Restores a backup made by `npm run db:backup` into a new database on a
 * local PostgreSQL server and proves its rows match the manifest
 * (scripts/db-backup/restore-check.ts; docs/operations/database-backup.md).
 * Never connects to Neon or Supabase; never drops anything.
 *
 *   npm run db:restore-check -- --backup-dir=<folder> --restore-db=upsitehealth_restore_<suffix>
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { runPrismaChild } from "./db-migrate-test/run";
import { NODE_TRUST_FS } from "./db-backup/common";
import { runRestoreCheck } from "./db-backup/restore-check";
import { fsReason } from "./db-readiness/secure-output";

process.umask(0o077);

const isRegular = (file: string) => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};

process.exitCode = await runRestoreCheck(process.argv.slice(2), {
  trust: NODE_TRUST_FS,
  connect: (url) =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        application_name: "upsitehealth-db-restore-check",
      }),
    }),
  run: (file, args, env, limits) =>
    runPrismaChild(
      () =>
        spawn(file, args, {
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      limits,
    ),
  fs: {
    readRegular: (file) => {
      if (!isRegular(file)) return { error: "missing or not a regular file" };
      try {
        return { text: readFileSync(file, "utf8") };
      } catch (error) {
        return { error: fsReason(error) };
      }
    },
    isRegular,
    sha256File: (file) =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(file)
          .on("data", (chunk) => hash.update(chunk))
          .on("error", reject)
          .on("end", () => resolve(hash.digest("hex")));
      }),
  },
  baseEnv: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
