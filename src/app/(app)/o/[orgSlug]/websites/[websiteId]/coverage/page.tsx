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
import {
  factLabel,
  SOURCE_LABEL,
  unconfirmedFactsNote,
} from "@/lib/business/facts";
import {
  buildKeywordMap,
  MAX_CANDIDATES,
  type KeywordCandidate,
  type MappingState,
} from "@/lib/business/keywords";
import type { OpportunityState } from "@/lib/business/opportunities";
import { buildTopicMap, type TopicState } from "@/lib/business/topics";
import type { FreshnessState } from "@/lib/scoring/freshness";
import { readWebsiteFacts } from "@/lib/business/load";
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
const TOPIC_STATE: Record<
  TopicState,
  { label: string; tone: Tone; meaning: string }
> = {
  covered: {
    label: "Covered",
    tone: "success",
    meaning: "a page is about it, can be indexed and has enough main content",
  },
  partial: {
    label: "Partly covered",
    tone: "warning",
    meaning:
      "pages mention it, or the page about it is thin, noindex or canonicalised elsewhere",
  },
  none: {
    label: "No page",
    tone: "danger",
    meaning: "no analysed page names it, on a complete and recent crawl",
  },
  "not-checked": {
    label: "Not checked",
    tone: "neutral",
    meaning:
      "the crawl was missing, partial, limited or out of date, so a missing page cannot be confirmed",
  },
};
const MAPPING: Record<
  MappingState,
  { label: string; tone: Tone; meaning: string }
> = {
  mapped: {
    label: "Mapped",
    tone: "success",
    meaning: "the page that covers its topic serves it",
  },
  weak: {
    label: "No sufficient page",
    tone: "warning",
    meaning:
      "pages only mention it, or the page about it is thin, noindex or canonicalised elsewhere",
  },
  unmapped: {
    label: "Unmapped",
    tone: "danger",
    meaning: "no page serves it, on a complete and recent crawl",
  },
  "not-checked": {
    label: "Not checked",
    tone: "neutral",
    meaning:
      "the crawl was missing, partial, limited or out of date, so a missing page cannot be confirmed",
  },
};
/** Candidates listed before "Show all". */
const KEYWORDS_SHOWN = 20;
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

