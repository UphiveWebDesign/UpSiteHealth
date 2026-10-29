import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { DEFAULT_MONITORING_CHECKS } from "@/lib/monitoring/rules";
import type { TenantDb } from "@/lib/tenancy/scope";
import { normalizeWebsiteUrl, WebsiteUrlError } from "./url";

export const websiteInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(100),
  url: z.string().trim().min(1, "Enter a URL.").max(2048),
  clientId: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null),
  monitoringEnabled: z.boolean().optional(),
  /**
   * Missing: MANUAL on create (only the onboarding form offers AUTOMATIC,
   * preselected), unchanged on update.
   */
  crawlMode: z
    .enum(["AUTOMATIC", "MANUAL"], { message: "Choose a crawl mode." })
    .optional(),
});

export type WebsiteInput = z.input<typeof websiteInputSchema>;

export class WebsiteError extends Error {
  constructor(
    message: string,
    public readonly field?: "name" | "url" | "clientId",
  ) {
    super(message);
  }
}

async function assertClientInOrg(db: TenantDb, clientId: string | null) {
  if (!clientId) return;
  // Scoped lookup: a client id from another organization is simply not found.
  const client = await db.client.findFirst({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client)
    throw new WebsiteError(
      "Choose a client from this organization.",
      "clientId",
    );
}

function translate(error: unknown): never {
  if (error instanceof WebsiteUrlError)
    throw new WebsiteError(error.message, "url");
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new WebsiteError(
      "This organization already monitors that domain.",
      "url",
    );
  }
  throw error;
}

/** Creates a website plus its default UPTIME/DNS/SSL monitoring checks. */
export async function createWebsite(
  db: TenantDb,
  organizationId: string,
  input: WebsiteInput,
) {
  const data = websiteInputSchema.parse(input);
  try {
    const { url, domain } = normalizeWebsiteUrl(data.url);
    await assertClientInOrg(db, data.clientId);
    const now = new Date();
    return await db.$transaction(async (tx) => {
      const website = await tx.website.create({
        data: {
          organizationId,
          name: data.name,
          url,
          domain,
          clientId: data.clientId,
          monitoringEnabled: data.monitoringEnabled ?? true,
          crawlMode: data.crawlMode ?? "MANUAL",
          nextCheckAt: now,
        },
      });
      await tx.websiteMonitoringCheck.createMany({
        data: DEFAULT_MONITORING_CHECKS.map((c) => ({
          organizationId,
          websiteId: website.id,
          type: c.type,
          intervalMinutes: c.intervalMinutes,
          nextCheckAt: now,
        })),
      });
      return website;
    });
  } catch (error) {
    translate(error);
  }
}

export async function updateWebsite(
  db: TenantDb,
  websiteId: string,
  input: WebsiteInput,
) {
  const data = websiteInputSchema.parse(input);
  try {
    const { url, domain } = normalizeWebsiteUrl(data.url);
    await assertClientInOrg(db, data.clientId);
    const enabled = data.monitoringEnabled ?? true;
    return await db.website.update({
      where: { id: websiteId },
      data: {
        name: data.name,
        url,
        domain,
        clientId: data.clientId,
        monitoringEnabled: enabled,
        ...(enabled ? {} : { status: "PAUSED" as const }),
        ...(data.crawlMode ? { crawlMode: data.crawlMode } : {}),
      },
    });
  } catch (error) {
    translate(error);
  }
}

/** Deletes a website; its checks, crawls, findings and issues cascade. */
export async function deleteWebsite(
  db: TenantDb,
  websiteId: string,
): Promise<boolean> {
  const { count } = await db.website.deleteMany({ where: { id: websiteId } });
  return count === 1;
}

/** Queues HIGH-priority jobs for an immediate check of every monitored type. */
export async function requestImmediateChecks(
  db: TenantDb,
  organizationId: string,
  websiteId: string,
) {
  const site = await db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, monitoringEnabled: true },
  });
  if (!site) return 0;
  const active = await db.monitoringJob.findMany({
    where: { websiteId, status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
    select: { type: true },
  });
  const busy = new Set(active.map((j) => j.type));
  const types = DEFAULT_MONITORING_CHECKS.map((c) => c.type).filter(
    (t) => !busy.has(t),
  );
  if (types.length === 0) return 0;
  const { count } = await db.monitoringJob.createMany({
    data: types.map((type) => ({
      organizationId,
      websiteId,
      type,
      priority: "HIGH" as const,
      scheduledFor: new Date(),
    })),
  });
  return count;
}
