import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { appUrlsFromEnvFiles, prismaCliDecision } from "./prisma/safety";

// Prisma 7 no longer loads .env automatically. Load the repository's own
// .env (next to this file), wherever the CLI is run from; values already in
// the environment win.
const repoRoot = fileURLToPath(new URL("./", import.meta.url));
const envFile = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Migrations and introspection need a direct (non-transaction-pooled) connection.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";

// Prisma loads this file in the CLI process, so process.argv is the command.
// The original migration files were lost, so schema-changing commands against
// production could try to reset it; hosted databases other than the approved
// test database are refused too, and so is any hosted target on the server of
// a database URL written in .env, even commented out (prisma/safety.ts,
// docs/operations/testing.md). Read-only commands are not blocked, except
// Prisma Studio (which can edit rows) against the shared manual-testing
// database.
const decision = prismaCliDecision(process.argv.slice(2), process.env, url, {
  appUrls: appUrlsFromEnvFiles(repoRoot),
});
if (!decision.allow) throw new Error(decision.reason);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url },
});
