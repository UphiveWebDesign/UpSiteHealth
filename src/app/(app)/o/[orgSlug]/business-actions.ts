"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { BusinessFactKind } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { planDecision } from "@/lib/business/decisions";
import { factInput, normalizeFactValue } from "@/lib/business/facts";
import { opportunityDraft } from "@/lib/business/coverage";
import { db } from "@/lib/db";
import {
  createRecommendationOnce,
  loadRecommendationContext,
  syncRecommendations,
} from "@/lib/recommendations/generate";
import {
  ForbiddenError,
  requireOrgContext,
  type OrgContext,
} from "@/lib/tenancy/context";
import type { FormState } from "./actions";

/**
 * Business facts. Every change needs MEMBER or above (CLIENT members cannot
 * see or edit business data, see lib/business/visibility.ts). Approval is
 * always an explicit decision recorded with who made it and when; nothing
 * here approves a fact on its own, and imported facts start pending.
 */

async function websiteFor(ctx: OrgContext, websiteId: string) {
  const website = await ctx.db.website.findFirst({
    where: { id: websiteId },
    select: { id: true, organizationId: true },
  });
  if (!website) throw new ForbiddenError();
  return website;
}

const refresh = (orgSlug: string) => revalidatePath(`/o/${orgSlug}`, "layout");

function list(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function addFactAction(
  orgSlug: string,
  websiteId: string,
  kind: BusinessFactKind,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  let approve = false;
  try {
    const ctx = await requireOrgContext(orgSlug, "MEMBER");
    const website = await websiteFor(ctx, websiteId);
    const parsed = factInput.safeParse({
      kind,
      value: formData.get("value") ?? "",
      synonyms: list(formData.get("synonyms")),
      source: formData.get("source") ?? "",
      approve: formData.get("approve") === "on",
    });
    if (!parsed.success)
      return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
    const f = parsed.data;
    approve = f.approve;
    const now = new Date();
    await ctx.db.businessFact.create({
      data: {
        organizationId: website.organizationId,
        websiteId: website.id,
        kind: f.kind,
        value: f.value,
        normalizedValue: normalizeFactValue(f.value),
        synonyms: [...new Set(f.synonyms)],
        source: f.source,
        status: f.approve ? "APPROVED" : "PENDING",
        createdById: ctx.user.id,
        ...(f.approve ? { reviewedById: ctx.user.id, reviewedAt: now } : {}),
      },
    });
    if (f.approve) await syncRecommendations(db(), website);
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: error.message };
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      return { error: "That is already in the list." };
    throw error;
  }
  refresh(orgSlug);
  return { ok: approve ? "Added and approved." : "Added for review." };
}

const decision = z.enum(["APPROVED", "REJECTED", "PENDING"]);

/** Approve, reject or send back for review; records the reviewer. */
export async function reviewFactAction(
  orgSlug: string,
  factId: string,
  formData: FormData,
) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const status = decision.parse(formData.get("status"));
  const fact = await ctx.db.businessFact.findFirst({
    where: { id: factId },
    select: { id: true, websiteId: true, organizationId: true },
  });
  if (!fact) throw new ForbiddenError();
  await ctx.db.businessFact.updateMany({
    where: { id: fact.id },
    data:
      status === "PENDING"
        ? { status, reviewedById: null, reviewedAt: null }
        : { status, reviewedById: ctx.user.id, reviewedAt: new Date() },
  });
  await syncRecommendations(db(), {
    id: fact.websiteId,
    organizationId: fact.organizationId,
  });
  refresh(orgSlug);
}

export async function deleteFactAction(orgSlug: string, factId: string) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const fact = await ctx.db.businessFact.findFirst({
    where: { id: factId },
    select: { id: true, websiteId: true, organizationId: true },
  });
  if (!fact) throw new ForbiddenError();
  await ctx.db.businessFact.deleteMany({ where: { id: fact.id } });
  await syncRecommendations(db(), {
    id: fact.websiteId,
    organizationId: fact.organizationId,
  });
  refresh(orgSlug);
}

