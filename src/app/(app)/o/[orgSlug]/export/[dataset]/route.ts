import { buildExport, DATASETS, type Dataset } from "@/lib/reports/exports";
import { findOrgContext } from "@/lib/tenancy/context";

/** GET /o/:orgSlug/export/:dataset?days=30&websiteId=… → CSV download. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/export/[dataset]">,
) {
  const { orgSlug, dataset } = await params;
  const ctx = await findOrgContext(orgSlug);
  // Same response for "not signed in" and "not a member": reveals nothing.
  if (!ctx || !(DATASETS as readonly string[]).includes(dataset)) {
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
