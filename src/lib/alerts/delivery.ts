import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Durable PostgreSQL notification delivery queue (`notification_delivery_jobs`).
 * Email is the only queued channel; in-app deliveries are written as SENT.
 */

const LEASE_MS = 2 * 60 * 1000;

export class EmailError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface EmailSender {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Resend HTTP API sender. Implemented from its public API; not verified with a live key. */
export function resendSender(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): EmailSender {
  return {
    async send({ to, subject, text }) {
      let res: Response;
      try {
        res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from, to: [to], subject, text }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new EmailError("Email provider unreachable", true);
      }
      if (res.ok) return;
      const retryable = res.status === 429 || res.status >= 500;
      throw new EmailError(
        `Email provider returned HTTP ${res.status}`,
        retryable,
      );
    },
  };
}

/** 1, 2, 4, 8 … minutes, capped at one hour. */
export function backoffMs(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;
}

type ClaimedJob = {
  id: string;
  notificationDeliveryId: string;
  attempt: number;
  maxAttempts: number;
};

export async function processDeliveryJobs(
  db: PrismaClient,
  {
    sender,
    deadline,
    batchSize = 20,
    appUrl,
  }: {
    sender: EmailSender | null;
    deadline: number;
    batchSize?: number;
    appUrl?: string;
  },
) {
  const counts = { sent: 0, retried: 0, failed: 0, notConfigured: 0 };
  const now = () => new Date();

  await db.$executeRaw`
    UPDATE notification_delivery_jobs
    SET status = 'PENDING', "claimedAt" = NULL, "claimExpiresAt" = NULL, "updatedAt" = ${now()}
    WHERE status = 'PROCESSING' AND "claimExpiresAt" < ${now()}`;

  while (Date.now() < deadline) {
    const t = now();
    const jobs = await db.$queryRaw<ClaimedJob[]>`
      UPDATE notification_delivery_jobs
      SET status = 'PROCESSING', attempt = attempt + 1, "claimedAt" = ${t},
          "claimExpiresAt" = ${new Date(t.getTime() + LEASE_MS)}, "updatedAt" = ${t}
      WHERE id IN (
        SELECT id FROM notification_delivery_jobs
        WHERE status = 'PENDING' AND "availableAt" <= ${t}
        ORDER BY "availableAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "notificationDeliveryId", attempt, "maxAttempts"`;
    if (jobs.length === 0) break;

    for (const job of jobs) {
      const delivery = await db.notificationDelivery.findUniqueOrThrow({
        where: { id: job.notificationDeliveryId },
        include: {
          alertEvent: {
            include: { website: { select: { name: true, url: true } } },
          },
          recipientMember: { include: { user: { select: { email: true } } } },
        },
      });
      const finished = now();

      if (!sender) {
        await db.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "NOT_CONFIGURED",
            errorMessage: "Email provider not configured",
            lastAttemptedAt: finished,
            attemptCount: { increment: 1 },
          },
        });
        await db.notificationDeliveryJob.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            completedAt: finished,
            lastError: "Email provider not configured",
          },
        });
        counts.notConfigured++;
        continue;
      }

      const e = delivery.alertEvent;
      try {
        await sender.send({
          to: delivery.recipientMember.user.email,
          subject: `[UpSiteHealth] ${e.title}`,
          text: [
            e.message,
            "",
            `Website: ${e.website.name} (${e.website.url})`,
            `Severity: ${e.severity}`,
            appUrl ? `\nOpen UpSiteHealth: ${appUrl}` : "",
          ].join("\n"),
        });
        await db.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "SENT",
            deliveredAt: finished,
            lastAttemptedAt: finished,
            attemptCount: { increment: 1 },
            errorMessage: null,
          },
        });
        await db.notificationDeliveryJob.update({
          where: { id: job.id },
          data: { status: "COMPLETED", completedAt: finished, lastError: null },
        });
        counts.sent++;
      } catch (error) {
        const err =
          error instanceof EmailError
            ? error
            : new EmailError("Send failed", true);
        const retry = err.retryable && job.attempt < job.maxAttempts;
        await db.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: retry ? "PENDING" : "FAILED",
            lastAttemptedAt: finished,
            attemptCount: { increment: 1 },
            errorMessage: err.message.slice(0, 500),
          },
        });
        await db.notificationDeliveryJob.update({
          where: { id: job.id },
          data: retry
            ? {
                status: "PENDING",
                availableAt: new Date(
                  finished.getTime() + backoffMs(job.attempt),
                ),
                claimedAt: null,
                claimExpiresAt: null,
                lastError: err.message.slice(0, 500),
              }
            : {
                status: "FAILED",
                completedAt: finished,
                lastError: err.message.slice(0, 500),
              },
        });
        if (retry) counts.retried++;
        else counts.failed++;
      }
    }
  }
  return counts;
}
