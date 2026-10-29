import { afterEach, describe, expect, test, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { identityCapabilities, resetCapabilitiesCache } from "./capabilities";

afterEach(() => {
  resetCapabilitiesCache();
  vi.restoreAllMocks();
});

const ALL = { events: true, evidence: true, columns: true, eventTypes: true };

/** A fake client answering the catalog query with `row`. */
function fake(row: Record<string, unknown> | Error) {
  const calls = { n: 0 };
  const db = {
    $queryRaw: async () => {
      calls.n++;
      if (row instanceof Error) throw row;
      return [row];
    },
  } as unknown as Pick<PrismaClient, "$queryRaw">;
  return { db, calls };
}

describe("identity capability check (option A: all or nothing)", () => {
  test("enabled only when history, the M1 columns and table, and both event types exist", async () => {
    expect(await identityCapabilities(fake(ALL).db)).toEqual({
      enabled: true,
      missing: [],
    });
  });

  test.each([
    ["events", "recommendation_events"],
    ["evidence", "recommendation_evidence"],
    ["columns", '"identityKey"'],
    ["eventTypes", "IDENTITY_CHANGED"],
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
      const caps = await identityCapabilities(
        fake({ events, evidence: false, columns: false, eventTypes: false }).db,
      );
      expect(caps.enabled).toBe(false);
      expect(caps.missing).toHaveLength(events ? 3 : 4);
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
