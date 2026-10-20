import Link from "next/link";
import { requireOrgContext } from "@/lib/tenancy/context";

export default async function OrgLayout({
  children,
  params,
}: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const base = `/o/${orgSlug}`;
  const nav = [
    { href: base, label: "Overview" },
    { href: `${base}/websites`, label: "Websites" },
    { href: `${base}/issues`, label: "Issues" },
    { href: `${base}/clients`, label: "Clients" },
  ];
  return (
    <div className="flex flex-col gap-6">
      <nav className="flex flex-wrap items-center gap-1 border-b border-zinc-200 pb-3 text-sm dark:border-zinc-800">
        <span className="mr-3 font-semibold">{ctx.organization.name}</span>
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
