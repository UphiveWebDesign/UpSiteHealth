// `npm run dev:with-crawls`: the local app and the crawl-only worker together,
// so crawls started in the app keep going (locally nothing else processes
// them; docs/operations/crawl-processing.md). The worker uses the app's
// database (--target=app), with all of its own checks: it refuses anything
// but the shared manual-testing database or a database on this machine.
// Ctrl+C stops both; if either exits, the other is stopped too.
import { spawn } from "node:child_process";

const extra = process.argv.slice(2); // e.g. --runs=2, passed to the worker
const children = [
  spawn("npx", ["next", "dev"], { stdio: "inherit" }),
  spawn("npm", ["run", "-s", "dev:crawls", "--", "--target=app", ...extra], {
    stdio: "inherit",
  }),
];

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

let exitCode = 0;
await Promise.all(
  children.map(
    (child) =>
      new Promise((resolve) =>
        child.on("exit", (code) => {
          if (code) exitCode = code;
          stop("SIGTERM");
          resolve();
        }),
      ),
  ),
);
process.exit(exitCode);
