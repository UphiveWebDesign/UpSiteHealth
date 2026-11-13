// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
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
  loadReport: async () => ({
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
  }),
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
  ],
  newPages: [],
  heldBack: [{ label: "Wedding flowers", reason: "Too old." }],
  dismissed: 1,
  ignored: 0,
  total: 1,
  pagesToChange: 1,
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

  test("an empty plan says so plainly when included", async () => {
    state.loadContentPlan.mockResolvedValue({
      ...PLAN,
      groups: [],
      total: 0,
      pagesToChange: 0,
      heldBack: [],
      dismissed: 0,
    });
    await show("MEMBER", { content: "include" });
    const section = section11()!.closest("section")!;
    expect(within(section).getByTestId("content-plan-empty")).toBeTruthy();
  });
});
