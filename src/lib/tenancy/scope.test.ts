import { describe, expect, test } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { scopeArgs, TENANT_MODELS, TenantScopeError } from "./scope";

const ORG = "org_a";

describe("TENANT_MODELS", () => {
  test("lists exactly the models that have an organizationId column", () => {
    const withOrgId = Object.values(Prisma.ModelName).filter((model) => {
      const fields = (Prisma as unknown as Record<string, object>)[
        `${model}ScalarFieldEnum`
      ];
      return "organizationId" in fields;
    });
    expect(new Set(withOrgId)).toEqual(TENANT_MODELS);
  });
});

describe("scopeArgs", () => {
  test("adds the organization filter to list queries", () => {
    expect(scopeArgs("Website", "findMany", undefined, ORG)).toEqual({
      where: { organizationId: ORG },
    });
    expect(
      scopeArgs("Website", "findMany", { where: { domain: "x.com" } }, ORG),
    ).toEqual({
      where: { AND: [{ domain: "x.com" }, { organizationId: ORG }] },
    });
  });

  test("cannot be bypassed with an OR filter", () => {
    const where = { OR: [{ organizationId: "org_b" }, { id: "w1" }] };
    expect(scopeArgs("Website", "count", { where }, ORG)).toEqual({
      where: { AND: [where, { organizationId: ORG }] },
    });
  });

  test("scopes unique lookups and rejects foreign organization ids", () => {
    expect(
      scopeArgs("Website", "findUnique", { where: { id: "w1" } }, ORG),
    ).toEqual({ where: { id: "w1", organizationId: ORG } });
    expect(() =>
      scopeArgs(
        "Website",
        "findUnique",
        { where: { id: "w1", organizationId: "org_b" } },
        ORG,
      ),
    ).toThrow(TenantScopeError);
  });

  test("stamps creates and rejects creates for another organization", () => {
    expect(
      scopeArgs("Website", "create", { data: { name: "A" } }, ORG),
    ).toEqual({ data: { name: "A", organizationId: ORG } });
    expect(
      scopeArgs(
        "Website",
        "createMany",
        { data: [{ name: "A" }, { name: "B" }] },
        ORG,
      ),
    ).toEqual({
      data: [
        { name: "A", organizationId: ORG },
        { name: "B", organizationId: ORG },
      ],
    });
    expect(() =>
      scopeArgs(
        "Website",
        "create",
        { data: { organizationId: "org_b" } },
        ORG,
      ),
    ).toThrow(TenantScopeError);
    expect(() =>
      scopeArgs(
        "Website",
        "create",
        { data: { organization: { connect: { id: "org_b" } } } },
        ORG,
      ),
    ).toThrow(TenantScopeError);
  });

  test("prevents moving records to another organization", () => {
    for (const op of ["update", "updateMany"]) {
      expect(() =>
        scopeArgs(
          "Website",
          op,
          { where: { id: "w1" }, data: { organizationId: "org_b" } },
          ORG,
        ),
      ).toThrow(TenantScopeError);
    }
    expect(() =>
      scopeArgs(
        "Website",
        "upsert",
        {
          where: { id: "w1" },
          create: {},
          update: { organizationId: "org_b" },
        },
        ORG,
      ),
    ).toThrow(TenantScopeError);
  });

  test("scopes upserts on both the lookup and the create branch", () => {
    expect(
      scopeArgs(
        "NotificationPreference",
        "upsert",
        {
          where: { organizationId: ORG },
          create: { enabled: true },
          update: {},
        },
        ORG,
      ),
    ).toEqual({
      where: { organizationId: ORG },
      create: { enabled: true, organizationId: ORG },
      update: {},
    });
  });

  test("confines Organization access to the current organization", () => {
    expect(
      scopeArgs("Organization", "findFirst", { where: { slug: "x" } }, ORG),
    ).toEqual({ where: { AND: [{ slug: "x" }, { id: ORG }] } });
    expect(() =>
      scopeArgs("Organization", "findUnique", { where: { id: "org_b" } }, ORG),
    ).toThrow(TenantScopeError);
    expect(() => scopeArgs("Organization", "findMany", {}, ORG)).toThrow();
    expect(() => scopeArgs("Organization", "delete", {}, ORG)).toThrow();
    expect(() =>
      scopeArgs(
        "Organization",
        "update",
        { where: {}, data: { id: "x" } },
        ORG,
      ),
    ).toThrow();
  });

  test("refuses global models such as User and Session", () => {
    for (const model of ["User", "Session", "Account", "SchedulerHeartbeat"]) {
      expect(() => scopeArgs(model, "findMany", {}, ORG)).toThrow(
        TenantScopeError,
      );
    }
  });
});
