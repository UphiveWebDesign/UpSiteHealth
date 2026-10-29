"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { normalizeQueryText } from "@/lib/ai-search/analysis";
import {
  configuredProviders,
  makeProvider,
  providerModel,
} from "@/lib/ai-search/config";
import { providerUnavailableMessage } from "@/lib/ai-search/providers";
import {
  AiSearchError,
  executeAiSearchRun,
  startAiSearchRun,
} from "@/lib/ai-search/runner";
import { processCrawls } from "@/lib/crawler/scheduler";
import { refreshActionPlan } from "@/lib/recommendations/after-crawl";
import {
  queueAutomaticCrawl,
  verificationNote,
  type QueueOutcome,
} from "@/lib/crawler/schedule";
import { db } from "@/lib/db";
import { log, runBackground } from "@/lib/log";
import { serverEnv } from "@/lib/env";
import {
  claimIntegrationProbe,
  PROBE_COOLDOWN_MS,
  runIntegrationCheck,
} from "@/lib/integrations/service";
import { recordPageSpeed } from "@/lib/performance/pagespeed";
import { changeStatus, historyAvailable } from "@/lib/recommendations/events";
import {
  syncRecommendations,
  verifiedByCrawl,
} from "@/lib/recommendations/generate";
import {
  canTransition,
  statusChangeFeedback,
  type StatusChangeOutcome,
} from "@/lib/recommendations/transitions";
import { recordScoreSnapshot } from "@/lib/scoring/snapshots";
import {
  ForbiddenError,
  requireOrgContext,
  type OrgContext,
} from "@/lib/tenancy/context";
import type { FormState } from "./actions";

/** Loads the website through the tenant-scoped client, so system helpers below only ever see it. */
async function websiteFor(ctx: OrgContext, websiteId: string) {
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, organizationId: true, url: true, domain: true },
  });
  if (!website) throw new ForbiddenError();
  return website;
}

const refresh = (orgSlug: string) => revalidatePath(`/o/${orgSlug}`, "layout");

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

// ─── Scores, PageSpeed and recommendations ──────────────────────────────────

export async function recalculateScoreAction(
  orgSlug: string,
  websiteId: string,
) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  await recordScoreSnapshot(db(), website);
  await syncRecommendations(db(), website);
  refresh(orgSlug);
}

export async function runPageSpeedAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
): Promise<FormState> {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  // PSI takes 20–60 s per strategy, so it runs after the response is sent.
  after(() =>
    // The UI shows "no new observation"; the logged error names the cause
    // (e.g. QUOTA_EXCEEDED) and never includes the API key.
    runBackground(
      "pagespeed_run",
      { websiteId: website.id, organizationId: website.organizationId },
      async () => {
        await recordPageSpeed(db(), website, {
          apiKey: serverEnv().PAGESPEED_API_KEY,
        });
        await recordScoreSnapshot(db(), website);
        await syncRecommendations(db(), website);
      },
    ),
  );
  return { ok: "PageSpeed test started. Refresh in about a minute." };
}

/** Public integration probe (robots.txt, sitemaps, DNS, Bing, GTM). */
export async function runIntegrationCheckAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
): Promise<FormState> {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  // Claimed atomically before any work starts, so simultaneous requests
  // cannot launch more than one probe for the same website.
  const claim = await claimIntegrationProbe(db(), website, {
    cooldownMs: PROBE_COOLDOWN_MS,
  });
  if (!claim.claimed) {
    return {
      error:
        claim.reason === "running"
          ? "An integration check is already running for this website."
          : "An integration check ran moments ago. Try again in a couple of minutes.",
    };
  }
  // A handful of bounded requests; runs after the response is sent. If the
  // process is stopped first, the RUNNING claim expires (PROBE_STALE_MS).
  after(() =>
    runBackground(
      "integration_check",
      { websiteId: website.id, organizationId: website.organizationId },
      async () => {
        await runIntegrationCheck(
          db(),
          website,
          { deadline: Date.now() + 55_000 },
          claim.checkId,
        );
        await syncRecommendations(db(), website);
      },
    ),
  );
  return { ok: "Integration check started. Refresh in about a minute." };
}

export async function refreshRecommendationsAction(
  orgSlug: string,
  websiteId: string,
) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  await syncRecommendations(db(), await websiteFor(ctx, websiteId));
  refresh(orgSlug);
}

