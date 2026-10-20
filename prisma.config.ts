import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env automatically.
if (existsSync(".env")) process.loadEnvFile(".env");

const PRODUCTION_PROJECT_REF = "xdaxegotsoumwwxjlbnl";

// Migrations and introspection need a direct (non-transaction-pooled) connection.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";

// The original migration files were lost, so schema-changing commands against
// production could try to reset it. Refuse them unless explicitly overridden.
const args = process.argv.slice(2).join(" ");
const writesSchema =
  /\b(migrate (dev|reset|deploy|resolve)|db (push|execute|seed))\b/.test(args);

if (
  writesSchema &&
  url.includes(PRODUCTION_PROJECT_REF) &&
  process.env.ALLOW_PRODUCTION_SCHEMA_CHANGES !== "yes"
) {
  throw new Error(
    `Refusing "prisma ${args}" against the production database. ` +
      "See recovery/RECOVERY.md.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url },
});
