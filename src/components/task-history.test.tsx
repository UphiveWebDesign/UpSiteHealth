// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { HistoryEvent } from "@/lib/recommendations/history";
import { TaskHistory } from "./task-history";

afterEach(cleanup);

describe("TaskHistory", () => {
  test("no history table: says so, never an empty history", () => {
    render(<TaskHistory events={null} />);
    expect(
      screen.getByText("History is not recorded on this database yet."),
    ).toBeTruthy();
    expect(screen.getByText("History").textContent).toBe("History");
  });

  test("no events yet: says history starts when it was enabled", () => {
    render(<TaskHistory events={[]} />);
    expect(screen.getByText(/No changes recorded yet/).textContent).toMatch(
      /earlier changes are not shown/,
    );
  });

  test("events are listed oldest first with who, what, when and evidence", () => {
    const events: HistoryEvent[] = [
      {
        id: "a",
        type: "CREATED",
        fromStatus: null,
        toStatus: "PROPOSED",
        note: null,
        evidence: null,
        createdAt: new Date("2026-10-24T09:00:00Z"),
        actorUserId: null,
        actor: null,
      },
      {
        id: "b",
        type: "STATUS_CHANGED",
        fromStatus: "PROPOSED",
        toStatus: "COMPLETED",
        note: null,
        evidence: { basis: "seo-rule", crawlRunId: "crawl9" },
        createdAt: new Date("2026-10-24T10:00:00Z"),
        actorUserId: null,
        actor: null,
      },
    ];
    render(<TaskHistory events={events} />);
    expect(screen.getByText("History (2)")).toBeTruthy();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toMatch(/Added as proposed · UpSiteHealth \(automatic\)/);
    expect(items[1]).toMatch(/Changed from proposed to done/);
    expect(items[1]).toMatch(/Crawl crawl9/);
    expect(
      screen
        .getAllByRole("listitem")[1]
        .querySelector("time")
        ?.getAttribute("dateTime"),
    ).toBe("2026-10-24T10:00:00.000Z");
  });
});
