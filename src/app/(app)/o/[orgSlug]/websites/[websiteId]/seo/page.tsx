import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { SeoFindingStatus } from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader, Table, td } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatRelative } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { setFindingStatusAction } from "../../../actions";

export const metadata: Metadata = { title: "SEO findings · UpSiteHealth" };

const STATUSES: SeoFindingStatus[] = ["OPEN", "IGNORED", "RESOLVED"];

export default async function SeoFindingsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/seo">) {
  const { orgSlug, websiteId } = await params;
  const { status: rawStatus } = await searchParams;
  const status = STATUSES.find((s) => s === rawStatus) ?? "OPEN";
  const ctx = await requireOrgContext(orgSlug);

  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();
  const [findings, byRule] = await Promise.all([
    ctx.db.seoFinding.findMany({
      where: { websiteId, status },
      orderBy: [{ severity: "asc" }, { ruleId: "asc" }, { lastSeenAt: "desc" }],
      take: 500,
    }),
    ctx.db.seoFinding.groupBy({
      by: ["ruleId", "severity"],
      where: { websiteId, status },
      _count: true,
      orderBy: { severity: "asc" },
    }),
  ]);
  const editor = can.editWebsites(ctx.role);
  const base = `/o/${orgSlug}/websites/${websiteId}`;

  return (
    <>
      <PageHeader
        title={`SEO findings · ${website.name}`}
        actions={
          <Link href={base} className="text-sm underline">
            Back to website
          </Link>
        }
      />
      <div className="mb-4 flex gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`${base}/seo?status=${s}`}
            className={`rounded-md px-3 py-1.5 ${s === status ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </Link>
        ))}
      </div>
      {byRule.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-3 text-sm">
          {byRule.map((r) => (
            <span key={r.ruleId} className="flex items-center gap-1">
              <Badge value={r.severity} />
              <code className="text-xs">{r.ruleId}</code> × {r._count}
            </span>
          ))}
        </div>
      )}
      <Card>
        {findings.length === 0 ? (
          <Empty>No {status.toLowerCase()} findings.</Empty>
        ) : (
          <Table head={["Severity", "Finding", "Page", "Last seen", ""]}>
            {findings.map((f) => {
              const url = (f.evidence as { url?: string } | null)?.url;
              return (
                <tr key={f.id}>
                  <td className={td}>
                    <Badge value={f.severity} />
                  </td>
                  <td className={td}>
                    <div className="font-medium">{f.title}</div>
                    <div className="text-xs text-zinc-500">
                      {f.recommendation}
                    </div>
                  </td>
                  <td className={`${td} max-w-xs break-all text-xs`}>
                    {url ?? (f.scope === "SITE" ? "Whole site" : "—")}
                  </td>
                  <td
                    className={`${td} whitespace-nowrap text-xs text-zinc-500`}
                  >
                    {formatRelative(f.lastSeenAt)}
                  </td>
                  <td className={td}>
                    {editor && f.status !== "RESOLVED" && (
                      <form
                        action={setFindingStatusAction.bind(
                          null,
                          orgSlug,
                          f.id,
                        )}
                      >
                        <input
                          type="hidden"
                          name="status"
                          value={f.status === "OPEN" ? "IGNORED" : "OPEN"}
                        />
                        <SubmitButton variant="ghost">
                          {f.status === "OPEN" ? "Ignore" : "Reopen"}
                        </SubmitButton>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
