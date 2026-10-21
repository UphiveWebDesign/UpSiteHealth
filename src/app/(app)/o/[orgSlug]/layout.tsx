import Link from "next/link";
import { NavLink } from "@/components/nav-link";
import { BellIcon } from "@/components/ui/icons";
import { WorkerStatusBanner } from "@/components/worker-status";
import { CRON_HEARTBEAT, heartbeatStatus } from "@/lib/cron/stages";
import { db } from "@/lib/db";
import { requireOrgContext } from "@/lib/tenancy/context";

export default async function OrgLayout({
  children,
  params,
}: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const [unread, heartbeat] = await Promise.all([
    ctx.db.notificationDelivery.count({
      where: {
        recipientMemberId: ctx.memberId,
        channel: "IN_APP",
        readAt: null,
      },
    }),
    // Platform-wide heartbeat (not tenant data), read only after membership is confirmed.
    db().schedulerHeartbeat.findUnique({
      where: { component: CRON_HEARTBEAT },
      select: { lastRunAt: true, meta: true },
    }),
  ]);
  const workerStatus = heartbeatStatus(heartbeat);
  const base = `/o/${orgSlug}`;
  const nav = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/websites`, label: "Websites" },
    { href: `${base}/issues`, label: "Issues" },
    { href: `${base}/alerts`, label: "Alerts" },
    { href: `${base}/reports`, label: "Reports" },
    { href: `${base}/clients`, label: "Clients" },
    { href: `${base}/settings`, label: "Settings" },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="-mt-2 flex flex-wrap items-center gap-x-6 border-b border-line print:hidden">
        <Link
          href={base}
          className="flex h-11 items-center gap-2 pr-1 text-sm font-semibold text-ink"
          title="Organization"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-xs font-bold text-brand-800">
            {ctx.organization.name.slice(0, 1).toUpperCase()}
          </span>
          {ctx.organization.name}
        </Link>
        <nav
          aria-label="Organization"
          className="-mb-px flex flex-1 gap-5 overflow-x-auto"
        >
          {nav.map((item) => (
            <NavLink key={item.href} href={item.href} exact={item.exact}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <Link
          href={`${base}/notifications`}
          className="relative flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-slate-100 hover:text-ink"
          aria-label={`Notifications, ${unread} unread`}
          title="Notifications"
        >
          <BellIcon className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger-700 px-1 text-center text-[10px] font-semibold leading-4 text-white tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Link>
      </div>
      <div className="print:hidden">
        <WorkerStatusBanner status={workerStatus} />
      </div>
      {children}
    </div>
  );
}
