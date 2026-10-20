import { randomUUID } from "node:crypto";
import { makeProvider } from "@/lib/ai-search/config";
import { processAiSearchRuns } from "@/lib/ai-search/runner";
import { hasBearerSecret } from "@/lib/auth/bearer";
import { processCrawls } from "@/lib/crawler/engine";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import {
  processMonitoringJobs,
  scheduleDueChecks,
} from "@/lib/monitoring/worker";
import { syncRecommendations } from "@/lib/recommendations/generate";
import { refreshStaleSnapshots } from "@/lib/scoring/snapshots";

// Background work entry point for an external scheduler (e.g. Vercel Cron
// every minute): schedules due checks, drains the monitoring queue, advances
// crawls and AI search runs, then refreshes hourly scores and recommendations.
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

  const started = Date.now();
  const at = (fraction: number) => started + BUDGET_MS * fraction;
  const workerId = `cron-${randomUUID().slice(0, 8)}`;

  const schedule = await scheduleDueChecks(db());
  const monitoring = await processMonitoringJobs(db(), {
    workerId,
    deadline: at(0.4),
  });
  const crawling = await processCrawls(db(), { deadline: at(0.7) });
  const aiRuns = await processAiSearchRuns(db(), makeProvider, {
    deadline: at(0.85),
  });
  const refreshed = await refreshStaleSnapshots(db(), { limit: 10 });
  for (const website of refreshed) await syncRecommendations(db(), website);

  return Response.json({
    ok: true,
    workerId,
    schedule,
    monitoring,
    crawling,
    aiRuns,
    snapshots: refreshed.length,
  });
}

export { handle as GET, handle as POST };
