import type {
  CrawlRunStatus,
  RecommendationStatus,
  Role,
} from "@/generated/prisma/enums";
import {
  clientConfirmed,
  factWithSource,
  type Fact,
} from "@/lib/business/facts";
import { readWebsiteFacts } from "@/lib/business/load";
import {
  BUSINESS_TASK_MARK,
  CONTENT_TASK_MARK,
  canSeeBusiness,
} from "@/lib/business/visibility";
import { CONTENT_RULE_IDS, isContentRule } from "@/lib/knowledge/catalogue";
import { EVIDENCE_MAX_AGE_DAYS } from "@/lib/scoring/freshness";
import {
  CONTENT_GAP_RULE,
  LINK_RULE,
  NOT_DESCRIBED_RULE,
} from "@/lib/seo/content";
import type { TenantDb } from "@/lib/tenancy/scope";
import { splitTitle } from "./plan";

/**
 * The Content Plan: a client-ready list of content actions built only from
 * stored evidence, for the agency team to include in a report.
 *
 * Sources, nothing else:
 * - OPEN content findings (seo/content.ts) and the evidence recorded with
 *   them by a complete, recent crawl: pages that name a service without
 *   describing it, pages that name a service without linking to its page,
 *   and services never mentioned together with an approved location;
 * - the approved business facts they rest on, read again now: an action
 *   whose fact was since rejected, deleted or sent back for review is left
 *   out rather than shown;
 * - the content and new-page tasks in the SEO plan, for progress and for
 *   what the team dismissed (left out).
 *
 * Nothing is re-crawled or re-analysed here, and nothing is measured about
 * search demand or rankings. Evidence older than the crawl evidence limit
 * is left out of the plan (listed for the team to recheck), so the plan
 * never presents an old observation as a current problem.
 *
 * The plan is team-only (`canSeeBusiness`): `reportContentPlan` returns
 * nothing for other roles without reading anything.
 */

export type ActionKind = "describe" | "link" | "mention";
export type Progress = "to-do" | "in-progress" | "awaiting-check";

export type ContentAction = {
  /** Stable key: the finding fingerprint(s). */
  key: string;
  kind: ActionKind;
  /** The approved service it is about. */
  service: string;
  /** For "mention": the approved locations it is about. */
  locations: string[];
  /** What to do, in plain words. */
  title: string;
  /** Why, from what the crawl showed. */
  why: string;
  /** How to do it. */
  todo: string;
  /** The pages to change (at least one). */
  pages: string[];
  /** For links: the service page to link to. */
  target: string | null;
  /** For links: where the page already names the service. */
  passages: Array<{ url: string; passage: string }>;
  /** Pages to change beyond those listed. */
  morePages: number;
  /** The approved facts it rests on, with where each came from. */
  facts: string[];
  /** The same facts as stored now. */
  basis: Fact[];
  /** What to check with the client before publishing, if anything. */
  confirm: string | null;
  priority: "high" | "normal";
  priorityReason: string;
  /** What is true once it is done, and how UpSiteHealth confirms it. */
  doneWhen: string;
  /** The last complete crawl that showed it. */
  seenAt: Date;
  /** A later crawl that did not recheck it (incomplete), if any. */
  notRecheckedSince: Date | null;
  progress: Progress;
};

export type ContentGroup = {
  kind: ActionKind;
  title: string;
  intro: string;
  actions: ContentAction[];
};

export type HeldBack = { label: string; reason: string };

export type ContentPlan =
  | { state: "unavailable"; reason: string }
  | {
      state: "ready";
      groups: ContentGroup[];
      /** New pages already in the SEO plan (BIZ_ tasks not done or dismissed). */
      newPages: Array<{ title: string; progress: Progress }>;
      /** Team-only: left out of the plan, and why. */
      heldBack: HeldBack[];
      /** Team-only: content items whose task the team dismissed. */
      dismissed: number;
      /** Team-only: content findings marked ignored. */
      ignored: number;
      /** Number of actions in the plan. */
      total: number;
      /**
       * When the actions were last seen: the complete crawls they rest on
       * (earliest and latest), which can be older than the latest crawl.
       */
      seen: { from: Date; to: Date } | null;
      /** Distinct pages the actions change. */
      pagesToChange: number;
      /** The latest analysed crawl, and a note when it is not conclusive. */
      crawl: { analyzedAt: Date; note: string | null } | null;
      /** Facts behind the plan that the client has not confirmed. */
      unconfirmed: string | null;
    };

