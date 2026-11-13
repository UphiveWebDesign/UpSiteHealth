/**
 * The rehearsal branch's bootstrap preflight, migration status, and its only
 * write path (docs/operations/rehearsal-target.md). Every write needs the
 * exact branch ID and the approved SHA-256 of what it runs, and a fresh
 * read-only proof of the live branch first.
 *
 *   npm run db:rehearsal -- preflight
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { REHEARSAL_ATTESTATION_DIR } from "../prisma/safety";
import { REPO_ROOT } from "../tests/integration/test-db-guard";
import {
  chooseRehearsalDatabase,
  readSettings,
  TARGET_SETTINGS_FILES,
} from "./crawl-worker/database";
import type { DiffResult } from "./db-drift/run";
import { fsReason, writeNewFile } from "./db-readiness/secure-output";
import { reviewedSqlDir, runRehearsal } from "./db-rehearsal/run";

process.exitCode = await runRehearsal(process.argv.slice(2), {
  readSettings: () =>
    readSettings(TARGET_SETTINGS_FILES.rehearsal, "rehearsal"),
  chooseRehearsal: (settings, access) =>
    chooseRehearsalDatabase(settings, access),
  connect: (url) =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        application_name: "upsitehealth-db-rehearsal",
      }),
    }),
  prisma: (args, env) =>
    new Promise<DiffResult>((resolve, reject) => {
      const child = spawn(
        path.join(REPO_ROOT, "node_modules/.bin/prisma"),
        args,
        {
          cwd: REPO_ROOT,
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 600_000,
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
  repoRoot: REPO_ROOT,
  migrations: () => {
    const dir = path.join(REPO_ROOT, "prisma/migrations");
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        name: d.name,
        text: readFileSync(path.join(dir, d.name, "migration.sql"), "utf8"),
      }));
  },
  readSqlFile: (file) => {
    try {
      const dir = realpathSync(reviewedSqlDir(REPO_ROOT));
      const abs = path.resolve(file);
      if (!lstatSync(abs).isFile())
        return { error: `${file} is not a regular file` };
      const real = realpathSync(abs);
      if (path.dirname(real) !== dir || !real.endsWith(".sql"))
        return {
          error:
            "reviewed SQL must be a .sql file directly in prisma/rehearsal/",
        };
      return { path: real, text: readFileSync(real, "utf8") };
    } catch (error) {
      return { error: `${file} cannot be read (${fsReason(error)})` };
    }
  },
  writeAttestation: (att) => {
    try {
      mkdirSync(REHEARSAL_ATTESTATION_DIR, { recursive: true, mode: 0o700 });
      const st = lstatSync(REHEARSAL_ATTESTATION_DIR);
      if (!st.isDirectory() || (st.mode & 0o077) !== 0)
        return "its folder must be a private directory (chmod 700)";
    } catch (error) {
      return fsReason(error);
    }
    const saved = writeNewFile(
      path.join(REHEARSAL_ATTESTATION_DIR, `${att.nonce}.json`),
      JSON.stringify(att),
    );
    return saved.ok ? null : saved.error;
  },
  removeAttestation: (nonce) => {
    try {
      unlinkSync(path.join(REHEARSAL_ATTESTATION_DIR, `${nonce}.json`));
    } catch {
      // Already gone; it expires within minutes either way.
    }
  },
  newNonce: () => randomBytes(16).toString("hex"),
  now: () => Date.now(),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
