// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ContentAction, ContentPlan } from "@/lib/workflow/content-plan";
import { ContentPlanBody, ContentPlanTeamNotes } from "./content-plan";

afterEach(cleanup);

const SEEN = new Date("2026-11-10T09:00:00Z");
const link: ContentAction = {
  key: "k-link",
  id: "aaaaaaaaaa",
  kind: "link",
  service: "Wedding flowers",
  locations: [],
  title: "Link to the Wedding flowers page",
  why: "8 pages already mention Wedding flowers but do not link to its page.",
  todo: "Turn the words that name Wedding flowers into a link.",
  pages: ["https://bloom.example/"],
  target: "https://bloom.example/wedding-flowers",
  passages: [
    {
      url: "https://bloom.example/",
      passage: "We arrange wedding flowers for every occasion.",
    },
  ],
  morePages: 7,
  facts: [
    "“Wedding flowers” (entered by our team, not confirmed by the client)",
  ],
  basis: [],
  confirm: "Confirm “Wedding flowers” with the client.",
  priority: "normal",
  priorityReason: "The service page is reachable.",
  doneWhen: "Each listed page links to the Wedding flowers page.",
  seenAt: SEEN,
  notRecheckedSince: new Date("2026-11-12T09:00:00Z"),
  progress: "awaiting-check",
};
const plan = (over: Partial<Extract<ContentPlan, { state: "ready" }>> = {}) =>
  ({
    state: "ready",
    groups: [
      {
        kind: "link",
        title: "Help visitors reach service pages",
        intro: "Intro.",
        actions: [link],
      },
    ],
    newPages: [
      {
        id: "bbbbbbbbbb",
        title: "Add a page for “Cottages”",
        progress: "to-do",
      },
    ],
    heldBack: [],
    dismissed: 0,
    ignored: 0,
    total: 1,
    pagesToChange: 1,
    seen: { from: SEEN, to: SEEN },
    crawl: {
      analyzedAt: new Date("2026-11-12T09:00:00Z"),
      note: "The latest crawl did not complete.",
    },
    unconfirmed: "Some details come from our team.",
    ...over,
  }) as ContentPlan;

describe("the plan as the client reads it", () => {
  test("an action shows its pages, the passage, the target, what to check first and how it is confirmed", () => {
    render(<ContentPlanBody plan={plan()} />);
    const a = screen.getByTestId("content-action");
    expect(
      within(a).getByText("1. Link to the Wedding flowers page"),
    ).toBeTruthy();
    expect(within(a).getByText("Then")).toBeTruthy();
    expect(
      within(a).getByText("Done, waiting for the next crawl to confirm"),
    ).toBeTruthy();
    expect(
      within(a).getByText(
        /Where it already mentions it: “We arrange wedding flowers/,
      ),
    ).toBeTruthy();
    expect(within(a).getByText("and 7 more pages")).toBeTruthy();
    expect(
      within(a).getByText("https://bloom.example/wedding-flowers"),
    ).toBeTruthy();
    expect(within(a).getByText("Check first")).toBeTruthy();
    expect(within(a).getByText(/did not check it again/)).toBeTruthy();
    expect(within(a).getByText(/Based on: “Wedding flowers”/)).toBeTruthy();
  });

  test("plan-level warnings, new pages and the summary line", () => {
    render(<ContentPlanBody plan={plan()} />);
    expect(screen.getByText("Check the evidence first")).toBeTruthy();
    expect(screen.getByText("Some details come from our team.")).toBeTruthy();
    // The complete crawl the actions were seen in, not the later
    // incomplete one (browser check, 13 Nov).
    expect(
      screen.getByText(
        "1 action on 1 page, from the complete crawl of 2026-11-10.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Add a page for “Cottages”")).toBeTruthy();
  });

  test("unavailable and empty plans say so", () => {
    render(
      <ContentPlanBody
        plan={{ state: "unavailable", reason: "No facts table." }}
      />,
    );
    expect(screen.getByText("No facts table.")).toBeTruthy();
    cleanup();
    render(
      <ContentPlanBody
        plan={plan({ groups: [], newPages: [], total: 0, pagesToChange: 0 })}
      />,
    );
    expect(screen.getByTestId("content-plan-empty")).toBeTruthy();
    expect(screen.queryByTestId("content-action")).toBeNull();
  });
});

describe("print layout (browser check, 13 Nov)", () => {
  test("group headings print with their first action; the new-pages list is kept whole", () => {
    render(<ContentPlanBody plan={plan()} />);
    const head = screen.getByText(
      "Help visitors reach service pages",
    ).parentElement!;
    expect(head.className).toContain("print:break-after-avoid");
    expect(head.className).toContain("print:break-inside-avoid");
    expect(
      screen.getByRole("region", { name: "New pages in the plan" }).className,
    ).toContain("print:break-inside-avoid");
    for (const a of screen.getAllByTestId("content-action"))
      expect(a.className).toContain("print:break-inside-avoid");
  });

  test("actions from different crawls give the date range", () => {
    render(
      <ContentPlanBody
        plan={plan({
          seen: { from: new Date("2026-11-01T00:00:00Z"), to: SEEN },
        })}
      />,
    );
    expect(
      screen.getByText(/from complete crawls of 2026-11-01 to 2026-11-10\./),
    ).toBeTruthy();
  });
});

describe("team notes", () => {
  test("never printed; list what was left out and why", () => {
    render(
      <ContentPlanTeamNotes
        included={false}
        plan={plan({
          heldBack: [{ label: "Funeral flowers", reason: "Too old." }],
          dismissed: 2,
          ignored: 1,
        })}
      />,
    );
    const notes = screen.getByTestId("content-plan-team-notes");
    expect(notes.className).toContain("print:hidden");
    expect(within(notes).getByText(/Not included in the report/)).toBeTruthy();
    expect(within(notes).getByText("Funeral flowers: Too old.")).toBeTruthy();
    expect(
      within(notes).getByText(/2 items whose task the team dismissed/),
    ).toBeTruthy();
    expect(
      within(notes).getByText(/1 content finding marked ignored/),
    ).toBeTruthy();
  });

  test("requested with nothing selected, or nothing to share: says the report has no plan section", () => {
    render(
      <ContentPlanTeamNotes
        included={false}
        requested
        plan={plan()}
        selection={{ selected: 0, available: 2 }}
      />,
    );
    expect(screen.getByText(/No items are selected/)).toBeTruthy();
    cleanup();
    render(
      <ContentPlanTeamNotes
        included={false}
        requested
        plan={plan({ groups: [], newPages: [], total: 0 })}
        selection={{ selected: 0, available: 0 }}
      />,
    );
    expect(screen.getByText(/no content actions to share/)).toBeTruthy();
  });

  test("included with a selection: says how many items the client receives", () => {
    render(
      <ContentPlanTeamNotes
        included
        requested
        plan={plan()}
        selection={{ selected: 1, available: 2 }}
      />,
    );
    expect(
      screen.getByText(/included in this report with 1 of 2 items/),
    ).toBeTruthy();
  });

  test("say plainly when the plan is included", () => {
    render(<ContentPlanTeamNotes included plan={plan()} />);
    expect(screen.getByText(/is included in this report/)).toBeTruthy();
    expect(screen.queryByText(/Left out/)).toBeNull();
  });
});
