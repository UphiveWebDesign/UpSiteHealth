"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { slugify } from "@/lib/auth/accounts";
import {
  CrawlError,
  requestCrawlCancel,
  startCrawl,
} from "@/lib/crawler/engine";
import { processCrawls } from "@/lib/crawler/scheduler";
import { refreshActionPlan } from "@/lib/recommendations/after-crawl";
import { db } from "@/lib/db";
import { log, runBackground } from "@/lib/log";
import {
  FINDING_ACTION,
  findingStatusFeedback,
  type FindingChangeOutcome,
} from "@/lib/seo/finding-status";
import { processMonitoringJobs } from "@/lib/monitoring/worker";
import {
  ForbiddenError,
  requireOrgContext,
  type OrgContext,
} from "@/lib/tenancy/context";
import {
  createWebsite,
  deleteWebsite,
  requestImmediateChecks,
  updateWebsite,
  WebsiteError,
  type WebsiteInput,
} from "@/lib/websites/service";

export type FormState =
  | {
      error?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      ok?: string;
    }
  | undefined;

/** Membership + role check for every action; the UI hiding a button is not access control. */
async function ctxFor(orgSlug: string, role: Role): Promise<OrgContext> {
  return requireOrgContext(orgSlug, role);
}

function formError(error: unknown): FormState {
  if (error instanceof ForbiddenError) return { error: error.message };
  if (error instanceof WebsiteError) {
    return error.field
      ? { fieldErrors: { [error.field]: [error.message] } }
      : { error: error.message };
  }
  if (error instanceof CrawlError) return { error: error.message };
  throw error;
}

const websiteForm = (formData: FormData) => ({
  name: String(formData.get("name") ?? ""),
  url: String(formData.get("url") ?? ""),
  clientId: String(formData.get("clientId") ?? ""),
  monitoringEnabled: formData.get("monitoringEnabled") === "on",
  // Validated by websiteInputSchema; absent leaves the mode unchanged.
  crawlMode: (formData.get("crawlMode") ?? undefined) as
    WebsiteInput["crawlMode"] | undefined,
});

// ─── Websites ───────────────────────────────────────────────────────────────

export async function createWebsiteAction(
  orgSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let websiteId: string;
  try {
    const ctx = await ctxFor(orgSlug, "MEMBER");
    const site = await createWebsite(ctx.db, ctx.organization.id, {
      ...websiteForm(formData),
      monitoringEnabled: true,
    });
    websiteId = site.id;
    after(() =>
      runBackground(
        "initial_website_checks",
        { websiteId, organizationId: ctx.organization.id },
        () =>
          processMonitoringJobs(db(), {
            workerId: `create-${randomUUID().slice(0, 8)}`,
            deadline: Date.now() + 30_000,
            websiteId,
          }),
      ),
    );
    await requestImmediateChecks(ctx.db, ctx.organization.id, websiteId);
  } catch (error) {
    return formError(error);
  }
  revalidatePath(`/o/${orgSlug}`, "layout");
  redirect(`/o/${orgSlug}/websites/${websiteId}`);
}

export async function updateWebsiteAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await ctxFor(orgSlug, "MEMBER");
    await updateWebsite(ctx.db, websiteId, websiteForm(formData));
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return { error: "Website not found." };
    }
    return formError(error);
  }
  revalidatePath(`/o/${orgSlug}`, "layout");
  return { ok: "Saved." };
}

export async function deleteWebsiteAction(orgSlug: string, websiteId: string) {
  const ctx = await ctxFor(orgSlug, "MANAGER");
  await deleteWebsite(ctx.db, websiteId);
  revalidatePath(`/o/${orgSlug}`, "layout");
  redirect(`/o/${orgSlug}/websites`);
}

export async function checkNowAction(orgSlug: string, websiteId: string) {
  const ctx = await ctxFor(orgSlug, "MEMBER");
  const queued = await requestImmediateChecks(
    ctx.db,
    ctx.organization.id,
    websiteId,
  );
  if (queued > 0) {
    // Run this website's jobs now so the user sees fresh results on reload.
    await processMonitoringJobs(db(), {
      workerId: `manual-${randomUUID().slice(0, 8)}`,
      deadline: Date.now() + 25_000,
      websiteId,
    });
  }
  revalidatePath(`/o/${orgSlug}`, "layout");
}

// ─── Crawls ─────────────────────────────────────────────────────────────────

export async function startCrawlAction(
  orgSlug: string,
  websiteId: string,
  _prev: FormState,
): Promise<FormState> {
  try {
    const ctx = await ctxFor(orgSlug, "MEMBER");
    await startCrawl(ctx.db, ctx.organization.id, websiteId);
  } catch (error) {
    return formError(error);
  }
  // Start crawling right after the response, and refresh the action plan
  // once the crawl is analysed; cron or the crawl worker continues it.
  after(() =>
    runBackground("crawl_kickoff", { websiteId }, () =>
      processCrawls(db(), {
        deadline: Date.now() + 50_000,
        afterAnalysis: refreshActionPlan(db()),
      }),
    ),
  );
  revalidatePath(`/o/${orgSlug}`, "layout");
  return { ok: "Crawl started." };
}

