import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { hasOrganizationAccess } from "@/lib/tenancy/context";
import { listMemberships } from "@/lib/tenancy/memberships";

export const metadata: Metadata = { title: "Organizations · UpSiteHealth" };

export default async function DashboardPage() {
  const user = await requireUser();
  const all = await listMemberships(db(), user.id);
  // Only organizations the user can open: CLIENT members have no access to
  // organization pages (hasOrganizationAccess), so none are linked.
  const memberships = all.filter((m) => hasOrganizationAccess(m.role));
  const clientOnly = memberships.length === 0 && all.length > 0;

  if (memberships.length === 1) {
    redirect(`/o/${memberships[0].organization.slug}`);
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Your organizations
      </h1>
      {clientOnly ? (
        <p className="max-w-prose text-ink-2" data-testid="client-only">
          Your account has client access. Reports are shared with you directly
          by your agency, for example as a PDF, so there is nothing to open here
          yet.
        </p>
      ) : memberships.length === 0 ? (
        <p className="text-ink-2">
          You are not a member of any organization yet.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {memberships.map((m) => (
            <li key={m.memberId}>
              <Link
                href={`/o/${m.organization.slug}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-tint"
              >
                <span className="font-medium">{m.organization.name}</span>
                <span className="text-xs uppercase text-muted">{m.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
