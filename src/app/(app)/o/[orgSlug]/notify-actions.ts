"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, requireOrgContext } from "@/lib/tenancy/context";
import type { FormState } from "./actions";

const ALERT_TYPES = [
  "UPTIME_INCIDENT_OPENED",
  "UPTIME_INCIDENT_RESOLVED",
  "SSL_CERTIFICATE_EXPIRING",
  "SSL_CERTIFICATE_EXPIRED",
  "SSL_CERTIFICATE_HOSTNAME_MISMATCH",
  "DNS_ERROR_DETECTED",
  "DNS_ERROR_RESOLVED",
  "WEBSITE_HEALTH_DEGRADED",
  "WEBSITE_HEALTH_RECOVERED",
  "CRAWL_COMPLETED_WITH_ERRORS",
] as const;

/** Marks one of the current member's own in-app notifications as read. */
export async function markNotificationReadAction(
  orgSlug: string,
  deliveryId: string,
) {
  const ctx = await requireOrgContext(orgSlug);
  await ctx.db.notificationDelivery.updateMany({
    where: { id: deliveryId, recipientMemberId: ctx.memberId, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath(`/o/${orgSlug}`, "layout");
}

export async function markAllNotificationsReadAction(orgSlug: string) {
  const ctx = await requireOrgContext(orgSlug);
  await ctx.db.notificationDelivery.updateMany({
    where: { recipientMemberId: ctx.memberId, channel: "IN_APP", readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath(`/o/${orgSlug}`, "layout");
}

const preferencesSchema = z.object({
  enabled: z.boolean(),
  inAppEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  minimumSeverity: z
    .enum(["", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"])
    .transform((v) => v || null),
  cooldownMinutes: z
    .string()
    .transform((v) => (v.trim() === "" ? null : Number(v)))
    .pipe(z.number().int().min(0).max(10_080).nullable()),
  enabledEventTypes: z.array(z.enum(ALERT_TYPES)),
});

export async function saveNotificationPreferencesAction(
  orgSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireOrgContext(orgSlug, "ADMIN");
    const parsed = preferencesSchema.safeParse({
      enabled: formData.get("enabled") === "on",
      inAppEnabled: formData.get("inAppEnabled") === "on",
      emailEnabled: formData.get("emailEnabled") === "on",
      minimumSeverity: String(formData.get("minimumSeverity") ?? ""),
      cooldownMinutes: String(formData.get("cooldownMinutes") ?? ""),
      enabledEventTypes: formData.getAll("enabledEventTypes").map(String),
    });
    if (!parsed.success) return { error: "Check the values and try again." };
    // All types selected is stored as [] ("all"), so new types are included automatically.
    const data = {
      ...parsed.data,
      enabledEventTypes:
        parsed.data.enabledEventTypes.length === ALERT_TYPES.length
          ? []
          : parsed.data.enabledEventTypes,
    };
    await ctx.db.notificationPreference.upsert({
      where: { organizationId: ctx.organization.id },
      create: { organizationId: ctx.organization.id, ...data },
      update: data,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/o/${orgSlug}`, "layout");
  return { ok: "Notification settings saved." };
}
