import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatRelative } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "../notify-actions";

export const metadata: Metadata = { title: "Notifications · UpSiteHealth" };

export default async function NotificationsPage({
  params,
}: PageProps<"/o/[orgSlug]/notifications">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const items = await ctx.db.notificationDelivery.findMany({
    where: { recipientMemberId: ctx.memberId, channel: "IN_APP" },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      alertEvent: {
        include: { website: { select: { id: true, name: true } } },
      },
    },
  });
  const unread = items.filter((i) => !i.readAt).length;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={`${unread} unread`}
        actions={
          unread > 0 && (
            <form action={markAllNotificationsReadAction.bind(null, orgSlug)}>
              <SubmitButton variant="ghost">Mark all as read</SubmitButton>
            </form>
          )
        }
      />
      <Card>
        {items.length === 0 ? (
          <Empty>No notifications yet.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((n) => (
              <li
                key={n.id}
                className={`flex items-start justify-between gap-4 py-3 ${n.readAt ? "opacity-60" : ""}`}
              >
                <div className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge value={n.alertEvent.severity} />
                    <span className="font-medium">{n.alertEvent.title}</span>
                  </div>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                    {n.alertEvent.message}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    <Link
                      href={`/o/${orgSlug}/websites/${n.alertEvent.website.id}`}
                      className="underline"
                    >
                      {n.alertEvent.website.name}
                    </Link>{" "}
                    · {formatRelative(n.createdAt)}
                  </p>
                </div>
                {!n.readAt && (
                  <form
                    action={markNotificationReadAction.bind(
                      null,
                      orgSlug,
                      n.id,
                    )}
                  >
                    <SubmitButton variant="ghost">Mark read</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
