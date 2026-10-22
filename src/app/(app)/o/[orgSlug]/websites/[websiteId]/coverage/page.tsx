import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, type Tone } from "@/components/ui/badge";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { Card, LinkButton, PageHeader } from "@/components/ui/layout";
import { Stat } from "@/components/ui/metric";
import { FactsUnavailable } from "@/components/facts-unavailable";
import { WebsiteNav } from "@/components/website-nav";
import { OpportunityCard } from "@/components/opportunity-card";
import {
  analyzeCoverage,
  type NeedKind,
  type NeedStatus,
} from "@/lib/business/coverage";
import { factLabel } from "@/lib/business/facts";
import type { OpportunityState } from "@/lib/business/opportunities";
import { readFacts } from "@/lib/business/load";
import { canSeeBusiness } from "@/lib/business/visibility";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { loadIntegrationEvidence } from "@/lib/integrations/load";
import { requireOrgContext } from "@/lib/tenancy/context";
import { decideOpportunityAction } from "../../../business-actions";

export const metadata: Metadata = { title: "Coverage · UpSiteHealth" };

const STATUS: Record<NeedStatus, { label: string; tone: Tone }> = {
  covered: { label: "Covered", tone: "success" },
  ambiguous: { label: "Several pages", tone: "warning" },
  weak: { label: "Weak match", tone: "warning" },
  missing: { label: "No page found", tone: "danger" },
  "not-confirmed": { label: "Not confirmed", tone: "info" },
  "not-checked": { label: "Not checked", tone: "neutral" },
};
const KIND: Record<NeedKind, string> = {
  "service-page": "Service page",
  "location-page": "Location page",
  "location-mention": "Location named on the site",
  "service-areas": "Service areas named",
  "contact-path": "Way to get in touch",
};
const PAGE_TYPE: Record<string, string> = {
  home: "Home",
  service: "Service",
  location: "Location",
  product: "Product",
  category: "Category",
  article: "Article",
  about: "About",
  contact: "Contact",
  legal: "Legal",
  unknown: "Unclear",
};