export type PlanFinding = {
  ruleId: string;
  fingerprint: string;
  evidence: unknown;
  lastSeenAt: Date;
};

export type ContentPlanInput = {
  /** OPEN content findings of the website. */
  findings: PlanFinding[];
  /** IGNORED content findings (counted only). */
  ignored: number;
  /** The website's facts now; null when the facts table does not exist. */
  facts: Fact[] | null;
  /** Content (CONTENT_) and new-page (BIZ_) tasks of the website. */
  tasks: Array<{ title: string; status: RecommendationStatus }>;
  /** The latest crawl with an SEO analysis, of any status. */
  latestCrawl: { analyzedAt: Date; status: CrawlRunStatus } | null;
  now: Date;
};

const DAY = 24 * 60 * 60 * 1000;
/** Clock and write-order slack between a crawl's analysis and its findings. */
const SAME_CRAWL_MS = 10 * 60 * 1000;
const MAX_PAGES_LISTED = 5;

const GROUPS: Record<ActionKind, { title: string; intro: string }> = {
  describe: {
    title: "Explain each service on its own page",
    intro:
      "These pages are about a service, but their main text never says what the service is. Visitors who land there should learn what it is, who it is for and how to get it.",
  },
  link: {
    title: "Help visitors reach service pages",
    intro:
      "These pages already talk about a service but do not link to the page about it. A link in that sentence takes interested visitors straight to the details.",
  },
  mention: {
    title: "Say where each service is offered",
    intro:
      "The site has a page for these services and for these places, but no page says the service is available there. Only add this where the client confirms it is true.",
  },
};
const ORDER: ActionKind[] = ["describe", "link", "mention"];

const RULE_KIND: Partial<Record<string, ActionKind>> = {
  [NOT_DESCRIBED_RULE]: "describe",
  [LINK_RULE]: "link",
  [CONTENT_GAP_RULE]: "mention",
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => !!str(x)) : [];
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const day = (d: Date) => d.toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const trim = (u: string) => u.replace(/\/+$/, "") || u;

/** What a task's status means for the actions it covers. */
function progressOf(status: RecommendationStatus | undefined): Progress {
  if (status === "COMPLETED") return "awaiting-check";
  if (status === "IN_PROGRESS") return "in-progress";
  return "to-do";
}

/** The task status per content rule (title ends in "(RULE)"). */
function ruleStatuses(tasks: ContentPlanInput["tasks"]) {
  const out = new Map<string, RecommendationStatus>();
  for (const t of tasks) {
    const { code } = splitTitle(t.title);
    if (code && isContentRule(code)) out.set(code, t.status);
  }
  return out;
}

/**
 * The evidence's facts, checked against the facts now: all still approved
 * (with today's wording and source), or the reason the action is left out.
 */
function currentFacts(
  evidence: Record<string, unknown>,
  facts: Fact[],
): { ok: Fact[] } | { reason: string } {
  const refs = Array.isArray(evidence.facts) ? evidence.facts : [];
  const ids = refs.map((f) => str(rec(f).id)).filter((x) => x !== null);
  if (!ids.length)
    return {
      reason: "The recorded evidence does not name its approved facts.",
    };
  const byId = new Map(facts.map((f) => [f.id, f]));
  const now = ids.map((id) => byId.get(id));
  if (now.some((f) => !f || f.status !== "APPROVED"))
    return {
      reason:
        "A business fact it rests on was changed, rejected or deleted since the crawl. The next complete crawl re-evaluates it.",
    };
  return { ok: now as Fact[] };
}

function confirmNote(facts: Fact[], extra?: string): string | null {
  const open = facts.filter((f) => !clientConfirmed(f));
  const parts = [
    ...(extra ? [extra] : []),
    ...(open.length
      ? [
          `Confirm ${open.map((f) => `“${f.value}”`).join(" and ")} with the client: our team recorded ${open.length === 1 ? "it" : "them"}, the client has not confirmed ${open.length === 1 ? "it" : "them"}.`,
        ]
      : []),
  ];
  return parts.length ? parts.join(" ") : null;
}

type Draft = Omit<ContentAction, "progress" | "notRecheckedSince" | "seenAt">;

