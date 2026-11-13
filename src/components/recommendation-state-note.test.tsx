// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CrawlWaitNotice } from "./crawl-wait-notice";
import { RecommendationStateNote } from "./recommendation-state-note";

afterEach(cleanup);

const CHECKED = new Date("2026-10-27T09:00:00Z");

describe("RecommendationStateNote", () => {
  test("still detected without a verified fix: a fix that has not worked yet", () => {
    render(
      <RecommendationStateNote
        state={{ kind: "still-detected", checkedAt: CHECKED }}
        source="crawl"
        completed
      />,
    );
    expect(screen.getByText("Still detected")).toBeTruthy();
    expect(screen.queryByText("Reappeared")).toBeNull();
  });

  test("still detected after a verified fix: reappeared, with when it was fixed and found again", () => {
    render(
      <RecommendationStateNote
        state={{ kind: "still-detected", checkedAt: CHECKED }}
        source="crawl"
        completed
        reappeared={{
          verifiedAt: new Date("2026-10-20T10:00:00Z"),
          fixedObservedAt: new Date("2026-10-20T09:58:00Z"),
          detectedAt: CHECKED,
          verifiedCrawlRunId: null,
        }}
      />,
    );
    expect(screen.getByText("Reappeared")).toBeTruthy();
    expect(screen.queryByText("Still detected")).toBeNull();
    const text = screen.getByText(/found it again/).textContent ?? "";
    expect(text).toMatch(/Verified fixed by the crawl on/);
    expect(text).toMatch(/Reopen it to work on it\./);
  });

  test("verified and waiting states are unchanged", () => {
    const { rerender } = render(
      <RecommendationStateNote
        state={{ kind: "verified" }}
        source="crawl"
        completed
      />,
    );
    expect(screen.getByText("Verified fixed")).toBeTruthy();
    rerender(
      <RecommendationStateNote
        state={{ kind: "awaiting-recheck" }}
        source="crawl"
        completed
      />,
    );
    expect(screen.getByText("Waiting for recheck")).toBeTruthy();
    rerender(
      <RecommendationStateNote
        state={{ kind: "active" }}
        source="crawl"
        completed={false}
      />,
    );
    expect(screen.queryByText(/Waiting|Verified|Still|Reappeared/)).toBeNull();
  });
});

describe("RecommendationStateNote: what changed", () => {
  const back = {
    verifiedAt: new Date("2026-10-20T10:00:00Z"),
    fixedObservedAt: new Date("2026-10-20T09:58:00Z"),
    detectedAt: CHECKED,
    verifiedCrawlRunId: "run-2",
  };
  const clue = "Page title: “Wedding flowers” → “Wedding flowers | Shop”";

  test("a reappeared task shows the comparison as a clue under its note", () => {
    render(
      <RecommendationStateNote
        state={{ kind: "still-detected", checkedAt: CHECKED }}
        source="crawl"
        completed
        reappeared={back}
        whatChanged={clue}
      />,
    );
    const line = screen.getByText(
      /What changed between the two crawls:/,
    ).parentElement!;
    expect(line.textContent).toBe(
      `What changed between the two crawls: ${clue} (a clue, not proof of the cause)`,
    );
  });

  test("never on a task that is not a verified fix that came back", () => {
    for (const props of [
      { state: { kind: "still-detected" as const, checkedAt: CHECKED } },
      { state: { kind: "verified" as const } },
      { state: { kind: "awaiting-recheck" as const } },
    ]) {
      const { unmount } = render(
        <RecommendationStateNote
          {...props}
          source="crawl"
          completed
          whatChanged={clue}
        />,
      );
      expect(screen.queryByText(/What changed/)).toBeNull();
      unmount();
    }
  });

  test("a reappeared task without reliable evidence shows no comparison", () => {
    render(
      <RecommendationStateNote
        state={{ kind: "still-detected", checkedAt: CHECKED }}
        source="crawl"
        completed
        reappeared={back}
        whatChanged={null}
      />,
    );
    expect(screen.getByText("Reappeared")).toBeTruthy();
    expect(screen.queryByText(/What changed/)).toBeNull();
  });
});

describe("CrawlWaitNotice", () => {
  const base = {
    crawlMode: "MANUAL" as const,
    monitoringEnabled: true,
    crawlsHref: "/crawls",
  };

  test("manual crawling with waiting tasks: offers the recheck crawl and the crawls page", () => {
    render(
      <CrawlWaitNotice
        {...base}
        waiting={2}
        startCrawl={<button type="submit">Start a recheck crawl</button>}
      />,
    );
    expect(screen.getByText(/2 tasks are waiting/)).toBeTruthy();
    expect(screen.getByText("Start a recheck crawl")).toBeTruthy();
    expect(screen.getByText("Go to crawls")).toBeTruthy();
  });

  test("viewers (no start control) still see the notice and the link", () => {
    render(<CrawlWaitNotice {...base} waiting={1} />);
    expect(screen.getByText(/1 task is waiting/)).toBeTruthy();
    expect(screen.queryByText("Start a recheck crawl")).toBeNull();
  });

  test("automatic crawling, or nothing waiting: no notice", () => {
    const { container, rerender } = render(
      <CrawlWaitNotice {...base} crawlMode="AUTOMATIC" waiting={3} />,
    );
    expect(container.textContent).toBe("");
    rerender(<CrawlWaitNotice {...base} waiting={0} />);
    expect(container.textContent).toBe("");
  });
});
