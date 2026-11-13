import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { createSessionRecord } from "@/lib/auth/session-store";
import { tenantDb } from "@/lib/tenancy/scope";
import { createWebsite } from "@/lib/websites/service";
import { TEST_DATABASE_URL, testDb, uid } from "./helpers";

/**
 * CLIENT lockdown on a real database: every organization page and layout,
 * every server action and the export route run for real (session lookup,
 * membership, role, tenant scope); only Next's request APIs are replaced.
 * CLIENT members get the non-member 404 everywhere and nothing changes in
 * the database; team roles keep working; another organization's members
 * and ids get 404; an existing session follows a role change at once.
 */
const state = vi.hoisted(() => ({
  token: null as string | null,
  client: null as unknown,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (state.token ? { name: "s", value: state.token } : undefined),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/db", () => ({ db: () => state.client }));

const APP = join(process.cwd(), "src/app/(app)");
function files(dir: string, name: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p, name);
    return name.test(f) ? [p] : [];
  });
}
const ORG = join(APP, "o/[orgSlug]");
const PAGES = files(ORG, /^page\.tsx$/);
const ACTION_MODULES = files(ORG, /actions\.ts$/).filter(
  (f) => !f.includes(".test."),
);
const notFound = { digest: expect.stringContaining("404") };

