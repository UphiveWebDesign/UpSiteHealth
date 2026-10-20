import { randomUUID } from "node:crypto";
import { hasBearerSecret } from "@/lib/auth/bearer";
import { processCrawls } from "@/lib/crawler/engine";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import {
  processMonitoringJobs,
  scheduleDueChecks,
} from "@/lib/monitoring/worker";

// Background work entry point for an external scheduler (e.g. Vercel Cron
// every minute): schedules due checks, drains the monitoring queue, then
// advances crawls with whatever time is left.
export const maxDuration = 60;

const BUDGET_MS = 50_000;

async function handle(request: Request) {
  const { CRON_SECRET } = serverEnv();
  if (!CRON_SECRET) {
    return Response.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }
  if (!hasBearerSecret(request.headers.get("authorization"), CRON_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deadline = Date.now() + BUDGET_MS;
  const workerId = `cron-${randomUUID().slice(0, 8)}`;
  const schedule = await scheduleDueChecks(db());
  const monitoring = await processMonitoringJobs(db(), {
    workerId,
    deadline: Date.now() + BUDGET_MS * 0.6,
  });
  const crawling = await processCrawls(db(), { deadline });
  return Response.json({ ok: true, workerId, schedule, monitoring, crawling });
}

export { handle as GET, handle as POST };
