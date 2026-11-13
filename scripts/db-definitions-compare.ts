/**
 * Compares two database definitions fingerprints offline: two local JSON
 * files in, differences out. Reads no settings or credentials and opens no
 * connection. Usage: docs/operations/database-definitions-fingerprint.md.
 *
 *   npm run db:definitions:compare -- itest-ci.json shared.json
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../tests/integration/test-db-guard";
import { runCompare } from "./db-readiness/compare-definitions";

process.exitCode = runCompare(process.argv.slice(2), {
  readFile: (file) => readFileSync(path.resolve(file), "utf8"),
  prismaSchema: () =>
    readFileSync(path.join(REPO_ROOT, "prisma/schema.prisma"), "utf8"),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
