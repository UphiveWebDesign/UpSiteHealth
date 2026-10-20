import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  Empty,
  LinkButton,
  PageHeader,
  Table,
  td,
} from "@/components/ui/layout";
import { formatRelative } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";

export const metadata: Metadata = { title: "Websites · UpSiteHealth" };

export default async function WebsitesPage({
  params,
}: PageProps<"/o/[orgSlug]/websites">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const websites = await ctx.db.website.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      domain: true,
      status: true,
      monitoringEnabled: true,
      nextCheckAt: true,
      client: { select: { name: true } },
      _count: {
        select: {
          issues: {
            where: { status: { in: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] } },
          },
          seoFindings: { where: { status: "OPEN" } },
        },
      },
    },
  });

  return (
    <>
      <PageHeader
        title="Websites"
        actions={
          can.editWebsites(ctx.role) && (
            <LinkButton href={`/o/${orgSlug}/websites/new`}>
              Add website
            </LinkButton>
          )
        }
      />
      <Card>
        {websites.length === 0 ? (
          <Empty>No websites yet.</Empty>
        ) : (
          <Table
            head={[
              "Website",
              "Client",
              "Status",
              "Open issues",
              "SEO findings",
              "Next check",
            ]}
          >
            {websites.map((w) => (
              <tr key={w.id}>
                <td className={td}>
                  <Link
                    href={`/o/${orgSlug}/websites/${w.id}`}
                    className="font-medium hover:underline"
                  >
                    {w.name}
                  </Link>
                  <div className="text-xs text-muted">{w.domain}</div>
                </td>
                <td className={td}>{w.client?.name ?? "—"}</td>
                <td className={td}>
                  <Badge value={w.status} />
                </td>
                <td className={`${td} tabular-nums`}>{w._count.issues}</td>
                <td className={`${td} tabular-nums`}>{w._count.seoFindings}</td>
                <td className={`${td} text-xs text-muted`}>
                  {w.monitoringEnabled
                    ? formatRelative(w.nextCheckAt)
                    : "Paused"}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
