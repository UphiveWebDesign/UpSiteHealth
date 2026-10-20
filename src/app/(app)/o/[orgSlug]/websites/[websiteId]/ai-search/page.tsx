import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, inputClass } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, Empty, PageHeader, Table, td } from "@/components/ui/layout";
import { SubmitButton } from "@/components/ui/submit-button";
import { configuredProviders } from "@/lib/ai-search/config";
import { formatMs, formatRelative, humanize } from "@/lib/format";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import {
  addAiQueryAction,
  addCompetitorAction,
  deleteAiQueryAction,
  deleteCompetitorAction,
  saveAiProfileAction,
  startAiRunAction,
  toggleAiQueryAction,
} from "../../../insights-actions";

export const metadata: Metadata = { title: "AI Search · UpSiteHealth" };

const INTENTS = [
  "DISCOVERY",
  "COMPARISON",
  "RECOMMENDATION",
  "LOCAL",
  "INFORMATIONAL",
  "TRANSACTIONAL",
];

export default async function AiSearchPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/ai-search">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true, domain: true },
  });
  if (!website) notFound();

  const [profile, competitors, queries, runs] = await Promise.all([
    ctx.db.aiSearchProfile.findFirst({ where: { websiteId } }),
    ctx.db.aiSearchCompetitor.findMany({
      where: { websiteId },
      orderBy: { name: "asc" },
    }),
    ctx.db.aiSearchQuery.findMany({
      where: { websiteId },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    }),
    ctx.db.aiSearchRun.findMany({
      where: { websiteId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  const latestRun = runs[0];
  const results = latestRun
    ? await ctx.db.aiSearchResult.findMany({
        where: { runId: latestRun.id },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const editor = can.editWebsites(ctx.role);
  const providers = configuredProviders();
  const ok = results.filter((r) => r.status === "SUCCESS");
  const mentioned = ok.filter(
    (r) => r.mentionStatus === "BRAND_MENTIONED",
  ).length;
  const cited = ok.filter((r) => r.websiteCited).length;

  return (
    <>
      <PageHeader
        title={`AI Search · ${website.name}`}
        subtitle="How AI assistants answer questions your customers ask, and whether they mention you."
        actions={
          <Link
            href={`/o/${orgSlug}/websites/${websiteId}`}
            className="text-sm underline"
          >
            Back to website
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Brand profile">
          {editor ? (
            <ActionForm
              action={saveAiProfileAction.bind(null, orgSlug, websiteId)}
              submitLabel="Save profile"
            >
              <label className="text-sm font-medium">
                Brand name
                <input
                  name="brandName"
                  required
                  defaultValue={profile?.brandName ?? website.name}
                  className={inputClass}
                />
              </label>
              <label className="text-sm font-medium">
                Legal name
                <input
                  name="legalName"
                  defaultValue={profile?.legalName ?? ""}
                  className={inputClass}
                />
              </label>
              <label className="text-sm font-medium">
                Other names (one per line or comma-separated)
                <textarea
                  name="aliases"
                  rows={2}
                  defaultValue={profile?.aliases.join("\n")}
                  className={inputClass}
                />
              </label>
              <label className="text-sm font-medium">
                Services
                <textarea
                  name="primaryServices"
                  rows={2}
                  defaultValue={profile?.primaryServices.join("\n")}
                  className={inputClass}
                />
              </label>
              <label className="text-sm font-medium">
                Locations
                <textarea
                  name="locations"
                  rows={2}
                  defaultValue={profile?.locations.join("\n")}
                  className={inputClass}
                />
              </label>
              <label className="text-sm font-medium">
                Description
                <textarea
                  name="businessDescription"
                  rows={3}
                  defaultValue={profile?.businessDescription ?? ""}
                  className={inputClass}
                />
              </label>
            </ActionForm>
          ) : profile ? (
            <p className="text-sm">{profile.brandName}</p>
          ) : (
            <Empty>No profile yet.</Empty>
          )}
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Competitors">
            {competitors.length === 0 ? (
              <Empty>No competitors yet.</Empty>
            ) : (
              <ul className="mb-4 flex flex-col gap-2 text-sm">
                {competitors.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span>
                      <span className="font-medium">{c.name}</span>
                      {c.domain && (
                        <span className="text-xs text-zinc-500">
                          {" "}
                          · {c.domain}
                        </span>
                      )}
                    </span>
                    {editor && (
                      <form
                        action={deleteCompetitorAction.bind(
                          null,
                          orgSlug,
                          c.id,
                        )}
                      >
                        <SubmitButton
                          variant="ghost"
                          confirm={`Remove ${c.name}?`}
                        >
                          Remove
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {editor && (
              <ActionForm
                action={addCompetitorAction.bind(null, orgSlug, websiteId)}
                submitLabel="Add competitor"
                className="flex flex-col gap-2"
              >
                <input
                  name="name"
                  placeholder="Name"
                  required
                  className={inputClass}
                />
                <input
                  name="domain"
                  placeholder="Domain (optional)"
                  className={inputClass}
                />
              </ActionForm>
            )}
          </Card>

          <Card title="Run">
            {editor ? (
              <ActionForm
                action={startAiRunAction.bind(null, orgSlug, websiteId)}
                submitLabel="Run AI search"
                pendingLabel="Starting…"
                className="flex items-center gap-3"
              >
                <select
                  name="provider"
                  className={inputClass + " max-w-48"}
                  aria-label="Provider"
                >
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {humanize(p)}
                    </option>
                  ))}
                </select>
              </ActionForm>
            ) : null}
            {providers.length === 1 && (
              <p className="mt-2 text-xs text-zinc-500">
                Only the mock provider is configured. Set GEMINI_API_KEY or
                PERPLEXITY_API_KEY to query real assistants.
              </p>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-6">
        <Card title={`Queries (${queries.length})`}>
          {queries.length === 0 ? (
            <Empty>No queries yet.</Empty>
          ) : (
            <Table head={["Query", "Intent", "Priority", "Enabled", ""]}>
              {queries.map((q) => (
                <tr key={q.id}>
                  <td className={td}>{q.text}</td>
                  <td className={td}>{humanize(q.intent)}</td>
                  <td className={`${td} tabular-nums`}>{q.priority}</td>
                  <td className={td}>
                    {editor ? (
                      <form
                        action={toggleAiQueryAction.bind(null, orgSlug, q.id)}
                      >
                        <input
                          type="hidden"
                          name="enabled"
                          value={q.enabled ? "false" : "true"}
                        />
                        <SubmitButton variant="ghost">
                          {q.enabled ? "On" : "Off"}
                        </SubmitButton>
                      </form>
                    ) : q.enabled ? (
                      "On"
                    ) : (
                      "Off"
                    )}
                  </td>
                  <td className={td}>
                    {editor && (
                      <form
                        action={deleteAiQueryAction.bind(null, orgSlug, q.id)}
                      >
                        <SubmitButton
                          variant="ghost"
                          confirm="Delete this query?"
                        >
                          Delete
                        </SubmitButton>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          {editor && (
            <div className="mt-4">
              <ActionForm
                action={addAiQueryAction.bind(null, orgSlug, websiteId)}
                submitLabel="Add query"
                className="flex flex-wrap items-center gap-2"
              >
                <input
                  name="text"
                  placeholder="e.g. best emergency plumber in Leeds"
                  required
                  className={inputClass + " max-w-md"}
                />
                <select
                  name="intent"
                  defaultValue="DISCOVERY"
                  className={inputClass + " max-w-40"}
                  aria-label="Intent"
                >
                  {INTENTS.map((i) => (
                    <option key={i} value={i}>
                      {humanize(i)}
                    </option>
                  ))}
                </select>
                <input
                  name="priority"
                  type="number"
                  min={0}
                  max={10}
                  defaultValue={0}
                  className={inputClass + " max-w-20"}
                  aria-label="Priority"
                />
              </ActionForm>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card
          title={
            latestRun
              ? `Latest run · ${humanize(latestRun.provider)} · ${formatRelative(latestRun.createdAt)}`
              : "Results"
          }
        >
          {!latestRun ? (
            <Empty>No runs yet.</Empty>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
                <Badge value={latestRun.status} />
                <span>
                  Mentioned in <strong>{mentioned}</strong> of {ok.length}{" "}
                  answers
                </span>
                <span>
                  Website cited in <strong>{cited}</strong>
                </span>
                {latestRun.errorMessage && (
                  <span className="text-red-600">{latestRun.errorMessage}</span>
                )}
              </div>
              <Table
                head={[
                  "Query",
                  "Status",
                  "Mentioned",
                  "Recommendation",
                  "Cited",
                  "Time",
                ]}
              >
                {results.map((r) => (
                  <tr key={r.id}>
                    <td className={`${td} max-w-sm`}>
                      <div>{r.queryText}</div>
                      {r.answer && (
                        <details className="mt-1 text-xs text-zinc-500">
                          <summary className="cursor-pointer">Answer</summary>
                          <p className="mt-1 whitespace-pre-wrap">{r.answer}</p>
                        </details>
                      )}
                      {r.errorMessage && (
                        <div className="text-xs text-red-600">
                          {r.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className={td}>
                      <Badge
                        value={r.status}
                        tone={r.status === "SUCCESS" ? "green" : "red"}
                      />
                    </td>
                    <td className={td}>
                      <Badge
                        value={r.mentionStatus}
                        tone={
                          r.mentionStatus === "BRAND_MENTIONED"
                            ? "green"
                            : "zinc"
                        }
                      />
                    </td>
                    <td className={`${td} text-xs`}>
                      {humanize(r.recommendationStatus)}
                    </td>
                    <td className={td}>
                      {r.websiteCited === null
                        ? "—"
                        : r.websiteCited
                          ? "Yes"
                          : "No"}
                    </td>
                    <td className={`${td} tabular-nums text-xs`}>
                      {formatMs(r.latencyMs)}
                    </td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
