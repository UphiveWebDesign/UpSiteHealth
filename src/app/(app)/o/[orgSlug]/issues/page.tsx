import type { Metadata } from "next";
import Link from "next/link";
import type { IssueStatus } from "@/generated/prisma/enums";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  Empty,
  FilterTabs,
  PageHeader,
  Table,
  td,
} from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatRelative, humanize } from "@/lib/format";
import { issueResolution } from "@/lib/monitoring/rules";
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
  "rounded-md border border-line-strong bg-white px-2 py-1 text-xs";

export default async function IssuesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/issues">) {
  const { orgSlug } = await params;
  const { view: rawView } = await searchParams;
  const view =
    typeof rawView === "string" && rawView in VIEWS ? rawView : "active";
  const ctx = await requireOrgContext(orgSlug);

  const [issues, members, passes] = await Promise.all([
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
    // Latest passing check per website and type: confirms resolutions.
    view === "resolved"
      ? ctx.db.websiteCheck.groupBy({
          by: ["websiteId", "type"],
          where: { status: "COMPLETED", outcome: "SUCCESS" },
          _max: { completedAt: true },
        })
      : Promise.resolve([]),
  ]);
  const lastPass = new Map(
    passes.map((p) => [`${p.websiteId}:${p.type}`, p._max.completedAt]),
  );
  const editor = can.editWebsites(ctx.role);

  return (
    <>
      <PageHeader
        title="Issues"
        subtitle={
          view === "resolved"
            ? "An issue resolved by hand stays unconfirmed until its next check passes. If that check still fails, the issue reopens."
            : undefined
        }
      />
      <FilterTabs
        label="Issue status"
        items={Object.keys(VIEWS).map((v) => ({
          href: `/o/${orgSlug}/issues?view=${v}`,
          label: humanize(v),
          active: v === view,
        }))}
      />
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
                  <div className="text-xs text-muted">
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
                <td className={`${td} whitespace-nowrap text-xs text-muted`}>
                  first {formatRelative(i.firstSeenAt)}
                  <br />
                  last {formatRelative(i.lastSeenAt)}
                </td>
                <td className={td}>
                  {i.status === "RESOLVED" && (
                    <div className="mb-1">
                      {issueResolution(
                        i,
                        lastPass.get(`${i.website.id}:${i.category}`) ?? null,
                      ) === "verified" ? (
                        <Badge
                          value="confirmed"
                          tone="success"
                          label="Confirmed by a check"
                        />
                      ) : (
                        <Badge
                          value="unconfirmed"
                          tone="warning"
                          label="Marked resolved · awaiting check"
                        />
                      )}
                    </div>
                  )}
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