export async function cancelCrawlAction(orgSlug: string, runId: string) {
  const ctx = await ctxFor(orgSlug, "MEMBER");
  await requestCrawlCancel(ctx.db, runId);
  after(() =>
    runBackground("crawl_cancel", { runId }, () =>
      processCrawls(db(), {
        deadline: Date.now() + 20_000,
        afterAnalysis: refreshActionPlan(db()),
      }),
    ),
  );
  revalidatePath(`/o/${orgSlug}`, "layout");
}

// ─── Issues and SEO findings ────────────────────────────────────────────────

const issueStatus = z.enum([
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "IGNORED",
]);

export async function setIssueStatusAction(
  orgSlug: string,
  issueId: string,
  formData: FormData,
) {
  const ctx = await ctxFor(orgSlug, "MEMBER");
  const status = issueStatus.parse(formData.get("status"));
  await ctx.db.issue.updateMany({
    where: { id: issueId },
    data: {
      status,
      resolvedAt: status === "RESOLVED" ? new Date() : null,
    },
  });
  revalidatePath(`/o/${orgSlug}`, "layout");
}

export async function assignIssueAction(
  orgSlug: string,
  issueId: string,
  formData: FormData,
) {
  const ctx = await ctxFor(orgSlug, "MEMBER");
  const userId = String(formData.get("assignedToId") ?? "") || null;
  if (userId) {
    // Only members of this organization can be assigned.
    const member = await ctx.db.organizationMember.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!member) throw new ForbiddenError();
  }
  await ctx.db.issue.updateMany({
    where: { id: issueId },
    data: { assignedToId: userId },
  });
  revalidatePath(`/o/${orgSlug}`, "layout");
}

const findingStatus = z.enum(["OPEN", "IGNORED"]);

/**
 * A person ignores an open finding or reopens an ignored one; nothing else.
 * Whether a finding is OPEN or RESOLVED is the crawl's evidence: a resolved
 * finding (a later crawl showed it fixed) is never turned back into a current
 * issue by hand. `from` is the status the page showed; one conditional
 * update, so a finding that changed meanwhile (or belongs to another
 * organization) is left alone. Every outcome is returned for the page.
 */
export async function setFindingStatusAction(
  orgSlug: string,
  findingId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let ctx: OrgContext;
  try {
    ctx = await ctxFor(orgSlug, "MEMBER");
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message };
    throw error;
  }
  const parsed = findingStatus.safeParse(formData.get("status"));
  if (!parsed.success) return findingStatusFeedback({ kind: "invalid" });
  const status = parsed.data;
  const shown = z
    .enum(["OPEN", "IGNORED", "RESOLVED"])
    .safeParse(formData.get("from"));
  const current = await ctx.db.seoFinding.findFirst({
    where: { id: findingId },
    select: { status: true },
  });
  const refuse = (outcome: FindingChangeOutcome) => {
    log.warn("seo_finding_status_refused", {
      organizationId: ctx.organization.id,
      findingId,
      reason: outcome.kind,
      to: status,
    });
    revalidatePath(`/o/${orgSlug}`, "layout");
    return findingStatusFeedback(outcome);
  };
  if (!current) return refuse({ kind: "missing" });
  if (shown.success && shown.data !== current.status)
    return refuse({ kind: "stale", now: current.status });
  if (FINDING_ACTION[current.status]?.to !== status)
    return refuse({ kind: "unsupported", from: current.status });
  const { count } = await ctx.db.seoFinding.updateMany({
    where: { id: findingId, status: current.status },
    data: { status, resolvedAt: null },
  });
  if (count === 0) {
    const now = await ctx.db.seoFinding.findFirst({
      where: { id: findingId },
      select: { status: true },
    });
    return refuse(
      now ? { kind: "stale", now: now.status } : { kind: "missing" },
    );
  }
  revalidatePath(`/o/${orgSlug}`, "layout");
  return findingStatusFeedback({ kind: "changed", from: current.status });
}

// ─── Clients ────────────────────────────────────────────────────────────────

const clientSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(100),
  email: z
    .union([z.literal(""), z.email("Enter a valid email.")])
    .transform((v) => v || null),
  company: z
    .string()
    .trim()
    .max(100)
    .transform((v) => v || null),
});

export async function createClientAction(
  orgSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ctx = await ctxFor(orgSlug, "MANAGER");
    const parsed = clientSchema.safeParse({
      name: formData.get("name") ?? "",
      email: String(formData.get("email") ?? "").trim(),
      company: formData.get("company") ?? "",
    });
    if (!parsed.success)
      return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
    const base = slugify(parsed.data.name);
    for (let i = 0; i < 5; i++) {
      const slug =
        i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        await ctx.db.client.create({
          data: { organizationId: ctx.organization.id, slug, ...parsed.data },
        });
        break;
      } catch (error) {
        if (!(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )) {
          throw error;
        }
      }
    }
  } catch (error) {
    return formError(error);
  }
  revalidatePath(`/o/${orgSlug}`, "layout");
  return { ok: "Client added." };
}