/** One finding's action, or why it cannot be shown. */
function draftOf(
  ruleId: string,
  e: Record<string, unknown>,
  facts: Fact[],
  fingerprint: string,
): Draft | { reason: string } {
  const service = str(e.service);
  const factLines = facts.map(factWithSource);
  const basis = facts;
  if (!service)
    return { reason: "The recorded evidence does not name the service." };
  switch (RULE_KIND[ruleId]) {
    case "describe": {
      const url = str(e.url);
      if (!url)
        return { reason: "The recorded evidence does not name the page." };
      const where = strs(e.where);
      const words = num(e.mainWords);
      return {
        key: fingerprint,
        kind: "describe",
        service,
        locations: [],
        title: `Describe ${service} on its page`,
        why: `The page names ${service}${where.length ? ` in its ${list(where)}` : ""}, but its main text${words ? ` (${words} words)` : ""} never mentions it, so a visitor may not learn what it is or how to get it.`,
        todo: `Add a short section in the client's words: what ${service} is, who it is for, where it is offered and how to book or ask.`,
        pages: [url],
        target: null,
        passages: [],
        morePages: 0,
        facts: factLines,
        basis,
        confirm: confirmNote(facts),
        priority: "high",
        priorityReason: "The service's own page does not explain it.",
        doneWhen: `The page's main text names ${service}. Confirmed by the next complete crawl.`,
      };
    }
    case "link": {
      const target = str(e.target);
      const sources = (Array.isArray(e.sources) ? e.sources : [])
        .map((s) => ({ url: str(rec(s).url), passage: str(rec(s).passage) }))
        .filter((s): s is { url: string; passage: string } => !!s.url);
      if (!target || !sources.length)
        return {
          reason: !target
            ? "The recorded evidence does not name the page to link to."
            : "The recorded evidence does not name the pages to change.",
        };
      const total = Math.max(num(e.sourcesTotal) ?? 0, sources.length);
      const inbound = num(e.inboundPages);
      const poorly = e.poorlyConnected === true;
      return {
        key: fingerprint,
        kind: "link",
        service,
        locations: [],
        title: `Link to the ${service} page`,
        why: `${plural(total, "page")} already mention${total === 1 ? "s" : ""} ${service} but do${total === 1 ? "es" : ""} not link to its page${inbound !== null ? `, which ${inbound === 0 ? "no other page links to" : `only ${plural(inbound, "other page")} link${inbound === 1 ? "s" : ""} to`}` : ""}.`,
        todo: `Turn the words that name ${service} into a link to its page, where the sentence already talks about it.`,
        pages: sources.slice(0, MAX_PAGES_LISTED).map((s) => s.url),
        target,
        passages: sources.slice(0, MAX_PAGES_LISTED),
        morePages: Math.max(
          0,
          total - Math.min(sources.length, MAX_PAGES_LISTED),
        ),
        facts: factLines,
        basis,
        confirm: confirmNote(facts),
        priority: poorly ? "high" : "normal",
        priorityReason: poorly
          ? "The service page is hard to reach: at most one other page links to it."
          : "The service page is reachable, but not from pages that talk about it.",
        doneWhen: `Each listed page links to the ${service} page. Confirmed by the next complete crawl.`,
      };
    }
    case "mention": {
      const location = str(e.location);
      const pages = strs(e.locationPages);
      const servicePage = str(e.servicePage);
      if (!location)
        return { reason: "The recorded evidence does not name the location." };
      if (!pages.length && !servicePage)
        return {
          reason: "The recorded evidence does not name a page to change.",
        };
      return {
        key: fingerprint,
        kind: "mention",
        service,
        locations: [location],
        title: `Say where ${service} is offered`,
        why: `No page says ${service} is available in ${location}.`,
        todo: `If ${service} is offered there, say so on the location page or on the service page.`,
        pages: pages.length ? pages : [servicePage!],
        target: servicePage,
        passages: [],
        morePages: 0,
        facts: factLines,
        basis,
        confirm: confirmNote(
          facts,
          `The approved facts do not record where ${service} is offered: confirm ${location} with the client before writing.`,
        ),
        priority: "normal",
        priorityReason: "Needs the client's confirmation first.",
        doneWhen: `A page names ${service} together with ${location}. Confirmed by the next complete crawl.`,
      };
    }
    default:
      return {
        reason:
          "UpSiteHealth does not know how to present this kind of content finding yet.",
      };
  }
}

/**
 * Several locations for one service are one action: "Say where Wedding
 * flowers is offered: Leeds and York", with each location's pages.
 */
