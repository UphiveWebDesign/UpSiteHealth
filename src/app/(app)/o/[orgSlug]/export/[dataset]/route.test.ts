import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Role } from "@/generated/prisma/enums";

/**
 * The export route on the server: CLIENT members get the same 404 as a
 * non-member for every dataset, with or without a website id, and no
 * export is built for them; team roles get their CSV as before.
 */

const state = vi.hoisted(() => ({
  ctx: null as null | { role: Role },
  buildExport: vi.fn(async () => "a,b\n1,2"),
}));

vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/lib/tenancy/context", () => ({
  findOrgContext: async () =>
    state.ctx
      ? {
          ...state.ctx,
          db: {},
          organization: { id: "org-1", slug: "agency", name: "Agency" },
          memberId: "m1",
        }
      : null,
}));
vi.mock("@/lib/reports/exports", async (original) => ({
  ...(await original<typeof import("@/lib/reports/exports")>()),
  buildExport: state.buildExport,
}));

const { GET } = await import("./route");
const { DATASETS } = await import("@/lib/reports/exports");

const call = (dataset: string, query = "") =>
  GET(new Request(`https://app.test/o/agency/export/${dataset}${query}`), {
    params: Promise.resolve({ orgSlug: "agency", dataset }),
  } as never);

beforeEach(() => {
  state.buildExport.mockClear();
});

describe("CSV exports", () => {
  test("CLIENT members: 404 for every dataset, with or without a website, and nothing is built", async () => {
    state.ctx = { role: "CLIENT" };
    for (const dataset of DATASETS)
      for (const query of [
        "",
        "?websiteId=w-other",
        "?days=365&websiteId=w1",
      ]) {
        const res = await call(dataset, query);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("Not found");
      }
    expect(state.buildExport).not.toHaveBeenCalled();
  });

  test("the CLIENT answer is the same as for a non-member or an unknown dataset", async () => {
    state.ctx = null;
    const anonymous = await call("issues");
    state.ctx = { role: "OWNER" };
    const unknown = await call("nope");
    state.ctx = { role: "CLIENT" };
    const client = await call("issues");
    const shape = async (res: Response) => ({
      status: res.status,
      type: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      body: await res.text(),
    });
    const expected = await shape(anonymous);
    expect(expected).toMatchObject({ status: 404, disposition: null });
    expect(await shape(unknown)).toEqual(expected);
    expect(await shape(client)).toEqual(expected);
  });

  test("team roles still export", async () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "MEMBER"] as Role[]) {
      state.ctx = { role };
      const res = await call("issues", "?websiteId=w1&days=7");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      expect(await res.text()).toBe("a,b\n1,2");
    }
    expect(state.buildExport).toHaveBeenCalledTimes(4);
    expect(state.buildExport).toHaveBeenLastCalledWith(
      expect.anything(),
      "issues",
      expect.objectContaining({ websiteId: "w1", days: 7, role: "MEMBER" }),
    );
  });
});
