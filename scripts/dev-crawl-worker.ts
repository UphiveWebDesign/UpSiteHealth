/**
 * Local development crawl worker: keeps processing crawls that are already
 * stored in the chosen database, which locally nothing else does after the
 * Start crawl kickoff's 50 seconds. It runs the crawl stage only, never the
 * cron pipeline. Not a replacement for production scheduling.
 * Usage and safety rules: docs/operations/crawl-worker.md.
 *
 *   npm run dev:crawls -- --target=test --check
 */
import { hostname } from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { ACTIVE_CRAWL_STATUSES } from "@/lib/crawler/engine";
import { log } from "@/lib/log";
import { crawlStage } from "./crawl-worker/crawl";
import {
  chooseWorkerDatabase,
  parseWorkerArgs,
  readSettings,
  serverProblem,
  USAGE,
} from "./crawl-worker/database";
import { runCrawlWorker } from "./crawl-worker/loop";
import { TEST_DB_MARKER } from "../tests/integration/test-db-guard";

function refuse(reason: string, error?: unknown): never {
  log.error("dev_crawl_worker.refused", { reason }, error);
  process.exit(1);
}

const args = parseWorkerArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${args.error}\n\n${USAGE}`);
  process.exit(2);
}
const settings = readSettings(args.settingsFile, args.target);
if ("error" in settings) refuse(settings.error);
const choice = chooseWorkerDatabase(args.target, settings);
if (!choice.ok) refuse(choice.reason);

const db = new PrismaClient({
  // `prisma dev` (PGlite) serves one session at a time (tests/integration/helpers.ts).
  adapter: new PrismaPg({
    connectionString: choice.url,
    ...(choice.local ? { max: 1 } : {}),
  }),
});

try {
  // Read-only: prove the server is the database the URL names before any work.
  const [server] = await db.$queryRawUnsafe<
    Array<{ db: string; ep: string | null }>
  >(
    "SELECT current_database() AS db, current_setting('neon.endpoint_id', true) AS ep",
  );
  const markerRows =
    choice.target === "test"
      ? (
          await db.$queryRawUnsafe<Array<{ row: unknown }>>(
            `SELECT to_jsonb(m) AS row FROM "${TEST_DB_MARKER.schema}"."${TEST_DB_MARKER.table}" m`,
          )
        ).map((r) => r.row)
      : undefined;
  const problem = serverProblem(choice, {
    currentDatabase: server.db,
    serverEndpoint: server.ep,
    markerRows,
  });
  if (problem) throw new Error(problem);
} catch (error) {
  await db.$disconnect();
  // Prisma puts the driver's reason on the last line of its message, which
  // can also be empty: then the error code or name. The logger redacts the
  // error it is given.
  const e = error as Error & { code?: unknown };
  const lines = (e?.message ?? "").split("\n").map((l) => l.trim());
  const why =
    lines.filter(Boolean).at(-1) ?? String(e?.code ?? e?.name ?? error);
  refuse(`the database could not be verified (${why})`, error);
}

const waiting = await db.crawlRun.count({
  where: { status: { in: [...ACTIVE_CRAWL_STATUSES] } },
});
log.info("dev_crawl_worker.database", {
  target: choice.target,
  database: choice.label,
  crawlsQueuedOrRunning: waiting,
  runConcurrency: args.runs,
});

if (args.check) {
  await db.$disconnect();
  process.exit(0);
}

const controller = new AbortController();
let signals = 0;
const onSignal = (name: NodeJS.Signals) => {
  if (++signals === 1) {
    // The current burst finishes: processCrawls checks its deadline between
    // batches, so the batch in progress (up to 10 pages) completes first.
    log.info("dev_crawl_worker.shutdown_requested", { signal: name });
    controller.abort();
    return;
  }
  // A second signal exits at once; pages left mid-fetch keep their lease and
  // are retried by the next crawl worker (recoverStalePages).
  log.warn("dev_crawl_worker.forced_exit", { signal: name });
  process.exit(130);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

let exitCode = 0;
try {
  await runCrawlWorker({
    ...crawlStage(db, undefined, {
      runConcurrency: args.runs,
      workerId: `${hostname()}:${process.pid}`,
    }),
    signal: controller.signal,
    log,
  });
} catch (error) {
  log.error("dev_crawl_worker.crashed", {}, error);
  exitCode = 1;
} finally {
  await db.$disconnect();
}
process.exit(exitCode);
