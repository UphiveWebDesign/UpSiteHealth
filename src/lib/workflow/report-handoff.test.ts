import { describe, expect, test } from "vitest";
import {
  clientLinkPath,
  handoffQuery,
  MAX_THROUGH_AGE_DAYS,
  parseThrough,
  parseView,
  throughOf,
} from "./report-handoff";

const NOW = new Date("2026-11-13T15:30:00Z");

describe("fixed reporting period (through)", () => {
  test("a past day fixes the period: its end is the next midnight UTC", () => {
    expect(parseThrough("2026-11-12", NOW)).toEqual(
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(parseThrough("2026-10-01", NOW)).toEqual(
      new Date("2026-10-02T00:00:00Z"),
    );
  });

  test("today, the future, impossible dates, other formats and very old dates are ignored", () => {
    for (const v of [
      "2026-11-13",
      "2026-12-01",
      "2026-02-30",
      "2026-13-01",
      "26-11-12",
      "2026-11-12T00:00:00Z",
      "2026/11/12",
      "",
      undefined,
      ["2026-11-12"],
      20261112,
    ])
      expect(parseThrough(v, NOW)).toBeNull();
    const old = new Date(
      NOW.getTime() - (MAX_THROUGH_AGE_DAYS + 2) * 86_400_000,
    );
    expect(parseThrough(old.toISOString().slice(0, 10), NOW)).toBeNull();
  });

  test("throughOf gives the period's last whole day, and round-trips", () => {
    const end = new Date("2026-11-13T00:00:00Z");
    expect(throughOf({ end })).toBe("2026-11-12");
    expect(parseThrough(throughOf({ end }), NOW)).toEqual(end);
  });
});

describe("views and links", () => {
  test("only the exact value opens the client-ready view", () => {
    expect(parseView("client")).toBe("client");
    for (const v of [undefined, "", "CLIENT", ["client"], "review"])
      expect(parseView(v)).toBe("review");
  });

  test("team URLs keep period, fixed end, plan choice, view and print request", () => {
    expect(
      handoffQuery({
        kind: "28d",
        through: "2026-11-12",
        included: true,
        selection: { explicit: true, ids: ["aaaaaaaaaa"] },
        view: "client",
        pdf: true,
      }),
    ).toBe(
      "?period=28d&content=include&sel=1&pick=aaaaaaaaaa&through=2026-11-12&view=client&pdf=1",
    );
    expect(
      handoffQuery({
        kind: "7d",
        through: null,
        included: false,
        selection: { explicit: false, ids: [] },
      }),
    ).toBe("?period=7d");
  });

  test("the client link carries the period only: no plan, selection, view or print parameters", () => {
    const link = clientLinkPath("/o/a/websites/w/report", "28d", "2026-11-12");
    expect(link).toBe("/o/a/websites/w/report?period=28d&through=2026-11-12");
    expect(link).not.toMatch(/content|sel=|pick|view|pdf/);
  });
});
