import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui/layout";
import { WebsiteNav } from "@/components/website-nav";
import { SubmitButton } from "@/components/ui/submit-button";
import { crawlSchedule, describeCrawlSchedule } from "@/lib/crawler/schedule";
import { formatDateTime } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { deleteWebsiteAction, updateWebsiteAction } from "../../../actions";
import { WebsiteForm } from "../../website-form";

export const metadata: Metadata = { title: "Website settings · UpSiteHealth" };

export default async function WebsiteSettingsPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/settings">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const [website, clients, latestCrawl] = await Promise.all([
    ctx.db.website.findFirst({ where: { id: websiteId } }),
    ctx.db.client.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    ctx.db.crawlRun.findFirst({
      where: { websiteId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, status: true },
    }),
  ]);
  if (!website) notFound();
  const schedule = crawlSchedule(website, latestCrawl, new Date());

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: `/o/${orgSlug}/websites/${websiteId}` },
          { label: "Settings" },
        ]}
        title="Website settings"
        subtitle="Change the address, client, crawling or monitoring for this website."
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />
      <div className="flex flex-col gap-6">
        <Card title="Details">
          <WebsiteForm
            action={updateWebsiteAction.bind(null, orgSlug, websiteId)}
            clients={clients}
            defaults={{
              name: website.name,
              url: website.url,
              clientId: website.clientId,
              monitoringEnabled: website.monitoringEnabled,
              crawlMode: website.crawlMode,
            }}
            submitLabel="Save changes"
          />
        </Card>
        <Card title="Crawling">
          <p className="text-sm text-ink-2">
            {describeCrawlSchedule(schedule, formatDateTime)}
          </p>
          <p className="mt-2 text-sm">
            <Link
              href={`/o/${orgSlug}/websites/${websiteId}/crawls`}
              className="underline"
            >
              Crawl history and Start crawl
            </Link>
          </p>
        </Card>
        {can.manageClients(ctx.role) && (
          <Card title="Danger zone">
            <p className="mb-3 text-sm text-ink-2">
              Deleting a website permanently removes its checks, crawls, SEO
              findings, issues and score history.
            </p>
            <form action={deleteWebsiteAction.bind(null, orgSlug, websiteId)}>
              <SubmitButton
                pendingLabel="Deleting…"
                confirm={`Permanently delete ${website.name} and all of its history?`}
              >
                Delete website
              </SubmitButton>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
