import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader, Table, td } from "@/components/ui/layout";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { createClientAction } from "../actions";
import { ClientForm } from "./client-form";

export const metadata: Metadata = { title: "Clients · UpSiteHealth" };

export default async function ClientsPage({
  params,
}: PageProps<"/o/[orgSlug]/clients">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const clients = await ctx.db.client.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { websites: true } } },
  });

  return (
    <>
      <PageHeader title="Clients" />
      <div className="flex flex-col gap-6">
        <Card>
          {clients.length === 0 ? (
            <Empty>No clients yet.</Empty>
          ) : (
            <Table head={["Client", "Company", "Email", "Websites", "Status"]}>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td className={`${td} font-medium`}>{c.name}</td>
                  <td className={td}>{c.company ?? "—"}</td>
                  <td className={td}>{c.email ?? "—"}</td>
                  <td className={`${td} tabular-nums`}>{c._count.websites}</td>
                  <td className={td}>
                    <Badge
                      value={c.status}
                      tone={c.status === "ACTIVE" ? "green" : "zinc"}
                    />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        {can.manageClients(ctx.role) && (
          <Card title="Add client">
            <ClientForm action={createClientAction.bind(null, orgSlug)} />
          </Card>
        )}
      </div>
    </>
  );
}
