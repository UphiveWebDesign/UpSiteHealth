import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui/layout";
import { requireOrgContext } from "@/lib/tenancy/context";
import { createWebsiteAction } from "../../actions";
import { WebsiteForm } from "../website-form";

export const metadata: Metadata = { title: "Add website · UpSiteHealth" };

export default async function NewWebsitePage({
  params,
}: PageProps<"/o/[orgSlug]/websites/new">) {
  const { orgSlug } = await params;
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const clients = await ctx.db.client.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  return (
    <>
      <PageHeader
        title="Add website"
        subtitle="Uptime is checked every 5 minutes, DNS every 30 minutes and SSL every 6 hours. Choose whether UpSiteHealth crawls the site automatically."
      />
      <Card>
        <WebsiteForm
          action={createWebsiteAction.bind(null, orgSlug)}
          clients={clients}
          submitLabel="Add website"
        />
      </Card>
    </>
  );
}
