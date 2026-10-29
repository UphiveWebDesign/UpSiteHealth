import { afterEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  changeStatus,
  historyAvailable,
  recordEvents,
  resetHistoryCache,
} from "./events";
import { verifiedForRecurrence } from "./recurrence";

afterEach(() => resetHistoryCache());

/** A fake client: one task row, and whatever events are written. */
function fake(present: boolean, status = "PROPOSED") {
  const row = { id: "r1", status };
  const written: unknown[] = [];
  const queries = { raw: 0 };
  const tx = {
    recommendation: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: { status: string };
      }) => {
        if (where.id !== row.id || where.status !== row.status)
          return { count: 0 };
        row.status = data.status;
        return { count: 1 };
      },
    },
    recommendationEvent: {
      createMany: async ({ data }: { data: unknown[] }) => {
        written.push(...data);
        return { count: data.length };
      },
    },
  };
  const db = {
    ...tx,
    $queryRaw: async () => {
      queries.raw++;
      return [{ present }];
    },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  return { db, row, written, queries };
}

const change = (history: boolean) => ({
  id: "r1",
  organizationId: "o",
  websiteId: "w",
  from: "PROPOSED" as const,
  to: "COMPLETED" as const,
  actorUserId: "u1",
  history,
});

describe("recommendation events helpers", () => {
  test("without the history table, the change still happens and nothing is written", async () => {
    const f = fake(false);
    expect(await historyAvailable(f.db)).toBe(false);
    expect(await changeStatus(f.db, change(await historyAvailable(f.db)))).toBe(
      true,
    );
    expect(f.row.status).toBe("COMPLETED");
    expect(f.written).toEqual([]);
    // Checked once, then cached.
    expect(f.queries.raw).toBe(1);
  });

  test("a person's change records one STATUS_CHANGED with the actor, no verification", async () => {
    const f = fake(true);
    expect(await changeStatus(f.db, change(true))).toBe(true);
    expect(f.written).toEqual([
      {
        organizationId: "o",
        websiteId: "w",
        recommendationId: "r1",
        type: "STATUS_CHANGED",
        fromStatus: "PROPOSED",
        toStatus: "COMPLETED",
        note: null,
        actorUserId: "u1",
      },
    ]);
  });

  test("UpSiteHealth's completion adds the verification with its evidence", async () => {
    const f = fake(true);
    const verification = { basis: "seo-rule", crawlRunId: "c1" };
    await changeStatus(f.db, {
      ...change(true),
      actorUserId: null,
      verification,
    });
    expect(f.written).toEqual([
      expect.objectContaining({
        type: "STATUS_CHANGED",
        actorUserId: null,
        evidence: verification,
      }),
      expect.objectContaining({
        type: "VERIFICATION_RECORDED",
        actorUserId: null,
        toStatus: "COMPLETED",
        evidence: verification,
      }),
    ]);
  });

  test("a task that changed meanwhile is left alone and nothing is recorded", async () => {
    const f = fake(true, "DISMISSED");
    expect(await changeStatus(f.db, change(true))).toBe(false);
    expect(f.row.status).toBe("DISMISSED");
    expect(f.written).toEqual([]);
  });

  test("recordEvents writes nothing for an empty list", async () => {
    const createMany = vi.fn();
    await recordEvents({ recommendationEvent: { createMany } }, []);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("rowUpdatedAt in the verification (Stage 2 D1, step C1b)", () => {
  /** One task row whose updatedAt moves on every Prisma update, as @updatedAt does. */
  function store() {
    let clock = Date.parse("2026-10-21T10:00:00.000Z");
    const row = { id: "r1", status: "PROPOSED", updatedAt: new Date(clock) };
    const written: Array<Record<string, unknown>> = [];
    const tx = {
      recommendation: {
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: { status: string };
        }) => {
          if (where.id !== row.id || where.status !== row.status)
            return { count: 0 };
          row.status = data.status;
          row.updatedAt = new Date((clock += 1234));
          return { count: 1 };
        },
        findUnique: async () => ({ updatedAt: row.updatedAt }),
      },
      recommendationEvent: {
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          written.push(...data);
          return { count: data.length };
        },
      },
    };
    const db = {
      ...tx,
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    return { db, row, written };
  }
  const complete = (recordRowUpdatedAt?: boolean) => ({
    id: "r1",
    organizationId: "o",
    websiteId: "w",
    from: "PROPOSED" as const,
    to: "COMPLETED" as const,
    actorUserId: null,
    history: true,
    verification: {
      basis: "seo-rule",
      observedAt: "2026-10-21T09:00:00.000Z",
      ruleId: "TECH_H1_MISSING",
    },
    recordRowUpdatedAt,
  });
  const events = (written: Array<Record<string, unknown>>) =>
    written.map((e) => ({
      type: e.type as "STATUS_CHANGED" | "VERIFICATION_RECORDED",
      createdAt: new Date("2026-10-21T10:00:01Z"),
      toStatus: e.toStatus as "COMPLETED",
      actorUserId: e.actorUserId as null,
      evidence: e.evidence,
    }));

  test("records the row's updatedAt after the completing update, read in the same transaction", async () => {
    const s = store();
    expect(await changeStatus(s.db, complete(true))).toBe(true);
    const at = s.row.updatedAt.toISOString();
    expect(s.written).toEqual([
      expect.objectContaining({
        type: "STATUS_CHANGED",
        evidence: expect.objectContaining({ rowUpdatedAt: at }),
      }),
      expect.objectContaining({
        type: "VERIFICATION_RECORDED",
        evidence: expect.objectContaining({ rowUpdatedAt: at }),
      }),
    ]);
  });

  test("without the capability nothing is added (today's evidence, exactly)", async () => {
    const s = store();
    await changeStatus(s.db, complete());
    for (const e of s.written)
      expect(e.evidence).toEqual(complete().verification);
  });

  test("round trip: what C1b records verifies for D1; a later write without an event makes it stale", async () => {
    const s = store();
    await changeStatus(s.db, complete(true));
    const basis = { kind: "seo-rule", ruleId: "TECH_H1_MISSING" } as const;
    const row = () => ({
      status: "COMPLETED" as const,
      updatedAt: s.row.updatedAt,
    });
    expect(
      verifiedForRecurrence(row(), basis, events(s.written)),
    ).not.toBeNull();
    // e.g. a Prisma update of the row with no event: updatedAt moves on.
    s.row.updatedAt = new Date(s.row.updatedAt.getTime() + 1);
    expect(verifiedForRecurrence(row(), basis, events(s.written))).toBeNull();
  });

  test("legacy: a verification recorded before C1b (no rowUpdatedAt) never qualifies", async () => {
    const s = store();
    await changeStatus(s.db, complete());
    const basis = { kind: "seo-rule", ruleId: "TECH_H1_MISSING" } as const;
    expect(
      verifiedForRecurrence(
        { status: "COMPLETED", updatedAt: s.row.updatedAt },
        basis,
        events(s.written),
      ),
    ).toBeNull();
  });
});