const recommendationStatus = z.enum([
  "PROPOSED",
  "IN_PROGRESS",
  "COMPLETED",
  "DISMISSED",
]);

/**
 * A person changes a task's status on the Recommendations page. Only the
 * changes in STATUS_TRANSITIONS are allowed, checked here on the server: a
 * crafted or stale request is refused without writing. `from` is the status
 * the page showed: if the task has changed since, nothing is written and the
 * person is told. The update also applies only if the status is still the
 * one checked (a sync or another person may change it meanwhile). The
 * tenant-scoped client keeps it to the person's organization; MEMBER or
 * above only. Every outcome is returned for the page to show.
 */
export async function setRecommendationStatusAction(
  orgSlug: string,
  recommendationId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let ctx: Awaited<ReturnType<typeof requireOrgContext>>;
  try {
    ctx = await requireOrgContext(orgSlug, "MEMBER");
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message };
    throw error;
  }
  const parsed = recommendationStatus.safeParse(formData.get("status"));
  if (!parsed.success) return statusChangeFeedback({ kind: "invalid" });
  const status = parsed.data;
  const shown = recommendationStatus.safeParse(formData.get("from"));
  const current = await ctx.db.recommendation.findFirst({
    where: { id: recommendationId },
    select: { status: true, websiteId: true, title: true, issueId: true },
  });
  const refuse = (outcome: StatusChangeOutcome) => {
    log.warn("recommendation_status_refused", {
      organizationId: ctx.organization.id,
      recommendationId,
      reason: outcome.kind,
      from: current?.status ?? null,
      to: status,
    });
    refresh(orgSlug);
    return statusChangeFeedback(outcome);
  };
  if (!current) return refuse({ kind: "missing" });
  if (shown.success && shown.data !== current.status)
    return refuse({ kind: "stale", now: current.status });
  if (!canTransition(current.status, status))
    return refuse({ kind: "unsupported", from: current.status });
  // The change and its history row (with this person as actor) are one
  // transaction, applied only if the status is still the one checked.
  const changed = await changeStatus(ctx.db, {
    id: recommendationId,
    organizationId: ctx.organization.id,
    websiteId: current.websiteId,
    from: current.status,
    to: status,
    actorUserId: ctx.user.id,
    history: await historyAvailable(db()),
  });
  if (!changed) {
    const now = await ctx.db.recommendation.findFirst({
      where: { id: recommendationId },
      select: { status: true },
    });
    return refuse(
      now ? { kind: "stale", now: now.status } : { kind: "missing" },
    );
  }
  refresh(orgSlug);
  const feedback = statusChangeFeedback({
    kind: "changed",
    from: current.status,
    to: status,
  });
  if (
    status !== "COMPLETED" ||
    !verifiedByCrawl(current) ||
    !("ok" in feedback)
  )
    return feedback;
  // Work only a crawl can confirm: AUTOMATIC websites get a verification
  // crawl (at most one a day); the sync decides from its results, never
  // from the queueing. A failure here never undoes the status change.
  const site = await ctx.db.website.findFirst({
    where: { id: current.websiteId },
    select: { crawlMode: true },
  });
  const mode = site?.crawlMode ?? "MANUAL";
  let outcome: QueueOutcome | "failed" | null = null;
  if (mode === "AUTOMATIC") {
    try {
      outcome = await queueAutomaticCrawl(
        db(),
        {
          websiteId: current.websiteId,
          organizationId: ctx.organization.id,
        },
        "VERIFICATION",
      );
    } catch (error) {
      outcome = "failed";
      log.error(
        "verification_crawl_failed",
        {
          organizationId: ctx.organization.id,
          websiteId: current.websiteId,
          recommendationId,
        },
        error,
      );
    }
    if (outcome === "queued")
      after(() =>
        runBackground(
          "verification_crawl_kickoff",
          { websiteId: current.websiteId },
          () =>
            processCrawls(db(), {
              deadline: Date.now() + 50_000,
              afterAnalysis: refreshActionPlan(db()),
            }),
        ),
      );
  }
  return { ok: `${feedback.ok} ${verificationNote(mode, outcome)}` };
}

// ─── AI Search ──────────────────────────────────────────────────────────────

const profileSchema = z.object({
  brandName: z.string().trim().min(1, "Enter the brand name.").max(100),
  legalName: z
    .string()
    .trim()
    .max(150)
    .transform((v) => v || null),
  businessDescription: z
    .string()
    .trim()
    .max(1000)
    .transform((v) => v || null),
});

