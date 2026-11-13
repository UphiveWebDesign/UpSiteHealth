// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Role } from "@/generated/prisma/enums";
import type { ContentPlan } from "@/lib/workflow/content-plan";

/**
 * The Report page with its data loaders replaced: what each role sees of
 * the content plan, with and without "Include content plan", and that the
 * plan is never loaded for client members whatever the URL says.
 */

const state = vi.hoisted(() => ({
  role: "MEMBER" as Role,
  loadContentPlan: vi.fn(),
  loadReportArgs: [] as unknown[][],
  replace: vi.fn(),
  evidence: {
    complete: { at: new Date("2026-11-10T09:00:00Z"), stale: false },
    laterIncomplete: null as Date | null,
  } as {
    complete: { at: Date; stale: boolean } | null;
    laterIncomplete: Date | null;
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ replace: state.replace }),
}));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/lib/tenancy/context", () => ({
  requireOrgContext: async () => ({
    role: state.role,
    organization: { id: "org-1" },
    db: {},
  }),
}));
vi.mock("@/components/website-nav", () => ({ WebsiteNav: () => null }));
vi.mock("@/components/print-button", () => ({ PrintButton: () => null }));
// next/form needs the app router; a plain GET form is what it renders.
vi.mock("next/form", () => ({
  default: ({
    action,
    children,
  }: {
    action: string;
    children: import("react").ReactNode;
  }) => (
    <form action={action} method="get">
      {children}
    </form>
  ),
}));
vi.mock("@/components/workflow", () => ({
  BaselineSummary: () => null,
  PeriodTechnical: () => null,
  SearchPerformanceNotConnected: () => null,
  SeverityBadges: () => null,
  TaskActivitySummary: () => null,
}));
vi.mock("@/lib/workflow/content-plan", async (original) => ({
  ...(await original<typeof import("@/lib/workflow/content-plan")>()),
  loadContentPlan: state.loadContentPlan,
}));

const item = (id: string, title: string, code: string) => ({
  id,
  title: `${title} (${code})`,
  displayTitle: title,
  code,
  workType: "fix",
  verification: "Confirmed by the next complete crawl.",
});
vi.mock("@/lib/workflow/report", () => ({
  executiveSummary: () => ["Summary line."],
  loadReport: async (...args: unknown[]) => (
    state.loadReportArgs.push(args),
    {
      organization: { name: "Agency" },
      client: { name: "Bloom", company: null },
      website: { name: "Bloom", url: "https://bloom.example/" },
      kind: "28d",
      period: {
        start: new Date("2026-10-16T00:00:00Z"),
        end: new Date("2026-11-13T00:00:00Z"),
      },
      generatedAt: new Date("2026-11-13T12:00:00Z"),
      baseline: {},
      technical: {
        state: "not-comparable",
        reason: "no-start",
        incompleteInPeriod: 0,
      },
      openAtStart: null,
      openAtEnd: null,
      endBySeverity: {},
      fixed: [],
      newFindings: [],
      recurring: [],
      activity: { items: [], reportedDone: 0, verifiedNow: 0 },
      plan: {
        "fix-first": [],
        continue: [],
        next: [
          item("t1", "Fix missing titles", "TECH_MISSING_TITLE"),
          item(
            "t2",
            "Service page does not describe the service",
            "CONTENT_SERVICE_NOT_DESCRIBED",
          ),
        ],
        waiting: [],
        summary: {
          open: 2,
          highPriority: 0,
          inProgress: 0,
          awaitingVerification: 0,
        },
      },
      sources: [],
      gaps: ["A gap."],
      evidence: state.evidence,
    }
  ),
}));

