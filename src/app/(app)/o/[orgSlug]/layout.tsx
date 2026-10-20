import Link from "next/link";
import { requireOrgContext } from "@/lib/tenancy/context";

export default async function OrgLayout({
  children,
  params,
}: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const unread = await ctx.db.notificationDelivery.count({
    where: { recipientMemberId: ctx.memberId, channel: "IN_APP", readAt: null },
  });
  const base = `/o/${orgSlug}`;
  const nav = [
    { href: base, label: "Overview" },
    { href: `${base}/websites`, label: "Websites" },
    { href: `${base}/issues`, label: "Issues" },
    { href: `${base}/alerts`, label: "Alerts" },
    { href: `${base}/reports`, label: "Reports" },
    { href: `${base}/clients`, label: "Clients" },
    { href: `${base}/settings`, label: "Settings" },
  ];
  const link =
    "rounded-md px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100";
  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-1 border-b border-zinc-200 pb-3 text-sm dark:border-zinc-800">
        <span className="mr-3 font-semibold">{ctx.organization.name}</span>
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className={link}>
            {item.label}
          </Link>
        ))}
        <Link
          href={`${base}/notifications`}
          className={`${link} ml-auto`}
          aria-label={`Notifications, ${unread} unread`}
        >
          Notifications
          {unread > 0 && (
            <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Link>
      </nav>
      {children}
    </div>
  );
}
