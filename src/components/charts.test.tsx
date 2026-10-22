// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { CrawlHistoryRow } from "@/lib/workflow/history";
import type { TaskActivity } from "@/lib/workflow/progress";
import { chartScale, CrawlTimeline, SeverityBar, TrendChart } from "./charts";
import { TaskActivitySummary } from "./workflow";

afterEach(cleanup);

const pts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    label: `Day ${i + 1}`,
    at: new Date(Date.UTC(2026, 9, i + 1)),
  }));
const series = (values: number[]) => [
  {
    label: "All findings",
    values,
    pattern: "solid" as const,
    tone: "brand" as const,
  },
  {
    label: "High or critical",
    values: values.map((v) => Math.floor(v / 4)),
    pattern: "dashed" as const,
    tone: "danger" as const,
  },
];

describe("TrendChart", () => {
  test("no data and a single point show the empty state, never a line", () => {
    for (const n of [0, 1]) {
      const { container } = render(
        <TrendChart
          title="Findings"
          description="d"
          points={pts(n)}
          series={series(Array(n).fill(5))}
          empty="Not enough history yet."
        />,
      );
      expect(screen.getByText("Not enough history yet.")).toBeDefined();
      expect(container.querySelector("path")).toBeNull();
      cleanup();
    }
  });

  test("multiple points: accessible summary, tooltips, legend by line style, data table", () => {
    const { container } = render(
      <TrendChart
        title="Findings"
        description="d"
        points={pts(3)}
        series={series([24, 20, 21])}
        empty="x"
      />,
    );
    // Two sizes (desktop / small screens); CSS shows exactly one of them.
    const charts = screen.getAllByRole("img");
    expect(charts).toHaveLength(2);
    expect(charts[0].getAttribute("class")).toContain("sm:block");
    expect(charts[1].getAttribute("class")).toContain("sm:hidden");
    for (const chart of charts) {
      expect(chart.getAttribute("aria-label")).toContain(
        "All findings: from 24 on Day 1 to 21 on Day 3",
      );
      // One tooltip per point per series, with the date and value.
      const titles = [...chart.querySelectorAll("circle > title")].map(
        (t) => t.textContent,
      );
      expect(titles).toContain("Day 2: 20 all findings");
      expect(titles).toHaveLength(6);
      // The dashed series is distinguishable without colour.
      expect(
        chart.querySelectorAll('path[stroke-dasharray="5 4"]'),
      ).toHaveLength(1);
    }
    // Screen-reader table repeats every value.
    const rows = container.querySelectorAll("table.sr-only tbody tr");
    expect(rows).toHaveLength(3);
    expect([...rows[0].children].map((c) => c.textContent)).toEqual([
      "Day 1",
      "24",
      "6",
    ]);
  });
});

describe("chart scale", () => {
  test("every gridline label equals the value it is drawn at", () => {
    for (let v = 0; v <= 1200; v++) {
      const { max, ticks } = chartScale(v);
      expect(max).toBeGreaterThanOrEqual(v);
      for (const t of ticks) expect(Number.isInteger(t), `max ${v}`).toBe(true);
    }
    expect(chartScale(7)).toEqual({ max: 8, ticks: [0, 4, 8] }); // was 7 → "3.5" shown as 4
    expect(chartScale(3)).toEqual({ max: 4, ticks: [0, 2, 4] });
    expect(chartScale(24)).toEqual({ max: 30, ticks: [0, 15, 30] });
  });

  test("rendered axis labels are the exact tick values", () => {
    const { container } = render(
      <TrendChart
        title="T"
        description="d"
        points={pts(2)}
        series={series([5, 7])}
        empty="x"
      />,
    );
    const labels = [...container.querySelectorAll("svg[role=img] text")]
      .map((t) => t.textContent)
      .filter((t) => /^\d+(\.\d+)?$/.test(t ?? ""));
    expect(new Set(labels)).toEqual(new Set(["0", "4", "8"]));
  });
});

