import { db } from "@/lib/db";
import { buildExport, DATASETS, type Dataset } from "@/lib/reports/exports";
import { canExport } from "@/lib/tenancy/client-limits";
import { findOrgContext } from "@/lib/tenancy/context";

/** GET /o/:orgSlug/export/:dataset?days=30&websiteId=… → CSV download. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/export/[dataset]">,
) {
  const { orgSlug, dataset } = await params;
  const ctx = await findOrgContext(orgSlug);
  // Same response for "not signed in", "not a member" and CLIENT members
  // (exports are organization-wide; client-limits.ts): reveals nothing,
  // whatever the dataset or website asked for.
  if (
    !ctx ||
    !canExport(ctx.role) ||
    !(DATASETS as readonly string[]).includes(dataset)
  ) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const days = Math.min(
    365,
    Math.max(1, Number(url.searchParams.get("days")) || 30),
  );
  const websiteId = url.searchParams.get("websiteId") || undefined;
  const csv = await buildExport(ctx.db, dataset as Dataset, {
    days,
    websiteId,
    role: ctx.role,
    root: db(),
  });

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${ctx.organization.slug}-${dataset}-${date}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
