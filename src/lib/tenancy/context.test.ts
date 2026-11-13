import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Role } from "@/generated/prisma/enums";

/**
 * The central organization access rule: CLIENT members are refused exactly
 * like non-members, for every minimum role; team roles are unchanged.
 */

const state = vi.hoisted(() => ({
  role: null as Role | null,
  user: { id: "u1", email: "u@example.test", name: null } as {
    id: string;
    email: string;
    name: string | null;
  } | null,
}));

vi.mock("@/lib/db", () => ({ db: () => ({ $extends: () => ({}) }) }));
vi.mock("@/lib/auth/dal", () => ({
  requireUser: async () => state.user,
  getCurrentUser: async () => state.user,
}));
vi.mock("./memberships", () => ({
  findMembershipBySlug: async () =>
    state.role
      ? {
          memberId: "m1",
          role: state.role,
          organization: { id: "org-1", name: "Agency", slug: "agency" },
        }
      : null,
}));

const { findOrgContext, hasOrganizationAccess, requireOrgContext } =
  await import("./context");

const TEAM: Role[] = ["OWNER", "ADMIN", "MANAGER", "MEMBER"];
const MINIMUMS: Array<Role | undefined> = [undefined, "CLIENT", "MEMBER"];
const notFoundDigest = { digest: expect.stringContaining("404") };

beforeEach(() => {
  state.user = { id: "u1", email: "u@example.test", name: null };
});

describe("organization access", () => {
  test("only CLIENT is refused", () => {
    expect(hasOrganizationAccess("CLIENT")).toBe(false);
    for (const role of TEAM) expect(hasOrganizationAccess(role)).toBe(true);
  });

  test("fails closed: a role that is not a reviewed team role is refused", async () => {
    expect(hasOrganizationAccess("AUDITOR" as Role)).toBe(false);
    state.role = "AUDITOR" as Role;
    await expect(requireOrgContext("agency")).rejects.toMatchObject(
      notFoundDigest,
    );
    expect(await findOrgContext("agency")).toBeNull();
  });

  test("CLIENT members get the non-member 404 whatever the minimum role", async () => {
    for (const minimum of MINIMUMS) {
      state.role = "CLIENT";
      await expect(requireOrgContext("agency", minimum)).rejects.toMatchObject(
        notFoundDigest,
      );
      state.role = null;
      await expect(requireOrgContext("agency", minimum)).rejects.toMatchObject(
        notFoundDigest,
      );
    }
  });

  test("route handlers: null for CLIENT members, as for non-members", async () => {
    for (const minimum of MINIMUMS) {
      state.role = "CLIENT";
      expect(await findOrgContext("agency", minimum)).toBeNull();
    }
  });

  test("team roles are unchanged: access, and the usual minimum-role check", async () => {
    for (const role of TEAM) {
      state.role = role;
      await expect(requireOrgContext("agency")).resolves.toMatchObject({
        role,
        memberId: "m1",
      });
      expect(await findOrgContext("agency")).toMatchObject({ role });
    }
    state.role = "MEMBER";
    await expect(requireOrgContext("agency", "MANAGER")).rejects.toThrow(
      "You do not have permission to do that.",
    );
    expect(await findOrgContext("agency", "MANAGER")).toBeNull();
  });
});
