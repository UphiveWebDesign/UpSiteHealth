import { afterEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import {
  identityCapabilities,
  M1_OBJECTS,
  resetCapabilitiesCache,
} from "./capabilities";

afterEach(() => {
  resetCapabilitiesCache();
  vi.restoreAllMocks();
});

const ALL = {
  events: true,
  evidence: true,
  columns: true,
  eventTypes: true,
  triggers: true,
  recurrence: true,
};
const M1_PARTS = {
  evidence: false,
  columns: false,
  eventTypes: false,
  triggers: false,
  recurrence: false,
};

/** A fake client answering the catalog query with `row`. */
function fake(row: Record<string, unknown> | Error) {
  const calls = { n: 0, values: [] as unknown[] };
  const db = {
    $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      calls.n++;
      calls.values = values;
      if (row instanceof Error) throw row;
      return [row];
    },
  } as unknown as Pick<PrismaClient, "$queryRaw">;
  return { db, calls };
}

describe("identity capability check (option A: all or nothing)", () => {
  test("enabled only when history, the M1 columns, table, event types, triggers and follow-up link all exist", async () => {
    expect(await identityCapabilities(fake(ALL).db)).toEqual({
      enabled: true,
      missing: [],
    });
  });

  test("the M1 object names are bound as parameters, as the migration names them", async () => {
    const { db, calls } = fake(ALL);
    await identityCapabilities(db);
    expect(calls.values).toEqual([
      ...M1_OBJECTS.triggers,
      M1_OBJECTS.recurrenceIndex,
      M1_OBJECTS.recurrenceForeignKey,
    ]);
  });

  test("an M1 applied only in part (tables and columns, no triggers or follow-up link) stays off", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const caps = await identityCapabilities(
      fake({ ...ALL, triggers: false, recurrence: false }).db,
    );
    expect(caps.enabled).toBe(false);
    expect(caps.missing).toHaveLength(2);
  });

  test.each([
    ["events", "recommendation_events"],
    ["evidence", "recommendation_evidence"],
    ["columns", '"identityKey"'],
    ["eventTypes", "IDENTITY_CHANGED"],
    ["triggers", "recommendation_evidence_append_only"],
    ["recurrence", "recurrenceOfId"],
  ])(
    "any one part missing (%s) keeps it off and names it",
    async (part, named) => {
      vi.spyOn(log, "info").mockImplementation(() => {});
      const caps = await identityCapabilities(
        fake({ ...ALL, [part]: false }).db,
      );
      expect(caps.enabled).toBe(false);
      expect(caps.missing).toHaveLength(1);
      expect(caps.missing[0]).toContain(named);
    },
  );

  test("today's databases: events present or not, nothing from M1, so off", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    for (const events of [true, false]) {
      resetCapabilitiesCache();
      const caps = await identityCapabilities(fake({ events, ...M1_PARTS }).db);
      expect(caps.enabled).toBe(false);
      expect(caps.missing).toHaveLength(events ? 5 : 6);
    }
  });

  test("an unexpected answer (another fake, a null) counts as missing, never as present", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    expect(
      (await identityCapabilities(fake({ present: false }).db)).enabled,
    ).toBe(false);
    resetCapabilitiesCache();
    expect(
      (await identityCapabilities(fake({ ...ALL, columns: null }).db)).enabled,
    ).toBe(false);
  });

  test("a failed check is off and not cached; logged as a warning", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const { db, calls } = fake(new Error("boom"));
    expect(await identityCapabilities(db)).toEqual({
      enabled: false,
      missing: ["capability check failed"],
    });
    await identityCapabilities(db);
    expect(calls.n).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "recommendation_identity.check_failed",
      {},
      expect.any(Error),
    );
  });

  test("cached for a minute; unavailability is reported once per process", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const { db, calls } = fake({ ...ALL, columns: false });
      await identityCapabilities(db);
      await identityCapabilities(db);
      expect(calls.n).toBe(1);
      vi.advanceTimersByTime(61_000);
      await identityCapabilities(db);
      expect(calls.n).toBe(2);
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith("recommendation_identity.unavailable", {
        missing: [expect.stringContaining('"identityKey"')],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