/**
 * Copies the free-text services and locations saved on the AI Search
 * profile into facts, as IMPORT and pending review. Existing facts with the
 * same wording are left alone.
 */
export async function importProfileFactsAction(
  orgSlug: string,
  websiteId: string,
) {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  const profile = await ctx.db.aiSearchProfile.findFirst({
    where: { websiteId: website.id },
    select: { primaryServices: true, locations: true },
  });
  if (!profile) return;
  const rows = [
    ...profile.primaryServices.map((v) => ["SERVICE", v] as const),
    ...profile.locations.map((v) => ["LOCATION", v] as const),
  ]
    .map(([kind, v]) => [kind, v.trim()] as const)
    .filter(([, v]) => v.length > 0 && v.length <= 160)
    .map(([kind, value]) => ({
      organizationId: website.organizationId,
      websiteId: website.id,
      kind,
      value,
      normalizedValue: normalizeFactValue(value),
      source: "IMPORT" as const,
      status: "PENDING" as const,
      createdById: ctx.user.id,
    }));
  if (rows.length)
    await ctx.db.businessFact.createMany({ data: rows, skipDuplicates: true });
  refresh(orgSlug);
}

const opportunityDecision = z.enum(["accept", "dismiss", "restore"]);

const COMPLETED_MEANWHILE =
  "This task was completed in the meantime. Completed work stays completed.";

/**
 * Changes an opportunity task's status unless it is completed by now (the
 * task may have been completed since it was read). False when unchanged.
 */
async function setStatus(
  ctx: OrgContext,
  id: string,
  status: "PROPOSED" | "DISMISSED",
): Promise<boolean> {
  const { count } = await ctx.db.recommendation.updateMany({
    where: { id, status: { not: "COMPLETED" } },
    data: { status },
  });
  return count > 0;
}

/**
 * Accept, dismiss or restore a page opportunity, using the existing
 * recommendation rows and statuses (business/decisions.ts). The opportunity
 * is recomputed on the server from current evidence; a submitted title is
 * never trusted on its own. Authorization failures throw as elsewhere;
 * every outcome, including a refusal, is returned for the person to see.
 */
export async function decideOpportunityAction(
  orgSlug: string,
  websiteId: string,
  key: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const ctx = await requireOrgContext(orgSlug, "MEMBER");
  const website = await websiteFor(ctx, websiteId);
  const decision = opportunityDecision.parse(formData.get("decision"));
  const scope = {
    websiteId: website.id,
    organizationId: website.organizationId,
  };
  const rctx = await loadRecommendationContext(db(), scope);
  const o = rctx.coverage?.opportunities.find((x) => x.key === key);
  if (!o)
    return {
      error:
        "This opportunity is no longer suggested. Refresh the page to see the current ones.",
    };
  const existing = await ctx.db.recommendation.findFirst({
    where: { websiteId: website.id, title: o.key },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  let plan = planDecision(decision, existing, o.state);
  if (plan.kind === "refuse") return { error: plan.error };
  if (plan.kind === "create") {
    // Created at most once per title, even if a sync runs at the same time
    // (root client with the scope verified above).
    const row = await createRecommendationOnce(db(), scope, {
      ...opportunityDraft(o),
      status: plan.status,
    });
    // Someone (or a sync) created it meanwhile: decide again on that task.
    if (!row.created) {
      plan = planDecision(decision, row, o.state);
      if (plan.kind === "refuse") return { error: plan.error };
      if (
        plan.kind === "update" &&
        !(await setStatus(ctx, row.id, plan.status))
      )
        return { error: COMPLETED_MEANWHILE };
    }
  } else if (plan.kind === "update") {
    if (!(await setStatus(ctx, existing!.id, plan.status)))
      return { error: COMPLETED_MEANWHILE };
  }
  await syncRecommendations(db(), website);
  refresh(orgSlug);
  return { ok: plan.ok };
}