const PLAN: ContentPlan = {
  state: "ready",
  groups: [
    {
      kind: "describe",
      title: "Explain each service on its own page",
      intro: "Intro.",
      actions: [
        {
          key: "k1",
          id: "aaaaaaaaaa",
          kind: "describe",
          service: "Funeral flowers",
          locations: [],
          title: "Describe Funeral flowers on its page",
          why: "The page never mentions it.",
          todo: "Add a short section.",
          pages: ["https://bloom.example/funeral-flowers"],
          target: null,
          passages: [],
          morePages: 0,
          facts: ["“Funeral flowers” (from the client)"],
          basis: [],
          confirm: null,
          priority: "high",
          priorityReason: "The service's own page does not explain it.",
          doneWhen: "The page's main text names Funeral flowers.",
          seenAt: new Date("2026-11-10T09:00:00Z"),
          notRecheckedSince: null,
          progress: "to-do",
        },
      ],
    },
    {
      kind: "link",
      title: "Help visitors reach service pages",
      intro: "Intro.",
      actions: [
        {
          key: "k2",
          id: "bbbbbbbbbb",
          kind: "link",
          service: "Wedding flowers",
          locations: [],
          title: "Link to the Wedding flowers page",
          why: "1 page mentions it without a link.",
          todo: "Add a link.",
          pages: ["https://bloom.example/"],
          target: "https://bloom.example/wedding-flowers",
          passages: [],
          morePages: 0,
          facts: ["“Wedding flowers” (from the client)"],
          basis: [],
          confirm: null,
          priority: "normal",
          priorityReason: "Reachable.",
          doneWhen: "The page links to it.",
          seenAt: new Date("2026-11-10T09:00:00Z"),
          notRecheckedSince: null,
          progress: "to-do",
        },
      ],
    },
  ],
  newPages: [
    { id: "cccccccccc", title: "Add a page for “Cottages”", progress: "to-do" },
  ],
  heldBack: [{ label: "Wedding flowers", reason: "Too old." }],
  dismissed: 1,
  ignored: 0,
  total: 2,
  pagesToChange: 2,
  seen: {
    from: new Date("2026-11-10T09:00:00Z"),
    to: new Date("2026-11-10T09:00:00Z"),
  },
  crawl: { analyzedAt: new Date("2026-11-10T09:00:00Z"), note: null },
  unconfirmed: null,
};

const { default: SeoReportPage } = await import("./page");

async function show(role: Role, search: Record<string, unknown> = {}) {
  state.role = role;
  const el = await SeoReportPage({
    params: Promise.resolve({ orgSlug: "agency", websiteId: "w1" }),
    searchParams: Promise.resolve(search),
  } as never);
  return render(el);
}

beforeEach(() => {
  state.loadContentPlan.mockReset();
  state.loadContentPlan.mockResolvedValue(PLAN);
});
afterEach(cleanup);

const section11 = () =>
  screen.queryByRole("heading", { name: "11. Content plan" });

describe("client members", () => {
  test("see no content plan, no control and no team notes, even with the include parameter", async () => {
    for (const search of [{}, { content: "include" }]) {
      await show("CLIENT", search);
      expect(section11()).toBeNull();
      expect(
        screen.queryByRole("navigation", { name: /content plan/i }),
      ).toBeNull();
      expect(screen.queryByTestId("content-plan-team-notes")).toBeNull();
      expect(screen.queryByText(/Describe Funeral flowers/)).toBeNull();
      expect(screen.queryByText(/Review the content plan/)).toBeNull();
      cleanup();
    }
    expect(state.loadContentPlan).not.toHaveBeenCalled();
  });
});

