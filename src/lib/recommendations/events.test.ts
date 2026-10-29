import { afterEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  changeStatus,
  historyAvailable,
  recordEvents,
  resetHistoryCache,
} from "./events";

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
