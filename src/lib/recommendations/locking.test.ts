import { afterEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { applyRekeys, createRecommendationOnce } from "./generate";

/**
 * SIMULATED concurrency: an in-memory database whose every query yields to
 * other work, and whose $transaction runs callbacks one at a time (as the
 * website row lock does in Postgres). It proves the locking logic and the
 * re-checks inside the lock; it is not a test against real concurrent
 * database connections (the local `prisma dev` database serves one
 * connection, and no separate test database was authorised).
 */
type Row = {
  id: string;
  websiteId: string;
  organizationId: string;
  title: string;
  status: string;
};
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));

function fakeDb() {
  const rows: Row[] = [];
  let n = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const match = (r: Row, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) =>
      v && typeof v === "object" && "in" in (v as object)
        ? (v as { in: string[] }).in.includes(r[k as keyof Row])
        : r[k as keyof Row] === v,
    );
  const recommendation = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      await tick();
      const r = rows.find((x) => match(x, where));
      return r ? { id: r.id, status: r.status } : null;
    },
    create: async ({
      data,
    }: {
      data: Omit<Row, "id"> & { status?: string };
    }) => {
      await tick();
      const r = {
        ...data,
        id: `r${n++}`,
        status: data.status ?? "PROPOSED",
      } as Row;
      rows.push(r);
      return { id: r.id, status: r.status };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<Row>;
    }) => {
      await tick();
      const hit = rows.filter((x) => match(x, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
  const tx = { recommendation, $queryRaw: async () => [] };
  const db = {
    recommendation,
    // A database without the history table: these tests are about locking.
    $queryRaw: async () => [{ present: false }],
    // One transaction at a time: what the website row lock guarantees.
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => {
      const run = chain.then(() => fn(tx));
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { db: db as unknown as PrismaClient, rows };
}

const scope = { websiteId: "w", organizationId: "o" };
const ACC = "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)";
const OLD = "Add a page for “Cottages and Cafe” (BIZ_SERVICE_PAGE)";
const draft = {
  title: ACC,
  explanation: "x",
  priority: "HIGH" as const,
  expectedImpact: "y",
  recommendedAction: "z",
  issueId: null,
};

afterEach(() => vi.restoreAllMocks());

describe("re-keying and creation share the website lock (simulated concurrency)", () => {
  test("control: without the lock, interleaved check-then-create duplicates (the fake really interleaves)", async () => {
    const { db, rows } = fakeDb();
    const naive = async () => {
      if (
        !(await db.recommendation.findFirst({
          where: { ...scope, title: ACC },
        }))
      )
        await db.recommendation.create({ data: { ...scope, ...draft } });
    };
    await Promise.all([naive(), naive(), naive()]);
    expect(rows.filter((r) => r.title === ACC).length).toBeGreaterThan(1);
  });

  test("a re-key racing an Accept of the same purpose never leaves two tasks with one title", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    for (let round = 0; round < 30; round++) {
      const { db, rows } = fakeDb();
      rows.push({ id: "old", ...scope, title: OLD, status: "IN_PROGRESS" });
      const plan = {
        moves: [{ id: "old", from: OLD, to: ACC }],
        ambiguous: [],
      };
      const ops = [
        () =>
          createRecommendationOnce(db, scope, { ...draft, status: "PROPOSED" }),
        () => applyRekeys(db, scope, plan),
        () => createRecommendationOnce(db, scope, draft),
      ];
      if (round % 2) ops.reverse();
      await Promise.all(ops.map((op) => op()));
      expect(
        rows.filter((r) => r.title === ACC),
        `round ${round}`,
      ).toHaveLength(1);
      // Identity: the old task kept its id and status, moved or not.
      expect(rows.find((r) => r.id === "old")!.status).toBe("IN_PROGRESS");
    }
  });

  test("inside the lock, a move is re-checked: completed tasks and changed titles are never moved", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const { db, rows } = fakeDb();
    rows.push({ id: "done", ...scope, title: OLD, status: "COMPLETED" });
    rows.push({
      id: "gone",
      ...scope,
      title: "Renamed meanwhile (BIZ_SERVICE_PAGE)",
      status: "PROPOSED",
    });
    const plan = {
      moves: [
        { id: "done", from: OLD, to: ACC },
        {
          id: "gone",
          from: "Was this (BIZ_SERVICE_PAGE)",
          to: "Add a page for “X” (BIZ_SERVICE_PAGE)",
        },
      ],
      ambiguous: [],
    };
    expect(await applyRekeys(db, scope, plan)).toEqual([]);
    expect(rows.map((r) => r.title)).toEqual([
      OLD,
      "Renamed meanwhile (BIZ_SERVICE_PAGE)",
    ]);
  });

  test("dismissed tasks move and stay dismissed; repeating a sync is a no-op; moves and ambiguity are logged", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { db, rows } = fakeDb();
    rows.push({ id: "d", ...scope, title: OLD, status: "DISMISSED" });
    const plan = {
      moves: [{ id: "d", from: OLD, to: ACC }],
      ambiguous: [{ id: "a", title: "T", candidates: ["x", "y"] }],
    };
    expect(await applyRekeys(db, scope, plan)).toHaveLength(1);
    expect(await applyRekeys(db, scope, plan)).toHaveLength(0); // already moved
    expect(rows).toEqual([
      { id: "d", ...scope, title: ACC, status: "DISMISSED" },
    ]);
    expect(info).toHaveBeenCalledWith(
      "recommendation_rekeyed",
      expect.objectContaining({ recommendationId: "d", from: OLD, to: ACC }),
    );
    expect(warn).toHaveBeenCalledWith(
      "recommendation_rekey_ambiguous",
      expect.objectContaining({ recommendationId: "a", candidates: 2 }),
    );
  });

  // Stage 2, D2 (approved): every identity move keeps the row and records an
  // IDENTITY_CHANGED event with the old and new key and title. Step C1b: only
  // where every capability is present (option A), so the capability is
  // passed in; without it a move is only logged, as the test above pins.
  test("D2: a move records IDENTITY_CHANGED in the same transaction, where task history exists", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const rows = [{ id: "d", ...scope, title: OLD, status: "DISMISSED" }];
    const written: Array<Record<string, unknown>> = [];
    const tx = {
      recommendation: {
        findFirst: async () => null,
        updateMany: async ({ data }: { data: { title: string } }) => {
          rows[0].title = data.title;
          return { count: 1 };
        },
      },
      recommendationEvent: {
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          written.push(...data);
          return { count: data.length };
        },
      },
      $queryRaw: async () => [],
    };
    const db = {
      ...tx,
      $queryRaw: async () => [{ present: true }],
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    await applyRekeys(
      db,
      scope,
      {
        moves: [{ id: "d", from: OLD, to: ACC }],
        ambiguous: [],
      },
      { identity: true },
    );
    expect(rows[0]).toMatchObject({
      id: "d",
      title: ACC,
      status: "DISMISSED",
    });
    expect(written).toEqual([
      expect.objectContaining({
        recommendationId: "d",
        type: "IDENTITY_CHANGED",
        evidence: expect.objectContaining({ fromTitle: OLD, toTitle: ACC }),
      }),
    ]);
  });
});