export async function saveAiProfileAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await requireOrgContext(orgSlug, "MEMBER");
    const website = await websiteFor(ctx, websiteId);
    const parsed = profileSchema.safeParse({
      brandName: formData.get("brandName") ?? "",
      legalName: formData.get("legalName") ?? "",
      businessDescription: formData.get("businessDescription") ?? "",
    });
    if (!parsed.success)
      return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
    // Services and locations are business facts now (business-actions.ts);
    // the legacy lists on the profile are kept as they are, never cleared.
    const data = {
      ...parsed.data,
      aliases: lines(formData.get("aliases")),
    };
    await ctx.db.aiSearchProfile.upsert({
      where: { websiteId: website.id },
      create: {
        organizationId: ctx.organization.id,
        websiteId: website.id,
        ...data,
      },
      update: data,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message };
    throw error;
  }
  refresh(orgSlug);
  return { ok: "Profile saved." };
}

const aiProvider = z.enum(["MOCK", "GEMINI", "PERPLEXITY"]);

const intents = z.enum([
  "DISCOVERY",
  "COMPARISON",
  "RECOMMENDATION",
  "LOCAL",
  "INFORMATIONAL",
  "TRANSACTIONAL",
]);

export async function addAiQueryAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  const text = String(formData.get("text") ?? "").trim();
  const intent = intents.safeParse(formData.get("intent"));
  if (text.length < 3 || text.length > 300) {
    return { fieldErrors: { text: ["Enter a query of 3–300 characters."] } };
  }
  if (!intent.success)
    return { fieldErrors: { intent: ["Choose an intent."] } };
  try {
    await ctx.db.aiSearchQuery.create({
      data: {
        organizationId: ctx.organization.id,
        websiteId: website.id,
        text,
        normalizedText: normalizeQueryText(text),
        intent: intent.data,
        priority: Math.max(
          0,
          Math.min(10, Number(formData.get("priority") ?? 0) || 0),
        ),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { fieldErrors: { text: ["That query already exists."] } };
    }
    throw error;
  }
  refresh(orgSlug);
  return { ok: "Query added." };
}

export async function toggleAiQueryAction(
  orgSlug: string,
  queryId: string,
  formData: FormData,
) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  await ctx.db.aiSearchQuery.updateMany({
    where: { id: queryId },
    data: { enabled: formData.get("enabled") === "true" },
  });
  refresh(orgSlug);
}

export async function deleteAiQueryAction(orgSlug: string, queryId: string) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  await ctx.db.aiSearchQuery.deleteMany({ where: { id: queryId } });
  refresh(orgSlug);
}

export async function addCompetitorAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 100)
    return { fieldErrors: { name: ["Enter a name."] } };
  const rawDomain = String(formData.get("domain") ?? "")
    .trim()
    .toLowerCase();
  const domain =
    rawDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return { fieldErrors: { domain: ["Enter a domain such as example.com."] } };
  }
  await ctx.db.aiSearchCompetitor.create({
    data: {
      organizationId: ctx.organization.id,
      websiteId: website.id,
      name,
      domain,
      aliases: lines(formData.get("aliases")),
    },
  });
  refresh(orgSlug);
  return { ok: "Competitor added." };
}

export async function deleteCompetitorAction(
  orgSlug: string,
  competitorId: string,
) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  await ctx.db.aiSearchCompetitor.deleteMany({ where: { id: competitorId } });
  refresh(orgSlug);
}

export async function startAiRunAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  const requested = aiProvider.safeParse(formData.get("provider"));
  if (!requested.success) return { error: "Choose a provider." };
  const provider = requested.data;
  // Checked before a run is queued, so no request reaches an unconfigured provider.
  if (!configuredProviders().includes(provider)) {
    return { error: providerUnavailableMessage(provider) };
  }
  try {
    const run = await startAiSearchRun(
      ctx.db,
      ctx.organization.id,
      website.id,
      provider,
      providerModel(provider),
    );
    after(() =>
      runBackground("ai_search_run", { runId: run.id, provider }, () =>
        executeAiSearchRun(db(), run.id, (brand) =>
          makeProvider(provider, brand),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof AiSearchError) return { error: error.message };
    throw error;
  }
  refresh(orgSlug);
  return { ok: "Run started. Results appear as each query completes." };
}