describe.skipIf(!TEST_DATABASE_URL)("CLIENT lockdown (local database)", () => {
  let db: PrismaClient;
  const run = uid();
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const tokens: Partial<Record<Role | "OTHER", string>> = {};
  let A: { slug: string; id: string; site: string; run: string };
  let B: { slug: string; id: string; site: string };

  async function organization(label: string) {
    const slug = `lock-${label}-${run}`;
    const org = await db.organization.create({ data: { name: label, slug } });
    orgIds.push(org.id);
    const tdb = tenantDb(db, org.id);
    const clientA = await db.client.create({
      data: {
        organizationId: org.id,
        name: `Client ${label} 1`,
        slug: "c1",
        email: "one@example.test",
      },
    });
    await db.client.create({
      data: {
        organizationId: org.id,
        name: `Client ${label} 2`,
        slug: "c2",
        email: "two@example.test",
      },
    });
    const site = await createWebsite(tdb, org.id, {
      name: `${label} site`,
      url: `https://${label}-${run}.example`,
      clientId: clientA.id,
    });
    return { slug, id: org.id, site: site.id, tdb };
  }
  async function member(orgId: string, role: Role) {
    const user = await db.user.create({
      data: { email: `lock-${role.toLowerCase()}-${uid()}@example.test` },
    });
    userIds.push(user.id);
    const m = await db.organizationMember.create({
      data: { organizationId: orgId, userId: user.id, role },
    });
    const { token } = await createSessionRecord(db, user.id);
    return { token, memberId: m.id, userId: user.id };
  }
  const as = (who: keyof typeof tokens) => {
    state.token = tokens[who]!;
  };
  async function renderPage(file: string, params: Record<string, string>) {
    const mod = await import(/* @vite-ignore */ file);
    return mod.default({
      params: Promise.resolve(params),
      searchParams: Promise.resolve({}),
    });
  }
  const paramsFor = (file: string, org: { slug: string; site: string }) => {
    const p: Record<string, string> = { orgSlug: org.slug };
    if (file.includes("[websiteId]")) p.websiteId = org.site;
    if (file.includes("[runId]")) p.runId = A.run;
    return p;
  };
  /** Rows a CLIENT must never change. */
  const snapshot = () =>
    Promise.all([
      db.website.count({ where: { organizationId: A.id } }),
      db.client.count({ where: { organizationId: A.id } }),
      db.issue.findMany({
        where: { organizationId: A.id },
        select: { id: true, status: true, assignedToId: true },
      }),
      db.crawlRun.count({ where: { organizationId: A.id } }),
      db.monitoringJob.count({ where: { organizationId: A.id } }),
      db.businessFact.count({ where: { organizationId: A.id } }),
      db.recommendation.count({ where: { organizationId: A.id } }),
      db.notificationPreference.count({ where: { organizationId: A.id } }),
    ]);

  beforeAll(async () => {
    db = testDb();
    state.client = db;
    const a = await organization("a");
    const b = await organization("b");
    const crawl = await db.crawlRun.create({
      data: {
        organizationId: a.id,
        websiteId: a.site,
        status: "COMPLETED",
        maxPages: 10,
        maxDepth: 2,
        maxDiscoveredUrls: 100,
        userAgent: "test",
      },
    });
    await db.issue.create({
      data: {
        organizationId: a.id,
        websiteId: a.site,
        category: "UPTIME",
        severity: "HIGH",
        title: "Down",
        description: "Website is down",
      },
    });
    A = { slug: a.slug, id: a.id, site: a.site, run: crawl.id };
    B = { slug: b.slug, id: b.id, site: b.site };
    for (const role of [
      "OWNER",
      "ADMIN",
      "MANAGER",
      "MEMBER",
      "CLIENT",
    ] as Role[])
      tokens[role] = (await member(A.id, role)).token;
    tokens.OTHER = (await member(B.id, "MEMBER")).token;
  });
  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  test("the page inventory is complete (every organization page is checked below)", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(24);
    expect(ACTION_MODULES.length).toBe(4);
  });

  test("CLIENT: every organization page, website page and the layout answer 404", async () => {
    as("CLIENT");
    for (const file of PAGES)
      await expect(
        renderPage(file, paramsFor(file, A)),
        relative(APP, file),
      ).rejects.toMatchObject(notFound);
    const layout = await import(/* @vite-ignore */ join(ORG, "layout.tsx"));
    await expect(
      layout.default({
        children: null,
        params: Promise.resolve({ orgSlug: A.slug }),
      }),
    ).rejects.toMatchObject(notFound);
  });

  test("CLIENT: the report handoff (client view, PDF, plan) answers 404 too", async () => {
    as("CLIENT");
    const report = join(ORG, "websites/[websiteId]/report/page.tsx");
    const mod = await import(/* @vite-ignore */ report);
    for (const searchParams of [
      { view: "client" },
      { view: "client", pdf: "1", content: "include" },
      { period: "28d", through: "2026-11-12" },
    ])
      await expect(
        mod.default({
          params: Promise.resolve({ orgSlug: A.slug, websiteId: A.site }),
          searchParams: Promise.resolve(searchParams),
        }),
      ).rejects.toMatchObject(notFound);
  });

  test("CLIENT: every server action answers 404 and changes nothing", async () => {
    as("CLIENT");
    const before = await snapshot();
    const fd = new FormData();
    fd.set("name", "x");
    fd.set("url", "https://evil.example");
    fd.set("status", "RESOLVED");
    let called = 0;
    for (const file of ACTION_MODULES) {
      const mod = await import(/* @vite-ignore */ file);
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function") continue;
        called++;
        // orgSlug first; any id; the form-state signatures take (prev, form).
        await expect(
          (fn as (...a: unknown[]) => Promise<unknown>)(
            A.slug,
            A.site,
            undefined,
            fd,
          ),
          `${relative(APP, file)}#${name}`,
        ).rejects.toMatchObject(notFound);
      }
    }
    expect(called).toBeGreaterThanOrEqual(30);
    expect(await snapshot()).toEqual(before);
  });

  test("CLIENT: CSV exports answer 404 for every dataset, with and without a website id", async () => {
    as("CLIENT");
    const { GET } = await import(
      /* @vite-ignore */ join(ORG, "export/[dataset]/route.ts")
    );
    const { DATASETS } = await import("@/lib/reports/exports");
    for (const dataset of DATASETS)
      for (const q of ["", `?websiteId=${A.site}`, `?websiteId=${B.site}`]) {
        const res: Response = await GET(
          new Request(`https://app.test/o/${A.slug}/export/${dataset}${q}`),
          { params: Promise.resolve({ orgSlug: A.slug, dataset }) },
        );
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("Not found");
      }
  });

  test("team roles: every page loads its data and exports still work", async () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "MEMBER"] as Role[]) {
      as(role);
      for (const file of PAGES) {
        // Website settings and new website need MEMBER (all team roles here).
        const page = await renderPage(file, paramsFor(file, A));
        expect(page, `${role} ${relative(APP, file)}`).toBeTruthy();
      }
      const { GET } = await import(
        /* @vite-ignore */ join(ORG, "export/[dataset]/route.ts")
      );
      const res: Response = await GET(
        new Request(`https://app.test/o/${A.slug}/export/issues`),
        { params: Promise.resolve({ orgSlug: A.slug, dataset: "issues" }) },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Down");
    }
  });

  test("cross-organization: another organization's member, or this organization's member with a foreign website id, gets 404", async () => {
    as("OTHER");
    for (const file of PAGES.filter((f) => !f.includes("[runId]")))
      await expect(
        renderPage(file, paramsFor(file, A)),
        relative(APP, file),
      ).rejects.toMatchObject(notFound);
    as("MEMBER");
    for (const file of PAGES.filter(
      (f) => f.includes("[websiteId]") && !f.includes("[runId]"),
    ))
      await expect(
        renderPage(file, { orgSlug: A.slug, websiteId: B.site }),
        relative(APP, file),
      ).rejects.toMatchObject(notFound);
  });

  test("an existing session follows a role change on the next request, without signing out", async () => {
    const m = await member(A.id, "MEMBER");
    state.token = m.token;
    const overview = join(ORG, "page.tsx");
    await expect(
      renderPage(overview, { orgSlug: A.slug }),
    ).resolves.toBeTruthy();
    await db.organizationMember.update({
      where: { id: m.memberId },
      data: { role: "CLIENT" },
    });
    await expect(
      renderPage(overview, { orgSlug: A.slug }),
    ).rejects.toMatchObject(notFound);
  });

  test("dashboard: a client-only account is not sent into the organization; a mixed account goes to its team organization", async () => {
    const dashboard = await import(
      /* @vite-ignore */ join(APP, "dashboard/page.tsx")
    );
    as("CLIENT");
    const page = await dashboard.default();
    expect(JSON.stringify(page)).toContain("client-only");
    expect(JSON.stringify(page)).not.toContain(`/o/${A.slug}`);

    // CLIENT in A and MEMBER in B: redirected to B only.
    const mixed = await member(A.id, "CLIENT");
    await db.organizationMember.create({
      data: { organizationId: B.id, userId: mixed.userId, role: "MEMBER" },
    });
    state.token = mixed.token;
    await expect(dashboard.default()).rejects.toMatchObject({
      digest: expect.stringContaining(`/o/${B.slug}`),
    });
  });
});