describe("team members", () => {
  test("by default the plan is not in the report: a team-only control and a review panel that is never printed", async () => {
    const { container } = await show("MEMBER");
    expect(state.loadContentPlan).toHaveBeenCalledTimes(1);
    expect(section11()).toBeNull();
    const control = screen.getByRole("navigation", {
      name: "Content plan in this report (team only)",
    });
    expect(
      within(control)
        .getByRole("link", { name: "Not included" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(control)
        .getByRole("link", { name: "Included" })
        .getAttribute("href"),
    ).toBe("/o/agency/websites/w1/report?period=28d&content=include");
    const review = screen
      .getByText(/Review the content plan/)
      .closest("details")!;
    expect(review.className).toContain("print:hidden");
    expect(
      within(review).getByText("1. Describe Funeral flowers on its page"),
    ).toBeTruthy();
    // Section 10 keeps listing content work while the plan is not included.
    expect(
      screen.getByText(/Service page does not describe the service/),
    ).toBeTruthy();
    // Everything team-only sits outside the printed article.
    const notes = screen.getByTestId("content-plan-team-notes");
    expect(notes.closest(".print\\:hidden")).not.toBeNull();
    expect(within(notes).getByText(/Wedding flowers: Too old\./)).toBeTruthy();
    expect(
      within(notes).getByText(/1 item whose task the team dismissed/),
    ).toBeTruthy();
    expect(container.querySelector("article")!.textContent).not.toContain(
      "Left out of the plan",
    );
  });

  test("included: the plan is section 11 of the report, without duplicating content tasks in section 10", async () => {
    await show("OWNER", { content: "include", period: "7d" });
    const heading = section11();
    expect(heading).not.toBeNull();
    const section = heading!.closest("section")!;
    expect(section.className).not.toContain("print:hidden");
    // Longer than a page: not forced onto a new page, but its heading stays
    // with its content (browser print check, 13 Nov).
    expect(section.className).not.toContain("print:break-inside-avoid");
    expect(heading!.className).toContain("print:break-after-avoid");
    expect(
      within(section).getByText("1. Describe Funeral flowers on its page"),
    ).toBeTruthy();
    expect(within(section).getByText("Do first")).toBeTruthy();
    expect(
      within(section).getByText("https://bloom.example/funeral-flowers"),
    ).toBeTruthy();
    // No rule codes or team-only notes in the client-facing section.
    expect(section.textContent).not.toMatch(/CONTENT_|BIZ_|Left out|dismissed/);
    expect(screen.queryByText(/Review the content plan/)).toBeNull();
    // Section 10: the technical task stays, the content task moves to the plan.
    expect(screen.getByText("Fix missing titles")).toBeTruthy();
    expect(
      screen.queryByText(/Service page does not describe the service/),
    ).toBeNull();
    expect(screen.getByText(/listed in the content plan below/)).toBeTruthy();
    // The period tabs keep the choice; the control can switch it off again.
    expect(
      screen.getByRole("link", { name: "Last 28 days" }).getAttribute("href"),
    ).toBe("/o/agency/websites/w1/report?period=28d&content=include");
    expect(
      screen.getByRole("link", { name: "Not included" }).getAttribute("href"),
    ).toBe("/o/agency/websites/w1/report?period=7d");
  });

  test("an empty plan has no section in the report; the team is told why", async () => {
    state.loadContentPlan.mockResolvedValue({
      ...PLAN,
      groups: [],
      newPages: [],
      total: 0,
      pagesToChange: 0,
      seen: null,
      heldBack: [],
      dismissed: 0,
    });
    await show("MEMBER", { content: "include" });
    expect(section11()).toBeNull();
    expect(screen.queryByTestId("content-plan-picker")).toBeNull();
    expect(screen.getByText(/no content actions to share/)).toBeTruthy();
  });
});

const pickerBoxes = () =>
  Object.fromEntries(
    within(screen.getByTestId("content-plan-picker"))
      .getAllByRole("checkbox")
      .map((b) => [
        (b as HTMLInputElement).value,
        (b as HTMLInputElement).checked,
      ]),
  );
const s11 = () => section11()!.closest("section")!;

describe("choosing actions for the report (team)", () => {
  test("included by default: every item selected, the picker says so, all of them in section 11", async () => {
    await show("MEMBER", { content: "include" });
    expect(screen.getByTestId("selection-count").textContent).toBe(
      "(3 of 3 selected)",
    );
    expect(pickerBoxes()).toEqual({
      aaaaaaaaaa: true,
      bbbbbbbbbb: true,
      cccccccccc: true,
    });
    const sec = s11();
    expect(
      within(sec).getByText("1. Describe Funeral flowers on its page"),
    ).toBeTruthy();
    expect(
      within(sec).getByText("2. Link to the Wedding flowers page"),
    ).toBeTruthy();
    expect(within(sec).getByText("Add a page for “Cottages”")).toBeTruthy();
    // The picker is never printed and sits outside the report itself.
    const picker = screen.getByTestId("content-plan-picker");
    expect(picker.closest(".print\\:hidden")).not.toBeNull();
    expect(picker.closest("article")).toBeNull();
  });

  test("one item selected: only it is in section 11, renumbered; links keep the selection", async () => {
    await show("MEMBER", {
      content: "include",
      period: "7d",
      sel: "1",
      pick: "bbbbbbbbbb",
    });
    expect(screen.getByTestId("selection-count").textContent).toBe(
      "(1 of 3 selected)",
    );
    expect(pickerBoxes()).toEqual({
      aaaaaaaaaa: false,
      bbbbbbbbbb: true,
      cccccccccc: false,
    });
    const sec = s11();
    expect(
      within(sec).getByText("1. Link to the Wedding flowers page"),
    ).toBeTruthy();
    expect(sec.textContent).not.toMatch(
      /Funeral flowers|Cottages|New pages in the plan/,
    );
    expect(within(sec).getByText(/^1 action on 1 page/)).toBeTruthy();
    expect(
      screen.getByText(/included in this report with 1 of 3 items/),
    ).toBeTruthy();
    const href = (name: string) =>
      screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Last 28 days")).toBe(
      "/o/agency/websites/w1/report?period=28d&content=include&sel=1&pick=bbbbbbbbbb",
    );
    expect(href("Not included")).toBe(
      "/o/agency/websites/w1/report?period=7d&sel=1&pick=bbbbbbbbbb",
    );
    expect(href("Select all")).toBe(
      "/o/agency/websites/w1/report?period=7d&content=include",
    );
    expect(href("Clear all")).toBe(
      "/o/agency/websites/w1/report?period=7d&content=include&sel=1",
    );
  });

  test("a new page alone can be shared", async () => {
    await show("MEMBER", {
      content: "include",
      sel: "1",
      pick: ["cccccccccc"],
    });
    const sec = s11();
    expect(within(sec).getByText("Add a page for “Cottages”")).toBeTruthy();
    expect(within(sec).queryAllByTestId("content-action")).toEqual([]);
  });

  test("clear all: no section 11, content tasks stay in section 10, the team is told", async () => {
    await show("MEMBER", { content: "include", sel: "1" });
    expect(section11()).toBeNull();
    expect(screen.getByTestId("selection-count").textContent).toBe(
      "(0 of 3 selected)",
    );
    expect(screen.getByText(/No items are selected/)).toBeTruthy();
    expect(screen.queryByText(/listed in the content plan below/)).toBeNull();
    expect(
      screen.getByText(/Service page does not describe the service/),
    ).toBeTruthy();
  });

  test("ids that are malformed, unknown or from another website are ignored", async () => {
    await show("MEMBER", {
      content: "include",
      sel: "1",
      pick: ["aaaaaaaaaa", "dddddddddd", "<script>", "AAAAAAAAAA"],
    });
    expect(pickerBoxes()).toEqual({
      aaaaaaaaaa: true,
      bbbbbbbbbb: false,
      cccccccccc: false,
    });
    expect(screen.getByTestId("selection-stale").textContent).toMatch(
      /^1 earlier selection/,
    );
    expect(s11().textContent).not.toMatch(/Wedding|Cottages|script/);
  });

  test("not included: the selection is kept for later but nothing is in the report", async () => {
    await show("MEMBER", { sel: "1", pick: "bbbbbbbbbb" });
    expect(section11()).toBeNull();
    expect(screen.queryByTestId("content-plan-picker")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Included" }).getAttribute("href"),
    ).toBe(
      "/o/agency/websites/w1/report?period=28d&content=include&sel=1&pick=bbbbbbbbbb",
    );
  });
});

describe("client members with selection parameters", () => {
  test("nothing changes: no plan, no picker, no counts, and the plan is never loaded", async () => {
    for (const search of [
      { sel: "1", pick: "aaaaaaaaaa" },
      { content: "include", sel: "1", pick: ["aaaaaaaaaa", "bbbbbbbbbb"] },
      { content: "include", sel: "1" },
    ]) {
      const { container } = await show("CLIENT", search);
      expect(section11()).toBeNull();
      expect(screen.queryByTestId("content-plan-picker")).toBeNull();
      expect(screen.queryByTestId("content-plan-team-notes")).toBeNull();
      expect(container.textContent).not.toMatch(
        /selected|Funeral|Wedding flowers|Cottages/,
      );
      // Section 10 is the client's usual one (the report loader's filter).
      expect(screen.getByText("Fix missing titles")).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Last 7 days" }).getAttribute("href"),
      ).toBe("/o/agency/websites/w1/report?period=7d");
      cleanup();
    }
    expect(state.loadContentPlan).not.toHaveBeenCalled();
  });
});

