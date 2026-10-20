import { db } from "@/lib/db";

/** Liveness + database reachability for uptime monitors. Reveals no details. */
export async function GET() {
  try {
    await db().$queryRaw`SELECT 1`;
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
