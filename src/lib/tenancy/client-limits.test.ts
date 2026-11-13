import { describe, expect, test } from "vitest";
import type { Role } from "@/generated/prisma/enums";
import {
  ALERT_RECIPIENTS,
  canExport,
  canSeeMemberIdentities,
  isTeamRole,
  memberListScope,
  notificationScope,
} from "./client-limits";

const TEAM: Role[] = ["OWNER", "ADMIN", "MANAGER", "MEMBER"];

describe("interim limits for CLIENT members", () => {
  test("team roles keep organization-wide behaviour", () => {
    for (const role of TEAM) {
      expect(isTeamRole(role)).toBe(true);
      expect(canExport(role)).toBe(true);
      expect(canSeeMemberIdentities(role)).toBe(true);
      expect(memberListScope(role, "m1")).toEqual({});
      expect(notificationScope(role, "m1")).toEqual({
        recipientMemberId: "m1",
      });
    }
  });

  test("CLIENT members: no exports, no identities, only themselves, no notifications", () => {
    expect(isTeamRole("CLIENT")).toBe(false);
    expect(canExport("CLIENT")).toBe(false);
    expect(canSeeMemberIdentities("CLIENT")).toBe(false);
    expect(memberListScope("CLIENT", "m1")).toEqual({ id: "m1" });
    // Own deliveries only, and an id list that matches none.
    expect(notificationScope("CLIENT", "m1")).toEqual({
      recipientMemberId: "m1",
      id: { in: [] },
    });
  });

  test("alert recipients exclude CLIENT members", () => {
    expect(ALERT_RECIPIENTS).toEqual({ role: { not: "CLIENT" } });
  });
});