const CLIENT_RULES = {
  AND: [
    { NOT: { title: { contains: "(BIZ_" } } },
    { NOT: { title: { contains: "(CONTENT_" } } },
  ],
};
const lastLoad = () => state.loadReportArgs[state.loadReportArgs.length - 1];
const TEAM_ONLY = [
  "content-plan-team-notes",
  "content-plan-picker",
  "report-handoff",
] as const;

describe("client-ready handoff (team)", () => {
  beforeEach(() => {
    state.loadReportArgs = [];
    state.replace.mockReset();
    state.evidence = {
      complete: { at: new Date("2026-11-10T09:00:00Z"), stale: false },
      laterIncomplete: null,
    };
  });

  test("review: the share panel states period and plan, and links to the client view, the PDF and a client link", async () => {
    await show("MEMBER", {
      content: "include",
      sel: "1",
      pick: ["aaaaaaaaaa", "cccccccccc"],
    });
    const panel = screen.getByTestId("report-handoff");
    expect(panel.closest(".print\\:hidden")).not.toBeNull();
    expect(panel.textContent).toMatch(/Period: 2026-10-16 to 2026-11-12/);
    expect(panel.textContent).toMatch(
      /Content plan: 1 action and 1 new page \(2 of 3 items selected\)/,
    );
    const href = (name: string) =>
      within(panel).getByRole("link", { name }).getAttribute("href");
    expect(href("Preview client view")).toBe(
      "/o/agency/websites/w1/report?period=28d&content=include&sel=1&pick=aaaaaaaaaa&pick=cccccccccc&through=2026-11-12&view=client",
    );
    expect(href("Save as PDF")).toBe(
      "/o/agency/websites/w1/report?period=28d&content=include&sel=1&pick=aaaaaaaaaa&pick=cccccccccc&through=2026-11-12&view=client&pdf=1",
    );
    expect(
      within(panel).getByRole("button", { name: "Copy client link" }),
    ).toBeTruthy();
    expect(panel.textContent).toMatch(/signs in with their own account/);
    expect(panel.textContent).toMatch(/only in the PDF, never behind the link/);
    // The review page reads tasks with the team's rules.
    expect(lastLoad()[6]).toEqual({});
  });

  test("the copied client link carries the period only", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await show("OWNER", { content: "include", sel: "1", pick: "aaaaaaaaaa" });
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("report-handoff")).getByRole("button", {
          name: "Copy client link",
        }),
      );
    });
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/o/agency/websites/w1/report?period=28d&through=2026-11-12`,
    );
  });

  test("client-ready view: client rules on the server, selected plan only, no team UI rendered at all", async () => {
    const { container } = await show("MEMBER", {
      content: "include",
      sel: "1",
      pick: "bbbbbbbbbb",
      through: "2026-11-12",
      view: "client",
    });
    // Tasks are loaded with the client's rules and the fixed period.
    expect(lastLoad()[6]).toEqual(CLIENT_RULES);
    expect(lastLoad()[7]).toEqual(new Date("2026-11-13T00:00:00Z"));
    // Team-only parts are not in the DOM (not merely hidden).
    for (const id of TEAM_ONLY) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.queryByText(/Review the content plan/)).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: /Content plan/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Report period" }),
    ).toBeNull();
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    // The bar says what this is and links back; it is never printed.
    const bar = screen.getByTestId("client-view-bar");
    expect(bar.className).toContain("print:hidden");
    expect(bar.textContent).toMatch(/with the content plan \(1 action\)/);
    expect(
      within(bar)
        .getByRole("link", { name: "Back to team review" })
        .getAttribute("href"),
    ).toBe(
      "/o/agency/websites/w1/report?period=28d&content=include&sel=1&pick=bbbbbbbbbb&through=2026-11-12",
    );
    // The report: section 11 with exactly the selected action, metadata says so.
    const sec = s11();
    expect(
      within(sec).getByText("1. Link to the Wedding flowers page"),
    ).toBeTruthy();
    expect(sec.textContent).not.toMatch(/Funeral|Cottages/);
    expect(container.querySelector("article")!.textContent).toMatch(
      /Content planIncluded: 1 action \(section 11\)/,
    );
    expect(container.querySelector("article")!.textContent).not.toMatch(
      /Team only|Left out|dismissed|selected for this report/,
    );
    expect(state.replace).not.toHaveBeenCalled();
  });

  test("client-ready view without the plan says so and has no section 11", async () => {
    await show("MEMBER", { view: "client" });
    expect(section11()).toBeNull();
    expect(screen.getByTestId("client-view-bar").textContent).toMatch(
      /without a content plan/,
    );
    expect(screen.queryByText(/Content planIncluded/)).toBeNull();
  });

  test("an invalid or future fixed period is ignored (rolling period)", async () => {
    for (const through of ["2099-01-01", "2026-02-30", "x"]) {
      state.loadReportArgs = [];
      await show("MEMBER", { through, view: "client" });
      expect(lastLoad()[7]).toBeUndefined();
      cleanup();
    }
  });
});

describe("client members and the handoff parameters", () => {
  beforeEach(() => {
    state.loadReportArgs = [];
  });

  test("view, pdf, plan and selection parameters change nothing: client rules, no plan, no team UI", async () => {
    for (const search of [
      { view: "client" },
      {
        view: "client",
        pdf: "1",
        content: "include",
        sel: "1",
        pick: "aaaaaaaaaa",
      },
      { through: "2026-11-12", content: "include" },
    ]) {
      const { container } = await show("CLIENT", search);
      for (const id of [...TEAM_ONLY, "client-view-bar"])
        expect(screen.queryByTestId(id)).toBeNull();
      expect(section11()).toBeNull();
      expect(container.textContent).not.toMatch(
        /Content plan|Funeral|Cottages/,
      );
      cleanup();
    }
    expect(state.loadContentPlan).not.toHaveBeenCalled();
  });

  test("a valid fixed period applies to clients too (the link they receive)", async () => {
    await show("CLIENT", { period: "28d", through: "2026-11-12" });
    expect(lastLoad()[7]).toEqual(new Date("2026-11-13T00:00:00Z"));
  });
});

describe("report metadata: evidence dates", () => {
  test("the latest complete crawl is named; stale and incomplete evidence is not presented as current", async () => {
    state.evidence = {
      complete: { at: new Date("2026-08-01T09:00:00Z"), stale: true },
      laterIncomplete: new Date("2026-11-12T09:00:00Z"),
    };
    await show("CLIENT");
    expect(screen.getByTestId("report-evidence").textContent).toBe(
      "Latest complete crawl 2026-08-01 (older than 60 days: the site may have changed since); a later crawl on 2026-11-12 did not complete and is not used.",
    );
    cleanup();
    state.evidence = { complete: null, laterIncomplete: null };
    await show("CLIENT");
    expect(screen.getByTestId("report-evidence").textContent).toBe(
      "No complete crawl yet.",
    );
  });
});

describe("print layout of the report header (browser check, 13 Nov)", () => {
  test("the metadata prints in three columns; evidence and plan rows span them", async () => {
    await show("MEMBER", { content: "include", view: "client" });
    const meta = screen.getByTestId("report-meta");
    expect(meta.className).toContain("print:grid-cols-3");
    expect(
      screen.getByTestId("report-evidence").parentElement!.className,
    ).toContain("print:col-span-3");
  });
});