function mergeMentions(actions: ContentAction[]): ContentAction[] {
  const byService = new Map<string, ContentAction[]>();
  const out: ContentAction[] = [];
  for (const a of actions) {
    if (a.kind !== "mention") {
      out.push(a);
      continue;
    }
    const k = a.service.toLowerCase();
    byService.set(k, [...(byService.get(k) ?? []), a]);
  }
  for (const group of byService.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const first = group[0];
    const { service } = first;
    const places = [...new Set(group.flatMap((a) => a.locations))];
    const pages = [...new Set(group.flatMap((a) => a.pages))];
    const basis = [
      ...new Map(group.flatMap((a) => a.basis).map((f) => [f.id, f])).values(),
    ];
    const progress = group.map((a) => a.progress);
    out.push({
      ...first,
      key: group.map((a) => a.key).join("+"),
      locations: places,
      why: `No page says ${service} is available in ${list(places)}.`,
      pages: pages.slice(0, MAX_PAGES_LISTED),
      morePages: Math.max(0, pages.length - MAX_PAGES_LISTED),
      facts: basis.map(factWithSource),
      basis,
      confirm: confirmNote(
        basis,
        `The approved facts do not record where ${service} is offered: confirm ${list(places)} with the client before writing.`,
      ),
      doneWhen: `For each of ${list(places)}, a page names ${service} together with it. Confirmed by the next complete crawl.`,
      seenAt: new Date(Math.min(...group.map((a) => a.seenAt.getTime()))),
      notRecheckedSince:
        group.find((a) => a.notRecheckedSince)?.notRecheckedSince ?? null,
      // One rule, one task: the same progress for all of them.
      progress: progress[0],
    });
  }
  return out;
}

function seenRange(actions: ContentAction[]) {
  if (!actions.length) return null;
  const t = actions.map((a) => a.seenAt.getTime());
  return { from: new Date(Math.min(...t)), to: new Date(Math.max(...t)) };
}