function KeywordRow({
  k,
  crawl,
}: {
  k: KeywordCandidate;
  /** The crawl's freshness; a page found on an old crawl may have changed. */
  crawl: FreshnessState | null;
}) {
  const m = k.mapping;
  return (
    <li className="flex flex-col gap-1 px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{k.text}</span>
        <span className="text-xs text-muted">
          {k.kind === "service" ? "Service" : "Service and location"}
        </span>
        <Badge
          value={m.state}
          tone={MAPPING[m.state].tone}
          label={MAPPING[m.state].label}
          dot
        />
      </div>
      {m.page ? (
        <p className="text-sm text-ink-2">
          <span className="break-all font-mono text-xs">{m.page}</span>
          <span className="text-xs text-muted">
            {" "}
            · {m.where.join(", ")} ·{" "}
            {m.wordingOnPage
              ? "this wording is on the page"
              : "this wording is not on the page"}
          </span>
        </p>
      ) : (
        <p className="text-sm text-ink-2">{m.reason}</p>
      )}
      {m.state === "mapped" && crawl && crawl !== "fresh" && (
        <p className="text-xs font-medium text-warning-700">
          From a crawl that is{" "}
          {crawl === "stale"
            ? "out of date"
            : crawl === "incomplete"
              ? "incomplete"
              : "of unknown age"}
          : the page may have changed since.
        </p>
      )}
      <p className="text-xs text-muted">
        From:{" "}
        {k.from
          .map(
            (f) =>
              `“${f.wording}” (${f.isName ? "name" : "other wording"}, ${SOURCE_LABEL[f.source].toLowerCase()}${f.approvedAt ? `, approved ${formatDateTime(f.approvedAt)}` : ""})`,
          )
          .join(" + ")}
      </p>
    </li>
  );
}

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
  const facts = await readWebsiteFacts(ctx.db, websiteId);
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
  // Read-only: topics create no findings, tasks or score changes.
  const topics = buildTopicMap({
    facts,
    pages: c.pages,
    crawl: c.crawl,
    crawlId: evidence?.crawl?.id ?? null,
    errorPages: (evidence?.crawl?.pages ?? []).filter(
      (p) => p.status === "CRAWLED" && (p.httpStatus ?? 0) >= 400,
    ),
    now: new Date(),
  });
  // Read-only, provider-neutral: nothing measured, nothing planned.
  const keywords = buildKeywordMap({ facts, map: topics, pages: c.pages });
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

      {(topics.topics.length > 0 || topics.suppressed.length > 0) && (
        <section
          aria-labelledby="topics"
          className="mt-6 flex flex-col gap-3"
        >
          <div>
            <h2 id="topics" className="text-base font-semibold text-ink">
              Topics
            </h2>
            <p className="text-sm text-muted">
              The topics the approved services
              {topics.locationNote?.startsWith("Each") ? " and locations" : ""}{" "}
              call for, and the crawled page that serves each. For information
              only: nothing here changes the plan or the score.
            </p>
          </div>
          {topics.crawl ? (
            <Callout
              tone={
                topics.crawl.gap || topics.crawl.freshness.state !== "fresh"
                  ? "warning"
                  : "info"
              }
              title={`Crawl ${topics.crawl.id ?? "(id not recorded)"}, analysed ${formatDateTime(topics.crawl.analyzedAt)}`}
            >
              {topics.crawl.freshness.reason}{" "}
              {topics.crawl.gap
                ? `${topics.crawl.gap} Topics without a page are "Not checked", not "No page".`
                : "The crawl completed within its limits."}
            </Callout>
          ) : (
            <Callout tone="info" title="No analysed crawl yet">
              Every topic is &ldquo;Not checked&rdquo; until a crawl is analysed.
            </Callout>
          )}
          <Card padded={false}>
            <ul className="divide-y divide-line">
              {topics.topics.map((t) => (
                <li key={t.key} className="flex flex-col gap-1 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{t.label}</span>
                    <Badge
                      value={t.state}
                      tone={TOPIC_STATE[t.state].tone}
                      label={TOPIC_STATE[t.state].label}
                      dot
                    />
                  </div>
                  <p className="text-sm text-ink-2">{t.reason}</p>
                  {(t.state === "covered" || t.state === "partial") &&
                    topics.crawl &&
                    topics.crawl.freshness.state !== "fresh" && (
                      <p className="text-xs font-medium text-warning-700">
                        From a crawl that is{" "}
                        {topics.crawl.freshness.state === "stale"
                          ? "out of date"
                          : topics.crawl.freshness.state === "incomplete"
                            ? "incomplete"
                            : "of unknown age"}
                        : the page may have changed since.
                      </p>
                    )}
                  {t.audiences.length > 0 && (
                    <p className="text-xs text-muted">
                      For: {t.audiences.map((a) => factLabel(a)).join("; ")}
                    </p>
                  )}
                  {unconfirmedFactsNote(t.facts) && (
                    <p className="text-xs text-muted">
                      {unconfirmedFactsNote(t.facts)}
                    </p>
                  )}
                  {t.evidence.length > 0 && (
                    <details className="mt-1 text-xs text-ink-2">
                      <summary className="cursor-pointer font-medium text-brand-700">
                        Evidence: {t.pagesMatched} page
                        {t.pagesMatched === 1 ? "" : "s"}
                        {t.pagesMatched > t.evidence.length
                          ? ` (best ${t.evidence.length} shown)`
                          : ""}
                      </summary>
                      <ul className="mt-1 flex flex-col gap-1.5">
                        {t.evidence.map((e) => (
                          <li key={e.url}>
                            <span className="break-all font-mono">{e.url}</span>
                            <p>{e.verdict}</p>
                            {e.matched.length > 0 && (
                              <p className="text-muted">
                                Wording found:{" "}
                                {e.matched.map((w) => `“${w}”`).join(", ")}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <dl className="grid gap-1 text-xs text-muted sm:grid-cols-2">
            {(Object.keys(TOPIC_STATE) as TopicState[]).map((s) => (
              <div key={s}>
                <dt className="inline font-medium text-ink-2">
                  {TOPIC_STATE[s].label}:
                </dt>{" "}
                <dd className="inline">{TOPIC_STATE[s].meaning}.</dd>
              </div>
            ))}
          </dl>
          {(topics.locationNote ||
            topics.omitted > 0 ||
            topics.suppressed.length > 0) && (
            <ul className="flex flex-col gap-0.5 text-xs text-muted">
              {topics.locationNote && <li>{topics.locationNote}</li>}
              {topics.omitted > 0 && (
                <li>
                  {topics.omitted} more topic{topics.omitted === 1 ? "" : "s"}{" "}
                  not shown: at most 50 are mapped (every service first, then
                  service and location pairs).
                </li>
              )}
              {topics.suppressed.map((x) => (
                <li key={x.label}>
                  &ldquo;{x.label}&rdquo; is left out: marked as not offered
                  (&ldquo;{x.by}&rdquo;).
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            Topic rules {topics.version}. Audiences are shown as context; they
            are not topics of their own.
          </p>
        </section>
      )}

      {(keywords.candidates.length > 0 || keywords.omitted > 0) && (
        <section
          aria-labelledby="keywords"
          className="mt-6 flex flex-col gap-3"
        >
          <div>
            <h2 id="keywords" className="text-base font-semibold text-ink">
              Keyword candidates
            </h2>
            <p className="text-sm text-muted">
              Search terms the approved facts suggest (their names and other
              wordings, and service with location), and the crawled page
              that serves each. For information only: nothing here changes
              the plan or the score.
            </p>
          </div>
          <Callout tone="info" title="Search volume is not measured">
            These are candidates, not keywords people are known to search
            for. No keyword data provider is connected, so there is no
            search volume, ranking or traffic data
            {keywords.crawl
              ? `. Mapped from crawl ${keywords.crawl.id ?? "(id not recorded)"}, analysed ${formatDateTime(keywords.crawl.analyzedAt)}: ${keywords.crawl.freshness.reason}`
              : ". No analysed crawl yet, so no candidate is mapped"}
          </Callout>
          <Card padded={false}>
            <ul className="divide-y divide-line">
              {keywords.candidates.slice(0, KEYWORDS_SHOWN).map((k) => (
                <KeywordRow
                  key={k.key}
                  k={k}
                  crawl={keywords.crawl?.freshness.state ?? null}
                />
              ))}
            </ul>
            {keywords.candidates.length > KEYWORDS_SHOWN && (
              <details className="border-t border-line">
                <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-brand-700">
                  Show all {keywords.candidates.length} candidates
                </summary>
                <ul className="divide-y divide-line border-t border-line">
                  {keywords.candidates.slice(KEYWORDS_SHOWN).map((k) => (
                    <KeywordRow
                  key={k.key}
                  k={k}
                  crawl={keywords.crawl?.freshness.state ?? null}
                />
                  ))}
                </ul>
              </details>
            )}
          </Card>
          {keywords.crawl && (
            <Card title="Possible overlap" padded={false}>
              {keywords.overlaps.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">
                  No two analysed pages are each about the same candidate.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {keywords.overlaps.map((o) => (
                    <li
                      key={`${o.topicKey}|${o.pages.map((p) => p.url).join("|")}`}
                      className="flex flex-col gap-1 px-5 py-4"
                    >
                      <p className="font-medium text-ink">
                        {o.candidates.map((t) => `“${t}”`).join(", ")}
                      </p>
                      <p className="text-sm text-ink-2">{o.reason}</p>
                      {keywords.crawl!.freshness.state !== "fresh" && (
                        <p className="text-xs font-medium text-warning-700">
                          From a crawl that is not current: the pages may have
                          changed since.
                        </p>
                      )}
                      <ul className="flex flex-col gap-0.5">
                        {o.pages.map((p) => (
                          <li key={p.url} className="text-xs text-ink-2">
                            <span className="break-all font-mono">
                              {p.url}
                            </span>
                            <span className="text-muted">
                              {" "}
                              · {p.where.join(", ")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <dl className="grid gap-1 text-xs text-muted sm:grid-cols-2">
            {(Object.keys(MAPPING) as MappingState[]).map((s) => (
              <div key={s}>
                <dt className="inline font-medium text-ink-2">
                  {MAPPING[s].label}:
                </dt>{" "}
                <dd className="inline">{MAPPING[s].meaning}.</dd>
              </div>
            ))}
          </dl>
          <ul className="flex flex-col gap-0.5 text-xs text-muted">
            {keywords.omitted > 0 && (
              <li>
                {keywords.omitted} more candidate
                {keywords.omitted === 1 ? "" : "s"} not shown: at most{" "}
                {MAX_CANDIDATES} are listed (services first).
              </li>
            )}
            {keywords.addresses.map((a) => (
              <li key={a}>
                &ldquo;{a}&rdquo; is an address, not a search term: its other
                wordings are used instead.
              </li>
            ))}
            <li>
              Keyword rules {keywords.version}. Only approved wordings are
              used; no modifiers such as &ldquo;near me&rdquo; are added.
              Possible overlap is not a ranking problem: whether pages compete
              is not measured.
            </li>
          </ul>
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
                  {unconfirmedFactsNote(n.facts) && (
                    <p className="text-xs text-muted">
                      {unconfirmedFactsNote(n.facts)}
                    </p>
                  )}
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
