import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/ui/action-form";
import { Badge, type Tone } from "@/components/ui/badge";
import { Callout } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/layout";
import { WebsiteNav } from "@/components/website-nav";
import { db } from "@/lib/db";
import { formatRelative } from "@/lib/format";
import {
  evaluateIntegrations,
  type IntegrationState,
  type IntegrationStatus,
} from "@/lib/integrations/evaluate";
import { loadIntegrationEvidence } from "@/lib/integrations/load";
import { BENEFIT } from "@/lib/recommendations/benefits";
import { requireOrgContext } from "@/lib/tenancy/context";
import { can } from "@/lib/tenancy/roles";
import { runIntegrationCheckAction } from "../../../insights-actions";

export const metadata: Metadata = { title: "Integrations · UpSiteHealth" };

const STATE: Record<IntegrationState, { tone: Tone; label: string }> = {
  verified: { tone: "success", label: "Verified" },
  detected: { tone: "info", label: "Detected" },
  "needs-attention": { tone: "warning", label: "Needs attention" },
  "not-detected": { tone: "neutral", label: "Not detected" },
  "not-checked": { tone: "neutral", label: "Not checked" },
};

const LEGEND: Array<[IntegrationState, string]> = [
  ["verified", "A direct functional check passed."],
  [
    "detected",
    "Found in the public page source. Not proof that it works or collects data.",
  ],
  ["needs-attention", "Missing, broken, duplicated or outdated."],
  ["not-detected", "Not found. Fine for optional tools."],
  [
    "not-checked",
    "No data yet, or the stored data predates this check. Never counted as missing.",
  ],
];

function stateBadge(s: IntegrationStatus) {
  const meta = STATE[s.state];
  const label =
    s.state === "not-checked" && s.headline.startsWith("Not measured")
      ? "Not measured"
      : s.state === "not-detected" && s.optional
        ? "Not in use"
        : meta.label;
  return <Badge value={s.state} tone={meta.tone} label={label} dot />;
}

const SEVERITY_TONE = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "neutral",
  INFO: "neutral",
} as const;

export default async function IntegrationsPage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/integrations">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();
  // Root client with an explicit scope; the website was verified above.
  const evidence = await loadIntegrationEvidence(db(), {
    websiteId,
    organizationId: ctx.organization.id,
  });
  if (!evidence) notFound();
  const statuses = evaluateIntegrations(evidence);
  const editor = can.editWebsites(ctx.role);
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  const counts = Object.fromEntries(
    (Object.keys(STATE) as IntegrationState[]).map((k) => [
      k,
      statuses.filter((s) => s.state === k).length,
    ]),
  ) as Record<IntegrationState, number>;

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Integrations" },
        ]}
        title="Integrations"
        subtitle="Search, analytics and crawling setup, checked from the public site. UpSiteHealth never installs tags or changes your website."
        meta={
          <span className="text-xs text-muted">
            {evidence.probe
              ? `Last integration check ${formatRelative(evidence.probe.checkedAt)}`
              : "No integration check yet"}
            {" · "}
            {evidence.crawl
              ? `crawl analysed ${formatRelative(evidence.crawl.analyzedAt)}`
              : "not crawled yet"}
          </span>
        }
        actions={
          editor && (
            <ActionForm
              action={runIntegrationCheckAction.bind(null, orgSlug, websiteId)}
              submitLabel="Run integration check"
              pendingLabel="Starting…"
              variant="secondary"
              className="flex flex-col items-end gap-2"
            />
          )
        }
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <div className="mb-6 rounded-xl border border-line bg-surface p-5 shadow-card">
        <ul className="flex flex-wrap gap-2" aria-label="Integrations by state">
          {(Object.keys(STATE) as IntegrationState[]).map((k) => (
            <li key={k}>
              <Badge
                value={k}
                tone={counts[k] ? STATE[k].tone : "neutral"}
                label={`${counts[k]} ${STATE[k].label.toLowerCase()}`}
              />
            </li>
          ))}
        </ul>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {LEGEND.map(([k, text]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 font-medium text-ink">
                {STATE[k].label}:
              </dt>
              <dd className="text-muted">{text}</dd>
            </div>
          ))}
        </dl>
      </div>

      {!evidence.probe && (
        <div className="mb-6">
          <Callout tone="info" title="Run the first integration check">
            robots.txt, sitemaps, DNS verification records, Bing verification
            and Tag Manager availability are checked by a short, public
            integration check. It also runs automatically about once a day.
          </Callout>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {statuses.map((s) => (
          <section
            key={s.key}
            aria-labelledby={`int-${s.key}`}
            className="flex flex-col rounded-xl border border-line bg-surface p-5 shadow-card"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2
                  id={`int-${s.key}`}
                  className="text-sm font-semibold text-ink"
                >
                  {s.name}
                  {s.optional && (
                    <span className="font-normal text-muted"> · optional</span>
                  )}
                </h2>
                <p className="text-xs text-muted">
                  {BENEFIT[s.benefit].label}
                  {s.checkedAt && ` · checked ${formatRelative(s.checkedAt)}`}
                </p>
              </div>
              {stateBadge(s)}
            </div>
            <p className="mt-3 text-sm font-medium text-ink">{s.headline}</p>
            <p className="mt-1 text-xs text-muted">{BENEFIT[s.benefit].text}</p>
            {s.evidence.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-sm text-ink-2">
                {s.evidence.map((e) => (
                  <li key={e} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            )}
            {s.problems.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2">
                {s.problems.map((p) => (
                  <li
                    key={p.code}
                    className="rounded-lg border border-line bg-subtle px-3 py-2"
                  >
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      <Badge
                        value={p.severity}
                        tone={SEVERITY_TONE[p.severity]}
                      />
                      {p.title}
                    </p>
                    <p className="mt-1 text-sm text-ink-2">{p.summary}</p>
                    <p className="mt-1 text-sm text-ink">
                      <span className="font-medium">Next step:</span> {p.action}
                    </p>
                    {p.urls.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs font-medium text-brand-700">
                          Affected URLs ({p.urls.length}
                          {p.urls.length >= 50 ? "+" : ""})
                        </summary>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {p.urls.map((u) => (
                            <li
                              key={u}
                              className="break-all text-xs text-ink-2"
                            >
                              {u}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-auto pt-3 text-xs text-muted">
              <p>
                <span className="font-medium text-ink-2">
                  How it is verified:
                </span>{" "}
                {s.verification}
              </p>
              {s.limitations.map((l) => (
                <p key={l} className="mt-1">
                  {l}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-6 text-sm text-muted">
        Setup tasks appear in{" "}
        <Link
          href={`${base}/recommendations`}
          className="text-brand-700 hover:underline"
        >
          Recommendations
        </Link>
        . Connecting Search Console, Google Analytics and Tag Manager with
        read-only access, to verify data directly, is planned.
      </p>
    </>
  );
}
