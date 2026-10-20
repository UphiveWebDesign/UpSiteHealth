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
  processCrawls,
  requestCrawlCancel,
  startCrawl,
} from "@/lib/crawler/engine";
import { db } from "@/lib/db";
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
      processMonitoringJobs(db(), {
        workerId: `create-${randomUUID().slice(0, 8)}`,
        deadline: Date.now() + 30_000,
        websiteId,
      }).catch(() => undefined),
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
  // Start crawling right after the response; the cron worker continues it.
  after(() =>
    processCrawls(db(), { deadline: Date.now() + 50_000 }).catch(
      () => undefined,
    ),
  );
  revalidatePath(`/o/${orgSlug}`, "layout");
  return { ok: "Crawl started." };
}

export async function cancelCrawlAction(orgSlug: string, runId: string) {
  const ctx = await ctxFor(orgSlug, "MEMBER");
  await requestCrawlCancel(ctx.db, runId);
  after(() =>
    processCrawls(db(), { deadline: Date.now() + 20_000 }).catch(
      () => undefined,
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

export async function setFindingStatusAction(
  orgSlug: string,
  findingId: string,
  formData: FormData,
) {
  const ctx = await ctxFor(orgSlug, "MEMBER");
  const status = findingStatus.parse(formData.get("status"));
  await ctx.db.seoFinding.updateMany({
    where: { id: findingId },
    data: { status, resolvedAt: null },
  });
  revalidatePath(`/o/${orgSlug}`, "layout");
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
