import { randomUUID } from "node:crypto";
import { makeProvider } from "@/lib/ai-search/config";
import { resendSender } from "@/lib/alerts/delivery";
import { hasBearerSecret } from "@/lib/auth/bearer";
import {
  httpStatusFor,
  recordCronHeartbeat,
  runStages,
} from "@/lib/cron/stages";
import { cronStages } from "@/lib/cron/work";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { log } from "@/lib/log";

// Background work entry point for an external scheduler (e.g. Vercel Cron
// every minute). Stages run independently (see src/lib/cron/work.ts):
// 200 = all stages succeeded, 207 = some failed, 500 = all failed.
export const maxDuration = 60;

const BUDGET_MS = 50_000;

async function handle(request: Request) {
  const { CRON_SECRET, RESEND_API_KEY, EMAIL_FROM, APP_URL } = serverEnv();
  if (!CRON_SECRET) {
    return Response.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }
  if (!hasBearerSecret(request.headers.get("authorization"), CRON_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = `cron-${randomUUID().slice(0, 8)}`;
  const report = await runStages(
    runId,
    cronStages({
      db: db(),
      workerId: runId,
      makeProvider,
      emailSender:
        RESEND_API_KEY && EMAIL_FROM
          ? resendSender(RESEND_API_KEY, EMAIL_FROM)
          : null,
      appUrl: APP_URL,
    }),
    { budgetMs: BUDGET_MS },
  );

  try {
    await recordCronHeartbeat(db(), report);
  } catch (error) {
    log.error("cron_heartbeat_failed", { runId }, error);
  }

  return Response.json(
    { ok: report.status === "ok", ...report },
    { status: httpStatusFor(report.status) },
  );
}

export { handle as GET, handle as POST };
