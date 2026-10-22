// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { PageOpportunity } from "@/lib/business/opportunities";
import type { RecommendationMeta } from "@/lib/recommendations/metadata";
import { OpportunityCard } from "./opportunity-card";
import { ProposalBlock, WorkTypeBadge } from "./page-proposal";
import { RecommendationDetails } from "./recommendation-meta";

afterEach(cleanup);

const base: RecommendationMeta = {
  detected: "d",
  benefit: "search-appearance",
  confidence: "high",
  confidenceReason: "Measured.",
  effort: "small",
  effortReason: "Small.",
  priorityRationale: "Why.",
  evidence: [],
  urls: ["https://a.example/x", "https://a.example/y"],
  coverage: { affected: 2, analysed: 10 },
  likelyTemplate: false,
  verification: "Next crawl.",
  limits: [],
  knowledgeVersion: "k1",
};
const proposal = {
  name: "Accommodation: Cottages",
  slug: "/cottages/",
  topic: "Cottages in the Kasol area",
  intent: "People choosing and booking a place to stay.",
  outline: ["What the cottages offer."],
  goals: ["Bookings or appointments"],
};

describe("Recommendations page parity (audit M5)", () => {
  test("a technical fix lists its affected pages", () => {
    render(<RecommendationDetails meta={base} fallbackBenefit={null} />);
    expect(screen.getByText("Affected pages (2)")).toBeDefined();
    expect(screen.queryByText(/Pages considered/)).toBeNull();
  });

  test("a new page lists the pages considered, never “affected” ones", () => {
    const meta = { ...base, coverage: null, proposal, knowledgeVersion: "o2" };
    const { container } = render(
      <RecommendationDetails meta={meta} fallbackBenefit={null} />,
    );
    expect(screen.getByText("Pages considered (2)")).toBeDefined();
    expect(container.textContent).not.toMatch(/Affected pages/);
  });

  test("missing (legacy) metadata falls back honestly", () => {
    render(<RecommendationDetails meta={null} fallbackBenefit="Helps." />);
    expect(screen.getByText(/no longer current/)).toBeDefined();
  });

  test("work type and proposal are labelled the same everywhere", () => {
    render(
      <>
        <WorkTypeBadge type="new-page" />
        <WorkTypeBadge type="technical" />
        <ProposalBlock proposal={proposal} />
      </>,
    );
    expect(screen.getByText("New page")).toBeDefined();
    expect(screen.getByText("Technical fix")).toBeDefined();
    expect(screen.getByText("/cottages/")).toBeDefined();
    expect(screen.getByText("(a proposal)")).toBeDefined();
    expect(screen.getByText("Bookings or appointments")).toBeDefined();
  });
});

describe("Coverage shows the saved task, not the live calculation (audit M4)", () => {
  const o = (over: Partial<PageOpportunity> = {}): PageOpportunity =>
    ({
      key: "Add an accommodation page for “Cottages” (BIZ_ACCOMMODATION_PAGE)",
      category: "accommodation",
      name: "Accommodation: Cottages",
      state: "confirmed",
      stateReason: "No page.",
      why: "Why.",
      facts: [{ id: "f", kind: "SERVICE", value: "Cottages" }],
      goals: ["bookings"],
      considered: [],
      slug: "/cottages/",
      topic: "Cottages",
      intent: "Stay.",
      outline: ["A"],
      assumptions: ["B"],
      priority: "HIGH",
      priorityReason: "P.",
      confidence: "medium",
      confidenceReason: "C.",
      effort: "large",
      effortReason: "E.",
      verification: "V.",
      fulfilledBy: null,
      decision: null,
      recommend: true,
      ...over,
    }) as PageOpportunity;
  const card = (opp: PageOpportunity, task: { status: string } | null) =>
    render(
      <OpportunityCard
        o={opp}
        task={task}
        action={async () => undefined}
        planHref="/plan"
      />,
    );

  test("calculated but not saved: never claims to be in the plan", () => {
    const { container } = card(o(), null);
    expect(screen.getByText("Recommended · not in the plan yet")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Add to plan now" }),
    ).toBeDefined();
    expect(container.textContent).not.toMatch(/In the SEO plan/);
  });

  test("saved and open: in the plan, with a link", () => {
    card(o(), { status: "PROPOSED" });
    expect(screen.getByText("In the SEO plan")).toBeDefined();
    expect(
      screen.getByRole("link", { name: /See it in the SEO plan/ }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /Add to plan/ })).toBeNull();
  });

  test("dismissed: shows it and offers Restore; restored work shows as planned", () => {
    card(o({ recommend: false, decision: "dismissed" }), {
      status: "DISMISSED",
    });
    expect(screen.getByText("Dismissed")).toBeDefined();
    expect(screen.getByRole("button", { name: "Restore" })).toBeDefined();
    cleanup();
    card(o({ decision: "accepted" }), { status: "PROPOSED" });
    expect(screen.getByText("In the SEO plan")).toBeDefined();
  });

  test("done: no actions; review without a task: Accept", () => {
    const { container } = card(o({ recommend: false, decision: "accepted" }), {
      status: "COMPLETED",
    });
    expect(screen.getByText("Done")).toBeDefined();
    expect(container.querySelectorAll("button")).toHaveLength(0);
    cleanup();
    card(o({ state: "review", recommend: false }), null);
    expect(
      screen.getByRole("button", { name: "Accept and add to plan" }),
    ).toBeDefined();
    expect(screen.queryByText(/not in the plan yet/)).toBeNull();
  });
});

describe("refused decisions are shown, never silent (sprint 4)", () => {
  test("dismissing completed work shows the refusal next to the button", async () => {
    const o = {
      key: "Make it easy to get in touch (BIZ_CONTACT_PATH)",
      category: "contact",
      name: "Contact and booking",
      state: "confirmed",
      stateReason: "No contact page.",
      why: "Why.",
      facts: [],
      goals: ["calls"],
      considered: [],
      slug: "/contact/",
      topic: "Contact",
      intent: "Call.",
      outline: ["A"],
      assumptions: ["B"],
      priority: "MEDIUM",
      priorityReason: "P.",
      confidence: "medium",
      confidenceReason: "C.",
      effort: "medium",
      effortReason: "E.",
      verification: "V.",
      fulfilledBy: null,
      decision: "accepted",
      recommend: true,
    } as PageOpportunity;
    const calls: string[] = [];
    render(
      <OpportunityCard
        o={o}
        task={{ status: "PROPOSED" }}
        action={async (_prev, form) => {
          calls.push(String(form.get("decision")));
          return {
            error:
              "This task is already done. Completed work stays completed and cannot be dismissed.",
          };
        }}
        planHref="/plan"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /cannot be dismissed/,
      ),
    );
    expect(calls).toEqual(["dismiss"]);
  });
});
