import { expect, test } from "vitest";
import { can, hasRoleAtLeast } from "./roles";

test("role hierarchy is OWNER > ADMIN > MANAGER > MEMBER > CLIENT", () => {
  expect(hasRoleAtLeast("OWNER", "ADMIN")).toBe(true);
  expect(hasRoleAtLeast("ADMIN", "OWNER")).toBe(false);
  expect(hasRoleAtLeast("MEMBER", "MEMBER")).toBe(true);
  expect(hasRoleAtLeast("CLIENT", "MEMBER")).toBe(false);
});

test("CLIENT members are read-only", () => {
  expect(can.view("CLIENT")).toBe(true);
  expect(can.editWebsites("CLIENT")).toBe(false);
  expect(can.editWebsites("MEMBER")).toBe(true);
  expect(can.manageMembers("MANAGER")).toBe(false);
  expect(can.manageOrganization("OWNER")).toBe(true);
});
