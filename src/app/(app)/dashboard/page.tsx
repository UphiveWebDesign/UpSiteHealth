import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { listMemberships } from "@/lib/tenancy/memberships";

export const metadata: Metadata = { title: "Organizations · UpSiteHealth" };

export default async function DashboardPage() {
  const user = await requireUser();
  const memberships = await listMemberships(db(), user.id);

  if (memberships.length === 1) {
    redirect(`/o/${memberships[0].organization.slug}`);
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Your organizations
      </h1>
      {memberships.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          You are not a member of any organization yet.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {memberships.map((m) => (
            <li key={m.memberId}>
              <Link
                href={`/o/${m.organization.slug}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <span className="font-medium">{m.organization.name}</span>
                <span className="text-xs uppercase text-zinc-500">
                  {m.role}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
