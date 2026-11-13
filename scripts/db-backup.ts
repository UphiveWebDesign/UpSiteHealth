/**
 * A verified logical backup of the shared manual-testing database
 * (scripts/db-backup/run.ts; docs/operations/database-backup.md). Read-only
 * on the database; each run needs its own approval.
 *
 *   npm run db:backup -- --target=app --out-dir=<absolute new folder>
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { sha256 } from "../prisma/safety";
import {
  chooseWorkerDatabase,
  readSettings,
  TARGET_SETTINGS_FILES,
} from "./crawl-worker/database";
import { runPrismaChild } from "./db-migrate-test/run";
import { createSecretFile, NODE_TRUST_FS } from "./db-backup/common";
import { runBackup } from "./db-backup/run";
import { collectDefinitions, stableJson } from "./db-readiness/definitions";
import { fsReason, writeNewFile } from "./db-readiness/secure-output";

// Every file this process or pg_dump creates is private to this user.
process.umask(0o077);

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

process.exitCode = await runBackup(process.argv.slice(2), {
  readSettings: () => readSettings(TARGET_SETTINGS_FILES.app, "app"),
  chooseApp: (settings) => chooseWorkerDatabase("app", settings),
  connect: (url) =>
    new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        max: 1,
        application_name: "upsitehealth-db-backup",
      }),
    }),
  definitionsDigest: async (tx) =>
    sha256(stableJson(await collectDefinitions(tx))),
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
    newDirProblem: (dir) => {
      try {
        lstatSync(dir);
        return `${dir} already exists; a backup never reuses a folder`;
      } catch (error) {
        if ((error as { code?: unknown })?.code !== "ENOENT")
          return `${dir} cannot be checked (${fsReason(error)})`;
      }
      try {
        if (!statSync(path.dirname(dir)).isDirectory())
          return `${path.dirname(dir)} is not a folder`;
      } catch (error) {
        return `${path.dirname(dir)} cannot be used (${fsReason(error)})`;
      }
      return null;
    },
    makeDir: (dir) => {
      try {
        mkdirSync(dir, { mode: 0o700 });
        return { ok: true };
      } catch (error) {
        return { error: `${dir} could not be created (${fsReason(error)})` };
      }
    },
    securePrivateFile: (file) => {
      try {
        const st = lstatSync(file);
        if (!st.isFile()) return { error: "it is not a regular file" };
        chmodSync(file, 0o600);
        return { bytes: st.size };
      } catch (error) {
        return { error: fsReason(error) };
      }
    },
    sha256File,
    writeNew: (file, text) => {
      const r = writeNewFile(file, text);
      return r.ok ? { ok: true } : { error: r.error };
    },
    makeSecretFile: (text) => createSecretFile(text),
  },
  trust: NODE_TRUST_FS,
  baseEnv: process.env,
  now: () => new Date(),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
