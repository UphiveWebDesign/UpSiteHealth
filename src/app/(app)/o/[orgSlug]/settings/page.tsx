import type { Metadata } from "next";
import { ActionForm, inputClass } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, PageHeader, Table, td } from "@/components/ui/layout";
import { DEFAULT_PREFERENCES } from "@/lib/alerts/notify";
import { serverEnv } from "@/lib/env";
import { humanize } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { saveNotificationPreferencesAction } from "../notify-actions";

export const metadata: Metadata = { title: "Settings · UpSiteHealth" };

const TYPES = [
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

export default async function SettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/settings">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const [row, members] = await Promise.all([
    ctx.db.notificationPreference.findFirst({}),
    ctx.db.organizationMember.findMany({
      orderBy: { createdAt: "asc" },
      include: { user: { select: { name: true, email: true } } },
    }),
  ]);
  const prefs = row ?? DEFAULT_PREFERENCES;
  const selected = new Set(
    prefs.enabledEventTypes?.length ? prefs.enabledEventTypes : TYPES,
  );
  const admin = can.manageMembers(ctx.role);
  const emailConfigured = Boolean(
    serverEnv().RESEND_API_KEY && serverEnv().EMAIL_FROM,
  );

  return (
    <>
      <PageHeader title="Settings" subtitle={ctx.organization.name} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Notifications">
          {!admin && (
            <p className="mb-3 text-xs text-muted">
              Only owners and admins can change these settings.
            </p>
          )}
          <ActionForm
            action={saveNotificationPreferencesAction.bind(null, orgSlug)}
            submitLabel="Save notification settings"
          >
            <fieldset disabled={!admin} className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={prefs.enabled}
                />{" "}
                Notifications enabled
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="inAppEnabled"
                  defaultChecked={prefs.inAppEnabled}
                />{" "}
                In-app
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="emailEnabled"
                  defaultChecked={prefs.emailEnabled}
                />{" "}
                Email
              </label>
              {!emailConfigured && (
                <p className="text-xs text-warning-700">
                  No email provider is configured (RESEND_API_KEY and
                  EMAIL_FROM). Email deliveries will be recorded as “not
                  configured”.
                </p>
              )}
              <label className="text-sm font-medium">
                Minimum severity
                <select
                  name="minimumSeverity"
                  defaultValue={prefs.minimumSeverity ?? ""}
                  className={inputClass}
                >
                  <option value="">All severities</option>
                  {["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => (
                    <option key={s} value={s}>
                      {humanize(s)} and above
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium">
                Email cooldown (minutes, blank for none)
                <input
                  name="cooldownMinutes"
                  type="number"
                  min={0}
                  max={10080}
                  defaultValue={prefs.cooldownMinutes ?? ""}
                  className={inputClass}
                />
              </label>
              <fieldset className="text-sm">
                <legend className="mb-1 font-medium">Event types</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {TYPES.map((t) => (
                    <label key={t} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        name="enabledEventTypes"
                        value={t}
                        defaultChecked={selected.has(t)}
                      />
                      {humanize(t)}
                    </label>
                  ))}
                </div>
              </fieldset>
            </fieldset>
          </ActionForm>
        </Card>
        <Card title="Members">
          <Table head={["Member", "Role"]}>
            {members.map((m) => (
              <tr key={m.id}>
                <td className={td}>
                  <div className="font-medium">
                    {m.user.name ?? m.user.email}
                  </div>
                  <div className="text-xs text-muted">{m.user.email}</div>
                </td>
                <td className={td}>
                  <Badge value={m.role} tone="neutral" />
                </td>
              </tr>
            ))}
          </Table>
          <p className="mt-3 text-xs text-muted">
            Inviting members is not available yet.
          </p>
        </Card>
      </div>
    </>
  );
}
