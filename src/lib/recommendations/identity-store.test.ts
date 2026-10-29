import { describe, expect, test } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  moveIdentityKey,
  readIdentityKeys,
  setIdentityKey,
} from "./identity-store";

/**
 * No database: a fake client records each tagged-template call, so the SQL
 * text and its bound values can be checked apart. What a real database does
 * with them (updatedAt untouched on COMPLETED and DISMISSED rows) needs M1
 * and an integration run (tests/integration/stage2-decisions.test.ts).
 */
function recorder(answer: unknown = 1) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const record = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    calls.push({ sql: strings.join("$?"), values });
    return answer;
  };
  const db = { $queryRaw: record, $executeRaw: record } as unknown as Pick<
    PrismaClient,
    "$queryRaw" | "$executeRaw"
  >;
  return { db, calls };
}

const scope = { websiteId: "w1", organizationId: "o1" };
const KEY = "seo:TECH_H1_MISSING";

describe("identity-store: the only raw SQL for identityKey (step C1b)", () => {
  test("no statement sets updatedAt, so keying a completed or dismissed row keeps it", async () => {
    const { db, calls } = recorder();
    await setIdentityKey(db, scope, "r1", KEY);
    await moveIdentityKey(db, scope, "r1", KEY, "seo:TECH_TITLE_MISSING");
    await readIdentityKeys(db, scope);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.sql).not.toMatch(/updatedAt/i);
  });

  test("every value is a bound parameter, never part of the SQL text", async () => {
    const hostile = `x'; UPDATE recommendations SET status = 'COMPLETED'; --`;
    const { db, calls } = recorder();
    await setIdentityKey(db, scope, hostile, hostile);
    await moveIdentityKey(db, scope, hostile, null, hostile);
    for (const c of calls) {
      expect(c.sql).not.toContain(hostile);
      expect(c.values).toContain(hostile);
    }
  });

  test("scoped to one website and organization, schema-qualified", async () => {
    const { db, calls } = recorder();
    await setIdentityKey(db, scope, "r1", KEY);
    await moveIdentityKey(db, scope, "r1", null, KEY);
    await readIdentityKeys(db, scope);
    for (const c of calls) {
      expect(c.sql).toContain("public.recommendations");
      expect(c.sql).toMatch(/"websiteId" = \$\?/);
      expect(c.sql).toMatch(/"organizationId" = \$\?/);
      expect(c.values).toEqual(expect.arrayContaining(["w1", "o1"]));
    }
  });

  test("a key is only ever added to a row without one; a move only from the key it still has", async () => {
    const { db, calls } = recorder();
    await setIdentityKey(db, scope, "r1", KEY);
    expect(calls[0].sql).toMatch(/"identityKey" IS NULL/);
    await moveIdentityKey(db, scope, "r1", KEY, "seo:TECH_TITLE_MISSING");
    expect(calls[1].sql).toMatch(
      /"identityKey" IS NOT DISTINCT FROM \$\?::text/,
    );
    expect(calls[1].values).toEqual(
      expect.arrayContaining([KEY, "seo:TECH_TITLE_MISSING"]),
    );
  });

  test("writes report whether exactly one row changed", async () => {
    expect(await setIdentityKey(recorder(1).db, scope, "r1", KEY)).toBe(true);
    expect(await setIdentityKey(recorder(0).db, scope, "r1", KEY)).toBe(false);
    expect(await moveIdentityKey(recorder(0).db, scope, "r1", KEY, KEY)).toBe(
      false,
    );
  });

  test("reading keeps only well-formed rows", async () => {
    const { db } = recorder([
      { id: "a", identityKey: KEY },
      { id: "b", identityKey: null },
      { id: 3, identityKey: KEY },
      null,
    ]);
    expect(await readIdentityKeys(db, scope)).toEqual(new Map([["a", KEY]]));
    expect(await readIdentityKeys(recorder([]).db, scope)).toEqual(new Map());
  });
});