export function buildContentPlan(input: ContentPlanInput): ContentPlan {
  if (input.facts === null)
    return {
      state: "unavailable",
      reason:
        "Business facts are not available on this database, so no content plan can be built.",
    };
  const { now, latestCrawl } = input;
  const statuses = ruleStatuses(input.tasks);
  const heldBack: HeldBack[] = [];
  let dismissed = 0;
  const seen = new Set<string>();
  const actions: ContentAction[] = [];

  for (const f of [...input.findings].sort((a, b) =>
    a.fingerprint.localeCompare(b.fingerprint),
  )) {
    if (!isContentRule(f.ruleId) || seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    const e = rec(f.evidence);
    const label = str(e.label) ?? str(e.service) ?? f.ruleId;
    const status = statuses.get(f.ruleId);
    if (status === "DISMISSED") {
      dismissed++;
      continue;
    }
    const ageDays = Math.floor((now.getTime() - f.lastSeenAt.getTime()) / DAY);
    if (ageDays > EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO) {
      heldBack.push({
        label,
        reason: `Last seen in a crawl on ${day(f.lastSeenAt)}, ${ageDays} days ago: too old to present as current. Run a complete crawl to check it again.`,
      });
      continue;
    }
    const facts = currentFacts(e, input.facts);
    if ("reason" in facts) {
      heldBack.push({ label, reason: facts.reason });
      continue;
    }
    const draft = draftOf(f.ruleId, e, facts.ok, f.fingerprint);
    if ("reason" in draft) {
      heldBack.push({
        label,
        reason: `${draft.reason} Run a complete crawl to record it again.`,
      });
      continue;
    }
    const later =
      latestCrawl &&
      latestCrawl.analyzedAt.getTime() - f.lastSeenAt.getTime() > SAME_CRAWL_MS
        ? latestCrawl.analyzedAt
        : null;
    actions.push({
      ...draft,
      seenAt: f.lastSeenAt,
      notRecheckedSince: later,
      progress: progressOf(status),
    });
  }

  const merged = mergeMentions(actions);
  const rank = (a: ContentAction) => (a.priority === "high" ? 0 : 1);
  const groups: ContentGroup[] = ORDER.map((kind) => ({
    kind,
    ...GROUPS[kind],
    actions: merged
      .filter((a) => a.kind === kind)
      .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)),
  })).filter((g) => g.actions.length > 0);

  const newPages = input.tasks
    .filter(
      (t) =>
        t.title.includes(BUSINESS_TASK_MARK) &&
        (t.status === "PROPOSED" || t.status === "IN_PROGRESS"),
    )
    .map((t) => ({
      title: splitTitle(t.title).displayTitle,
      progress: progressOf(t.status),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const usedFacts = new Map<string, Fact>();
  const factIds = new Set(
    input.findings.flatMap((f) =>
      (Array.isArray(rec(f.evidence).facts)
        ? (rec(f.evidence).facts as unknown[])
        : []
      )
        .map((x) => str(rec(x).id))
        .filter((x): x is string => !!x),
    ),
  );
  for (const fact of input.facts)
    if (fact.status === "APPROVED" && factIds.has(fact.id))
      usedFacts.set(fact.id, fact);
  const open = [...usedFacts.values()].filter((f) => !clientConfirmed(f));

  let note: string | null = null;
  if (latestCrawl) {
    const age = Math.floor(
      (now.getTime() - latestCrawl.analyzedAt.getTime()) / DAY,
    );
    if (latestCrawl.status !== "COMPLETED")
      note = `The latest crawl (${day(latestCrawl.analyzedAt)}) did not complete, so it could neither confirm nor clear these actions. They rest on the last complete crawl that showed them.`;
    else if (age > EVIDENCE_MAX_AGE_DAYS.TECHNICAL_SEO)
      note = `The latest crawl is ${age} days old. Run a new crawl before sharing so the plan reflects the site as it is now.`;
  }

  return {
    state: "ready",
    groups,
    newPages,
    heldBack,
    dismissed,
    ignored: input.ignored,
    total: groups.reduce((n, g) => n + g.actions.length, 0),
    pagesToChange: new Set(
      groups.flatMap((g) => g.actions.flatMap((a) => a.pages.map(trim))),
    ).size,
    seen: seenRange(groups.flatMap((g) => g.actions)),
    crawl: latestCrawl ? { analyzedAt: latestCrawl.analyzedAt, note } : null,
    unconfirmed: open.length
      ? `Some details come from our team, not yet from the client: ${open.map((f) => `“${f.value}”`).join(", ")}. Confirm them before publishing.`
      : null,
  };
}

/** Reads what the plan needs for one website (tenant-scoped). */
export async function loadContentPlan(
  db: TenantDb,
  websiteId: string,
  now = new Date(),
): Promise<ContentPlan> {
  // Sequential: the local single-connection database cannot interleave.
  const facts = await readWebsiteFacts(db, websiteId);
  const findings = await db.seoFinding.findMany({
    where: { websiteId, status: "OPEN", ruleId: { in: CONTENT_RULE_IDS } },
    select: {
      ruleId: true,
      fingerprint: true,
      evidence: true,
      lastSeenAt: true,
    },
    orderBy: { fingerprint: "asc" },
  });
  const ignored = await db.seoFinding.count({
    where: { websiteId, status: "IGNORED", ruleId: { in: CONTENT_RULE_IDS } },
  });
  const tasks = await db.recommendation.findMany({
    where: {
      websiteId,
      OR: [
        { title: { contains: CONTENT_TASK_MARK } },
        { title: { contains: BUSINESS_TASK_MARK } },
      ],
    },
    select: { title: true, status: true },
  });
  const latest = await db.crawlRun.findFirst({
    where: { websiteId, seoAnalyzedAt: { not: null } },
    orderBy: { seoAnalyzedAt: "desc" },
    select: { seoAnalyzedAt: true, status: true },
  });
  return buildContentPlan({
    findings,
    ignored,
    facts,
    tasks,
    latestCrawl: latest
      ? { analyzedAt: latest.seoAnalyzedAt!, status: latest.status }
      : null,
    now,
  });
}

/** Whether the report includes the plan, from its `content` parameter. */
export const includeParam = (raw: unknown) => raw === "include";

/**
 * The plan for the Report page, decided on the server: null for anyone
 * who may not see business content (the plan is never read for them,
 * whatever the URL says); otherwise the plan and whether it is included
 * in the report (it is always available to the team for review).
 */
export async function reportContentPlan(
  role: Role,
  raw: unknown,
  load: () => Promise<ContentPlan>,
): Promise<{ plan: ContentPlan; included: boolean } | null> {
  if (!canSeeBusiness(role)) return null;
  return { plan: await load(), included: includeParam(raw) };
}