export default async function CoveragePage({
  params,
}: PageProps<"/o/[orgSlug]/websites/[websiteId]/coverage">) {
  const { orgSlug, websiteId } = await params;
  const ctx = await requireOrgContext(orgSlug);
  if (!canSeeBusiness(ctx.role)) notFound();
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, name: true },
  });
  if (!website) notFound();
  const facts = await readFacts(() =>
    ctx.db.businessFact.findMany({
      where: { websiteId },
      select: {
        id: true,
        kind: true,
        value: true,
        synonyms: true,
        source: true,
        status: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
  const base = `/o/${orgSlug}/websites/${websiteId}`;
  if (facts === null)
    return (
      <>
        <PageHeader
          breadcrumbs={[
            { label: "Websites", href: `/o/${orgSlug}/websites` },
            { label: website.name, href: base },
            { label: "Coverage" },
          ]}
          title="Business coverage"
        />
        <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />
        <FactsUnavailable />
      </>
    );
  // Root client with an explicit scope; the website was verified above.
  const evidence = await loadIntegrationEvidence(db(), {
    websiteId,
    organizationId: ctx.organization.id,
  });
  const tasks = await ctx.db.recommendation.findMany({
    where: { websiteId, title: { contains: "(BIZ_" } },
    select: { title: true, status: true },
  });
  const profile = await ctx.db.aiSearchProfile.findFirst({
    where: { websiteId },
    select: { brandName: true, legalName: true, aliases: true },
  });
  const c = analyzeCoverage({
    websiteUrl: evidence?.websiteUrl ?? "https://invalid.example/",
    crawl: evidence?.crawl ?? null,
    facts,
    existing: new Map(tasks.map((t) => [t.title, t.status])),
    brandNames: profile
      ? [profile.brandName, profile.legalName ?? "", ...profile.aliases]
      : [],
  });
  const types = Object.entries(
    c.pages.reduce<Record<string, number>>((acc, p) => {
      acc[p.type] = (acc[p.type] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  const opps = c.opportunities;
  const count = (states: OpportunityState[]) =>
    opps.filter((o) => states.includes(o.state) && o.decision !== "dismissed")
      .length;
  // Saved tasks, not what the opportunities would add.
  const taskOf = new Map(tasks.map((t) => [t.title, t]));
  const inPlan = opps.filter((o) =>
    ["PROPOSED", "IN_PROGRESS"].includes(taskOf.get(o.key)?.status ?? ""),
  ).length;
  const checks = c.needs.filter(
    (n) => n.kind === "location-mention" || n.kind === "service-areas",
  );
  const decide = (key: string) =>
    decideOpportunityAction.bind(null, orgSlug, websiteId, key);

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: "Websites", href: `/o/${orgSlug}/websites` },
          { label: website.name, href: base },
          { label: "Coverage" },
        ]}
        title="Business coverage"
        subtitle="Which pages the business may be missing, and which existing pages already serve its approved services, locations and goals, judged from the latest crawl. A page the crawler found is not necessarily indexed by Google, and a missing page is not automatically a problem."
      />
      <WebsiteNav orgSlug={orgSlug} websiteId={websiteId} />

      <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Approved facts"
          value={c.approvedFacts.length}
          hint={
            c.pendingFacts
              ? `${c.pendingFacts} awaiting review, not used`
              : "Used for coverage"
          }
        />
        <Stat
          label="New pages in the plan"
          value={inPlan}
                    hint="Saved tasks for page opportunities"
          href={inPlan ? `${base}/plan` : undefined}
        />
        <Stat
          label="Need a decision"
          value={count(["review", "weak", "incomplete"])}
          tone={count(["review", "weak", "incomplete"]) ? "warning" : "default"}
          hint="Review, weak page or incomplete crawl"
        />
        <Stat
          label="Already covered"
          value={count(["fulfilled"])}
          tone="success"
          hint="An existing page fulfils the purpose"
        />
      </dl>

      <div className="mb-6">
        {!c.crawl ? (
          <Callout tone="info" title="No analysed crawl yet">
            Crawl the site first; coverage is judged from the pages it finds.
          </Callout>
        ) : (
          <Callout
            tone={c.crawl.gap ? "warning" : "info"}
            title={`From the crawl analysed ${formatDateTime(c.crawl.analyzedAt)}: ${c.crawl.analysedPages} page${c.crawl.analysedPages === 1 ? "" : "s"} analysed`}
          >
            {c.crawl.gap
              ? `${c.crawl.gap} Missing pages cannot be confirmed, so opportunities need review instead of being added to the plan.`
              : "The crawl completed within its limits, so pages not found here were looked for on every page it reached."}{" "}
            Pages are judged from titles, headings, descriptions, link text and
            structured data; body text is not stored.
          </Callout>
        )}
      </div>

      {c.approvedFacts.length === 0 ? (
        <Card>
          <EmptyState
            title="No approved business facts yet"
            description={
              c.pendingFacts
                ? `${c.pendingFacts} fact${c.pendingFacts === 1 ? " is" : "s are"} awaiting review. Page opportunities use approved facts only.`
                : "Add the services, locations and goals of the business, then approve them. Page opportunities use approved facts only."
            }
            action={
              <LinkButton href={`${base}/business`}>
                Open Business profile
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <section aria-labelledby="opportunities" className="flex flex-col gap-3">
          <div>
            <h2 id="opportunities" className="text-base font-semibold text-ink">
              Page opportunities
            </h2>
            <p className="text-sm text-muted">
              Pages that may help this business, from approved facts only.
              Confirmed ones join the SEO plan; the others wait for your
              decision. Nothing is published on the website.
            </p>
          </div>
          {opps.length === 0 ? (
            <Card>
              <p className="text-sm text-muted">
                No page opportunities: approved services, locations and goals
                do not call for new pages yet.
              </p>
            </Card>
          ) : (
            <ul className="flex flex-col gap-3">
              {opps.map((o) => (
                <OpportunityCard
                  key={o.key}
                  o={o}
                  task={taskOf.get(o.key) ?? null}
                  action={decide(o.key)}
                  planHref={`${base}/plan`}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {checks.length > 0 && (
        <div className="mt-6">
          <Card title="Other coverage checks" padded={false}>
            <ul className="divide-y divide-line">
              {checks.map((n) => (
                <li key={n.key} className="flex flex-col gap-1 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">
                      {n.facts.map((f) => factLabel(f)).join(", ")}
                    </span>
                    <span className="text-xs text-muted">{KIND[n.kind]}</span>
                    <Badge
                      value={n.status}
                      tone={STATUS[n.status].tone}
                      label={STATUS[n.status].label}
                      dot
                    />
                    {n.recommend && (
                      <Badge value="plan" tone="brand" label="Recommended" />
                    )}
                  </div>
                  <p className="text-sm text-ink-2">{n.note}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {(c.reviews.length > 0 || c.clarifications.length > 0) && (
        <div className="mt-6">
          <Card title="Worth a look" padded={false}>
            <ul className="divide-y divide-line">
              {c.clarifications.map((r) => (
                <li key={r.title} className="px-5 py-4">
                  <p className="font-medium text-ink">{r.title}</p>
                  <p className="text-sm text-ink-2">{r.detail}</p>
                </li>
              ))}
              {c.reviews.map((r) => (
                <li key={r.title} className="px-5 py-4">
                  <p className="font-medium text-ink">{r.title}</p>
                  <p className="text-sm text-ink-2">{r.detail}</p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {r.urls.map((u) => (
                      <li
                        key={u}
                        className="break-all font-mono text-xs text-ink-2"
                      >
                        {u}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {c.pages.length > 0 && (
        <div className="mt-6">
          <Card
            title="How the pages were understood"
            description={types.map(([t, n]) => `${PAGE_TYPE[t]} ${n}`).join(" · ")}
            padded={false}
          >
            <ul className="divide-y divide-line">
              {c.pages.map((p) => (
                <li key={p.url}>
                  <details className="group px-5 py-3">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
                      <Badge
                        value={p.type}
                        tone={p.type === "unknown" ? "neutral" : "brand"}
                        label={PAGE_TYPE[p.type]}
                      />
                      <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink-2">
                        {p.path || "/"}
                      </span>
                      <span className="text-xs text-muted">
                        {p.type === "unknown"
                          ? p.candidate
                            ? `possibly ${PAGE_TYPE[p.candidate].toLowerCase()}`
                            : "no clear signal"
                          : `${p.confidence} confidence`}
                      </span>
                    </summary>
                    <div className="mt-2 flex flex-col gap-1 text-xs text-ink-2">
                      {p.fullTitle && <p>Title: {p.fullTitle}</p>}
                      {p.h1[0] && <p>Main heading: {p.h1[0]}</p>}
                      <p>Signals: {p.signals.join("; ")}</p>
                      {(p.noindex || p.canonicalElsewhere) && (
                        <p className="text-warning-700">
                          {p.noindex
                            ? "Asks search engines not to index it."
                            : "Canonical points at another URL."}
                        </p>
                      )}
                      {c.pageFacts.get(p.url) && (
                        <p>Serves: {c.pageFacts.get(p.url)!.join(", ")}</p>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
      <p className="mt-6 text-xs text-muted">
        Coverage rules {c.version}. Visible to your team only.{" "}
        <Link href={`${base}/business`} className="font-medium text-brand-700 hover:underline">
          Edit business facts →
        </Link>
      </p>
    </>
  );
}