describe("TaskActivitySummary", () => {
  test("never attributes all completion to the team", () => {
    const activity = {
      reportedDone: 3,
      verifiedNow: 2,
      awaitingRecheck: 1,
      stillDetected: 0,
      openNow: 4,
      dateSource: "last-updated",
      items: [],
    } as TaskActivity;
    const { container } = render(<TaskActivitySummary activity={activity} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Completed in this period");
    expect(text).toContain("automatic completion after a confirmed recheck");
    expect(text).not.toMatch(/reported by your team/i);
  });
});

describe("SeverityBar", () => {
  test("missing data, a genuine zero and real values are all different", () => {
    render(<SeverityBar totals={null} />);
    expect(screen.getByText("Not measured")).toBeDefined();
    cleanup();
    render(<SeverityBar totals={{}} />);
    expect(screen.getByText("No findings")).toBeDefined();
    cleanup();
    render(<SeverityBar totals={{ HIGH: 2, INFO: 5 }} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Findings by severity: 2 high, 5 info",
    );
  });
});

describe("CrawlTimeline", () => {
  const row = (o: Partial<CrawlHistoryRow>): CrawlHistoryRow => ({
    id: Math.random().toString(),
    status: "COMPLETED",
    at: new Date("2026-10-01T10:00:00Z"),
    pagesCrawled: 10,
    pagesDiscovered: 10,
    maxPages: 100,
    maxDepth: 5,
    findings: 12,
    bySeverity: {},
    ...o,
  });
  const fixture = () => {
    const base = row({ id: "b", at: new Date("2026-09-01T00:00:00Z") });
    return {
      base,
      rows: [
        row({ id: "p", status: "PARTIAL", findings: 3, pagesCrawled: 3 }),
        row({ id: "l", maxPages: 20 }),
        row({ id: "f", status: "FAILED", findings: null }),
        row({ id: "ok", findings: 9 }),
        base,
      ],
    };
  };

  test("desktop table and mobile cards say the same thing for each crawl", () => {
    const { base, rows } = fixture();
    const { container } = render(<CrawlTimeline baseline={base} rows={rows} />);
    const table = container.querySelector("table")!;
    const cards = container.querySelector('ul[aria-label="Recent crawls"]')!;
    for (const view of [table, cards]) {
      const text = (sel: string) =>
        [...view.querySelectorAll(sel)].map((e) => e.textContent);
      const all = view.textContent ?? "";
      expect(all).toContain("Baseline");
      expect(all.match(/No: did not complete/g)).toHaveLength(2); // partial, failed
      expect(all).toContain("No: different crawl limits");
      expect(all).toContain("Not analysed");
      // Non-comparable counts are marked; comparable ones are plain.
      expect(all.match(/\(not comparable\)/g)).toHaveLength(2);
      expect(text("span.text-muted").join(" ")).toContain("3 (not comparable)");
      expect(all).toContain("Partial (page limit)");
      expect(all).toContain("Failed");
    }
  });

  test("mobile: one card per crawl with every field, no forced horizontal scroll", () => {
    const { base, rows } = fixture();
    const { container } = render(<CrawlTimeline baseline={base} rows={rows} />);
    const cards = container.querySelector('ul[aria-label="Recent crawls"]')!;
    // Shown below 640px only; the table only from 640px.
    expect(cards.getAttribute("class")).toContain("sm:hidden");
    expect(
      container.querySelector("table")!.parentElement!.getAttribute("class"),
    ).toContain("hidden sm:block");
    expect(container.innerHTML).not.toMatch(/min-w-\[/);
    const items = [...cards.querySelectorAll(":scope > li")];
    expect(items).toHaveLength(rows.length);
    for (const li of items) {
      const labels = [...li.querySelectorAll("dt")].map((d) => d.textContent);
      expect(labels).toEqual([
        "Pages analysed",
        "Findings",
        "Comparable to baseline",
      ]);
      expect(li.querySelectorAll("dd")).toHaveLength(3);
    }
    // The partial crawl's card cannot read as an improvement.
    const partial = items[0].textContent ?? "";
    expect(partial).toContain("Partial (page limit)");
    expect(partial).toContain("3 (not comparable)");
    expect(partial).toContain("No: did not complete");
  });

  test("no crawls", () => {
    render(<CrawlTimeline rows={[]} baseline={null} />);
    expect(screen.getByText("No crawls yet.")).toBeDefined();
  });
});
