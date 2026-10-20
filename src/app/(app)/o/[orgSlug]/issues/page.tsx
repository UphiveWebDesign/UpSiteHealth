import type { Metadata } from "next";
import Link from "next/link";
import type { IssueStatus } from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader, Table, td } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatRelative, humanize } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { assignIssueAction, setIssueStatusAction } from "../actions";

export const metadata: Metadata = { title: "Issues · UpSiteHealth" };

const VIEWS: Record<string, IssueStatus[]> = {
  active: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"],
  resolved: ["RESOLVED"],
  ignored: ["IGNORED"],
};
const ALL_STATUSES: IssueStatus[] = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "IGNORED",
];
const select =
  "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900";

export default async function IssuesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/issues">) {
  const { orgSlug } = await params;
  const { view: rawView } = await searchParams;
  const view =
    typeof rawView === "string" && rawView in VIEWS ? rawView : "active";
  const ctx = await requireOrgContext(orgSlug);

  const [issues, members] = await Promise.all([
    ctx.db.issue.findMany({
      where: { status: { in: VIEWS[view] } },
      orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
      take: 300,
      include: {
        website: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    }),
    ctx.db.organizationMember.findMany({
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);
  const editor = can.editWebsites(ctx.role);

  return (
    <>
      <PageHeader title="Issues" />
      <div className="mb-4 flex gap-2 text-sm">
        {Object.keys(VIEWS).map((v) => (
          <Link
            key={v}
            href={`/o/${orgSlug}/issues?view=${v}`}
            className={`rounded-md px-3 py-1.5 ${v === view ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}
          >
            {humanize(v)}
          </Link>
        ))}
      </div>
      <Card>
        {issues.length === 0 ? (
          <Empty>No issues in this view.</Empty>
        ) : (
          <Table
            head={[
              "Severity",
              "Issue",
              "Website",
              "Seen",
              "Status",
              "Assignee",
            ]}
          >
            {issues.map((i) => (
              <tr key={i.id}>
                <td className={td}>
                  <Badge value={i.severity} />
                </td>
                <td className={td}>
                  <div className="font-medium">{i.title}</div>
                  <div className="text-xs text-zinc-500">
                    {humanize(i.category)} · {i.description}
                  </div>
                </td>
                <td className={td}>
                  <Link
                    href={`/o/${orgSlug}/websites/${i.website.id}`}
                    className="hover:underline"
                  >
                    {i.website.name}
                  </Link>
                </td>
                <td className={`${td} whitespace-nowrap text-xs text-zinc-500`}>
                  first {formatRelative(i.firstSeenAt)}
                  <br />
                  last {formatRelative(i.lastSeenAt)}
                </td>
                <td className={td}>
                  {editor ? (
                    <form
                      action={setIssueStatusAction.bind(null, orgSlug, i.id)}
                      className="flex items-center gap-1"
                    >
                      <select
                        name="status"
                        defaultValue={i.status}
                        className={select}
                        aria-label="Status"
                      >
                        {ALL_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {humanize(s)}
                          </option>
                        ))}
                      </select>
                      <SubmitButton variant="ghost">Save</SubmitButton>
                    </form>
                  ) : (
                    <Badge value={i.status} />
                  )}
                </td>
                <td className={td}>
                  {editor ? (
                    <form
                      action={assignIssueAction.bind(null, orgSlug, i.id)}
                      className="flex items-center gap-1"
                    >
                      <select
                        name="assignedToId"
                        defaultValue={i.assignedToId ?? ""}
                        className={select}
                        aria-label="Assignee"
                      >
                        <option value="">Unassigned</option>
                        {members.map((m) => (
                          <option key={m.user.id} value={m.user.id}>
                            {m.user.name ?? m.user.email}
                          </option>
                        ))}
                      </select>
                      <SubmitButton variant="ghost">Save</SubmitButton>
                    </form>
                  ) : (
                    (i.assignedTo?.name ?? i.assignedTo?.email ?? "—")
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
