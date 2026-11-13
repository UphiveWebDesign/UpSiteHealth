import { describe, expect, test, vi } from "vitest";
import type { Role } from "@/generated/prisma/enums";
import type { Fact } from "@/lib/business/facts";
import { findingVisibility } from "@/lib/business/visibility";
import { CONTENT_RULE_IDS } from "@/lib/knowledge/catalogue";
import {
  CONTENT_GAP_RULE,
  LINK_RULE,
  NOT_DESCRIBED_RULE,
} from "@/lib/seo/content";
import {
  buildContentPlan,
  applySelection,
  includeParam,
  parseSelection,
  reportContentPlan,
  reportQuery,
  selectionId,
  type ContentPlan,
  type ContentPlanInput,
  type PlanFinding,
} from "./content-plan";

const NOW = new Date("2026-11-13T12:00:00Z");
const CRAWL = new Date("2026-11-10T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const fact = (
  id: string,
  kind: Fact["kind"],
  value: string,
  over: Partial<Fact> = {},
): Fact => ({
  id,
  kind,
  value,
  synonyms: [],
  source: "CLIENT",
  status: "APPROVED",
  ...over,
});
const WEDDING = fact("f-wed", "SERVICE", "Wedding flowers");
const FUNERAL = fact("f-fun", "SERVICE", "Funeral flowers");
const LEEDS = fact("f-leeds", "LOCATION", "Leeds");
const YORK = fact("f-york", "LOCATION", "York");
const ref = (f: Fact) => ({
  id: f.id,
  kind: f.kind,
  value: f.value,
  source: f.source,
});

const describeFinding = (over: Partial<PlanFinding> = {}): PlanFinding => ({
  ruleId: NOT_DESCRIBED_RULE,
  fingerprint: `${NOT_DESCRIBED_RULE}::site:funeral flowers`,
  lastSeenAt: CRAWL,
  evidence: {
    topic: "funeral flowers",
    label: "Funeral flowers",
    service: "Funeral flowers",
    facts: [ref(FUNERAL)],
    url: "https://bloom.example/funeral-flowers",
    where: ["title", "main heading"],
    mainWords: 400,
  },
  ...over,
});
const linkFinding = (over: Record<string, unknown> = {}): PlanFinding => ({
  ruleId: LINK_RULE,
  fingerprint: `${LINK_RULE}::site:wedding flowers`,
  lastSeenAt: CRAWL,
  evidence: {
    topic: "wedding flowers",
    label: "Wedding flowers",
    service: "Wedding flowers",
    facts: [ref(WEDDING)],
    target: "https://bloom.example/wedding-flowers",
    sources: [
      {
        url: "https://bloom.example/",
        passage: "We arrange wedding flowers for every occasion.",
      },
    ],
    sourcesTotal: 1,
    inboundPages: 0,
    poorlyConnected: true,
    ...over,
  },
});
const mentionFinding = (place: Fact, page: string): PlanFinding => ({
  ruleId: CONTENT_GAP_RULE,
  fingerprint: `${CONTENT_GAP_RULE}::site:wedding flowers|${place.value.toLowerCase()}`,
  lastSeenAt: CRAWL,
  evidence: {
    topic: `wedding flowers|${place.value.toLowerCase()}`,
    label: `Wedding flowers in ${place.value}`,
    service: "Wedding flowers",
    location: place.value,
    facts: [ref(WEDDING), ref(place)],
    servicePage: "https://bloom.example/wedding-flowers",
    locationPages: [page],
  },
});

const input = (over: Partial<ContentPlanInput> = {}): ContentPlanInput => ({
  findings: [],
  ignored: 0,
  facts: [WEDDING, FUNERAL, LEEDS, YORK],
  tasks: [],
  latestCrawl: { analyzedAt: CRAWL, status: "COMPLETED" },
  now: NOW,
  ...over,
});
const ready = (p: ContentPlan) => {
  if (p.state !== "ready") throw new Error("plan not ready");
  return p;
};
const actions = (p: ContentPlan) => ready(p).groups.flatMap((g) => g.actions);

describe("actions from stored content findings", () => {
  test("a service page that does not describe its service: one high-priority action naming the page", () => {
    const p = ready(buildContentPlan(input({ findings: [describeFinding()] })));
    expect(p.total).toBe(1);
    expect(p.pagesToChange).toBe(1);
    const [a] = actions(p);
    expect(a).toMatchObject({
      kind: "describe",
      title: "Describe Funeral flowers on its page",
      pages: ["https://bloom.example/funeral-flowers"],
      priority: "high",
      progress: "to-do",
      confirm: null,
      seenAt: CRAWL,
      notRecheckedSince: null,
    });
    expect(a.why).toContain("in its title and main heading");
    expect(a.why).toContain("(400 words)");
    expect(a.doneWhen).toMatch(/next complete crawl/);
    expect(a.facts).toEqual(["“Funeral flowers” (from the client)"]);
  });

  test("an internal-link opportunity names the target, the pages to change and where they mention it", () => {
    const [a] = actions(buildContentPlan(input({ findings: [linkFinding()] })));
    expect(a).toMatchObject({
      kind: "link",
      title: "Link to the Wedding flowers page",
      target: "https://bloom.example/wedding-flowers",
      pages: ["https://bloom.example/"],
      passages: [
        {
          url: "https://bloom.example/",
          passage: "We arrange wedding flowers for every occasion.",
        },
      ],
      priority: "high",
    });
    expect(a.why).toContain("no other page links to");
  });

  test("a reachable target is normal priority; pages beyond those listed are counted", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      url: `https://bloom.example/p${i}`,
      passage: "wedding flowers",
    }));
    const [a] = actions(
      buildContentPlan(
        input({
          findings: [
            linkFinding({
              sources,
              sourcesTotal: 8,
              inboundPages: 3,
              poorlyConnected: false,
            }),
          ],
        }),
      ),
    );
    expect(a.priority).toBe("normal");
    expect(a.pages).toHaveLength(5);
    expect(a.morePages).toBe(3);
    expect(a.why).toMatch(/^8 pages already mention/);
  });

  test("one service missing from several locations is one action, and always asks for the client's confirmation", () => {
    const p = ready(
      buildContentPlan(
        input({
          findings: [
            mentionFinding(LEEDS, "https://bloom.example/leeds"),
            mentionFinding(YORK, "https://bloom.example/york"),
          ],
        }),
      ),
    );
    expect(p.total).toBe(1);
    const [a] = actions(p);
    expect(a.title).toBe("Say where Wedding flowers is offered");
    expect(a.why).toBe(
      "No page says Wedding flowers is available in Leeds and York.",
    );
    expect(a.pages).toEqual([
      "https://bloom.example/leeds",
      "https://bloom.example/york",
    ]);
    expect(a.confirm).toMatch(/confirm Leeds and York with the client/);
    expect(a.priority).toBe("normal");
    expect(new Set(a.facts).size).toBe(a.facts.length);
  });

  test("groups follow a fixed order with the highest priority first", () => {
    const p = ready(
      buildContentPlan(
        input({
          findings: [
            mentionFinding(LEEDS, "https://bloom.example/leeds"),
            linkFinding(),
            describeFinding(),
          ],
        }),
      ),
    );
    expect(p.groups.map((g) => g.kind)).toEqual([
      "describe",
      "link",
      "mention",
    ]);
  });

  test("the same finding twice is listed once", () => {
    const p = ready(
      buildContentPlan(
        input({ findings: [describeFinding(), describeFinding()] }),
      ),
    );
    expect(p.total).toBe(1);
  });

  test("facts the client has not confirmed are named, per action and for the plan", () => {
    const team = { ...FUNERAL, source: "TEAM" as const };
    const p = ready(
      buildContentPlan(
        input({ findings: [describeFinding()], facts: [WEDDING, team] }),
      ),
    );
    expect(actions(p)[0].confirm).toMatch(
      /Confirm “Funeral flowers” with the client/,
    );
    expect(p.unconfirmed).toMatch(/“Funeral flowers”/);
  });
});

describe("uncertain or missing evidence is never presented as a problem", () => {
  test("evidence older than the crawl limit is left out and listed for the team", () => {
    const old = new Date(NOW.getTime() - 61 * DAY);
    const p = ready(
      buildContentPlan(
        input({ findings: [describeFinding({ lastSeenAt: old })] }),
      ),
    );
    expect(p.total).toBe(0);
    expect(p.heldBack).toEqual([
      {
        label: "Funeral flowers",
        reason: expect.stringMatching(/61 days ago: too old/),
      },
    ]);
  });

  test("a fact rejected, deleted or pending since the crawl leaves the action out", () => {
    for (const facts of [
      [WEDDING, { ...FUNERAL, status: "REJECTED" as const }],
      [WEDDING, { ...FUNERAL, status: "PENDING" as const }],
      [WEDDING],
    ]) {
      const p = ready(
        buildContentPlan(input({ findings: [describeFinding()], facts })),
      );
      expect(p.total).toBe(0);
      expect(p.heldBack[0].reason).toMatch(/changed, rejected or deleted/);
    }
  });

  test("evidence without the page, the target or its facts is left out, never filled in", () => {
    const cases: PlanFinding[] = [
      describeFinding({
        evidence: { service: "Funeral flowers", facts: [ref(FUNERAL)] },
      }),
      linkFinding({ target: undefined }),
      linkFinding({ sources: [] }),
      describeFinding({
        evidence: {
          service: "Funeral flowers",
          url: "https://bloom.example/funeral-flowers",
        },
      }),
    ];
    for (const f of cases) {
      const p = ready(buildContentPlan(input({ findings: [f] })));
      expect(p.total).toBe(0);
      expect(p.heldBack).toHaveLength(1);
      expect(p.heldBack[0].reason).toMatch(/does not name/);
    }
  });

  test("an incomplete latest crawl is flagged on the plan and on each action it did not recheck", () => {
    const later = new Date("2026-11-12T09:00:00Z");
    const p = ready(
      buildContentPlan(
        input({
          findings: [describeFinding()],
          latestCrawl: { analyzedAt: later, status: "PARTIAL" },
        }),
      ),
    );
    expect(p.crawl?.note).toMatch(/did not complete/);
    expect(actions(p)[0].notRecheckedSince).toEqual(later);
    // The plan says which complete crawl the actions come from, not the
    // incomplete one (browser check, 13 Nov).
    expect(p.seen).toEqual({ from: CRAWL, to: CRAWL });
    expect(p.crawl?.analyzedAt).toEqual(later);
  });

  test("actions seen in different complete crawls give a date range", () => {
    const earlier = new Date("2026-11-01T09:00:00Z");
    const p = ready(
      buildContentPlan(
        input({
          findings: [describeFinding({ lastSeenAt: earlier }), linkFinding()],
        }),
      ),
    );
    expect(p.seen).toEqual({ from: earlier, to: CRAWL });
    expect(ready(buildContentPlan(input())).seen).toBeNull();
  });

  test("a latest crawl older than the limit is flagged", () => {
    const p = ready(
      buildContentPlan(
        input({
          latestCrawl: {
            analyzedAt: new Date(NOW.getTime() - 70 * DAY),
            status: "COMPLETED",
          },
        }),
      ),
    );
    expect(p.crawl?.note).toMatch(/70 days old/);
  });

  test("no facts table: the plan says it is unavailable", () => {
    expect(buildContentPlan(input({ facts: null }))).toEqual({
      state: "unavailable",
      reason: expect.stringMatching(/not available/),
    });
  });

  test("nothing open: an empty plan, nothing held back", () => {
    const p = ready(buildContentPlan(input()));
    expect(p).toMatchObject({
      total: 0,
      groups: [],
      newPages: [],
      heldBack: [],
      pagesToChange: 0,
      crawl: { analyzedAt: CRAWL, note: null },
    });
  });

  test("findings of other rules are ignored", () => {
    const p = ready(
      buildContentPlan(
        input({
          findings: [{ ...describeFinding(), ruleId: "TECH_THIN_CONTENT" }],
        }),
      ),
    );
    expect(p.total).toBe(0);
    expect(p.heldBack).toEqual([]);
  });
});

describe("the team's decisions in the SEO plan", () => {
  const task = (
    rule: string,
    status: ContentPlanInput["tasks"][0]["status"],
  ) => ({
    title: `Some title (${rule})`,
    status,
  });

  test("a dismissed content task leaves its items out and counts them for the team", () => {
    const p = ready(
      buildContentPlan(
        input({
          findings: [describeFinding(), linkFinding()],
          tasks: [task(NOT_DESCRIBED_RULE, "DISMISSED")],
        }),
      ),
    );
    expect(p.dismissed).toBe(1);
    expect(actions(p).map((a) => a.kind)).toEqual(["link"]);
  });

  test("progress follows the task: in progress, or done and waiting for the crawl", () => {
    const p = ready(
      buildContentPlan(
        input({
          findings: [describeFinding(), linkFinding()],
          tasks: [
            task(NOT_DESCRIBED_RULE, "IN_PROGRESS"),
            task(LINK_RULE, "COMPLETED"),
          ],
        }),
      ),
    );
    const by = Object.fromEntries(actions(p).map((a) => [a.kind, a.progress]));
    expect(by).toEqual({ describe: "in-progress", link: "awaiting-check" });
  });

  test("new pages in the plan: open BIZ_ tasks only, without their codes", () => {
    const p = ready(
      buildContentPlan(
        input({
          tasks: [
            {
              title: "Add a page for “Cottages” (BIZ_SERVICE_PAGE)",
              status: "PROPOSED",
            },
            {
              title: "Add a page for “Leeds” (BIZ_LOCATION_PAGE)",
              status: "IN_PROGRESS",
            },
            {
              title: "Add a page for “Barns” (BIZ_SERVICE_PAGE)",
              status: "DISMISSED",
            },
            {
              title: "Add a page for “Lofts” (BIZ_SERVICE_PAGE)",
              status: "COMPLETED",
            },
          ],
        }),
      ),
    );
    expect(p.newPages).toMatchObject([
      { title: "Add a page for “Cottages”", progress: "to-do" },
      { title: "Add a page for “Leeds”", progress: "in-progress" },
    ]);
  });

  test("ignored content findings are counted for the team only", () => {
    expect(ready(buildContentPlan(input({ ignored: 2 }))).ignored).toBe(2);
  });
});

describe("team-only access, decided on the server", () => {
  const TEAM: Role[] = ["OWNER", "ADMIN", "MANAGER", "MEMBER"];

  const SITE = "site-a";
  const withActions = () =>
    buildContentPlan(
      input({ findings: [describeFinding(), linkFinding()], websiteId: SITE }),
    );

  test("client members get nothing, and neither the plan nor the selection is read for them, whatever the URL says", async () => {
    const id = selectionId(SITE, describeFinding().fingerprint);
    for (const params of [
      {},
      { content: "include" },
      { content: ["include"] },
      { content: "include", sel: "1", pick: id },
      { content: "include", sel: "1", pick: [id, "zzz"] },
    ]) {
      const load = vi.fn(async () => withActions());
      expect(await reportContentPlan("CLIENT", params, load)).toBeNull();
      expect(load).not.toHaveBeenCalled();
    }
  });

  test("the team always gets the plan for review; it is in the report only when asked", async () => {
    for (const role of TEAM) {
      const load = vi.fn(async () => withActions());
      expect(await reportContentPlan(role, {}, load)).toMatchObject({
        requested: false,
        included: false,
        selection: { explicit: false, available: 2, selected: 2 },
      });
      expect(
        await reportContentPlan(role, { content: "include" }, load),
      ).toMatchObject({
        requested: true,
        included: true,
        plan: { state: "ready", total: 2 },
        shown: { total: 2 },
      });
      expect(load).toHaveBeenCalledTimes(2);
    }
  });

  test("nothing to share or nothing selected: requested, but not in the report", async () => {
    const empty = await reportContentPlan(
      "MEMBER",
      { content: "include" },
      async () => buildContentPlan(input()),
    );
    expect(empty).toMatchObject({ requested: true, included: false });
    const none = await reportContentPlan(
      "MEMBER",
      { content: "include", sel: "1" },
      async () => withActions(),
    );
    expect(none).toMatchObject({
      requested: true,
      included: false,
      selection: { explicit: true, selected: 0, available: 2 },
      shown: { total: 0, groups: [] },
    });
  });

  test("only the exact value includes it", () => {
    expect(includeParam("include")).toBe(true);
    for (const v of [undefined, "", "1", "true", "INCLUDE", ["include"]])
      expect(includeParam(v)).toBe(false);
  });

  test("content findings are filtered out for client members only", () => {
    expect(findingVisibility("CLIENT")).toEqual({
      ruleId: { notIn: CONTENT_RULE_IDS },
    });
    for (const role of TEAM) expect(findingVisibility(role)).toEqual({});
    expect(CONTENT_RULE_IDS).toEqual(
      expect.arrayContaining([NOT_DESCRIBED_RULE, LINK_RULE, CONTENT_GAP_RULE]),
    );
  });
});

describe("choosing actions for a report", () => {
  const SITE = "site-a";
  const NEW_PAGE = {
    title: "Add a page for “Cottages” (BIZ_SERVICE_PAGE)",
    status: "PROPOSED" as const,
  };
  const full = (over: Partial<ContentPlanInput> = {}) =>
    ready(
      buildContentPlan(
        input({
          findings: [
            describeFinding(),
            linkFinding(),
            mentionFinding(LEEDS, "https://bloom.example/leeds"),
            mentionFinding(YORK, "https://bloom.example/york"),
          ],
          tasks: [NEW_PAGE],
          websiteId: SITE,
          ...over,
        }),
      ),
    );
  const ids = (p: ContentPlan) => [
    ...ready(p).groups.flatMap((g) => g.actions.map((a) => a.id)),
    ...ready(p).newPages.map((n) => n.id),
  ];

  test("every action and new page has a short id, stable across rebuilds", () => {
    const a = ids(full());
    expect(a).toHaveLength(4);
    for (const id of a) expect(id).toMatch(/^[0-9a-f]{10}$/);
    expect(new Set(a).size).toBe(4);
    expect(ids(full())).toEqual(a);
  });

  test("ids differ per website, so a selection copied to another website selects nothing", () => {
    const here = ids(full());
    const there = ids(full({ websiteId: "site-b" }));
    expect(there.some((id) => here.includes(id))).toBe(false);
    const { applied } = applySelection(full({ websiteId: "site-b" }), {
      explicit: true,
      ids: here,
    });
    expect(applied).toMatchObject({ selected: 0, stale: 4, available: 4 });
  });

  test("a location mention keeps its id when another location joins it", () => {
    const one = full({
      findings: [mentionFinding(LEEDS, "https://bloom.example/leeds")],
      tasks: [],
    });
    const two = full({ tasks: [] });
    const mention = (p: ContentPlan) =>
      ready(p).groups.find((g) => g.kind === "mention")!.actions[0].id;
    expect(mention(two)).toBe(mention(one));
  });

  test("default: no selection parameters select everything", () => {
    expect(parseSelection(undefined, undefined)).toEqual({ explicit: false });
    expect(parseSelection("0", "abc")).toEqual({ explicit: false });
    const p = full();
    const { shown, applied } = applySelection(p, { explicit: false });
    expect(applied).toMatchObject({
      explicit: false,
      selected: 4,
      available: 4,
      stale: 0,
    });
    expect(shown).toEqual(p);
  });

  test("selecting some: groups keep their order, empty groups disappear, counts and notes follow the selection", () => {
    const p = full();
    const [describe, link] = ready(p).groups.flatMap((g) => g.actions);
    const { shown, applied } = applySelection(p, {
      explicit: true,
      ids: [link.id],
    });
    const s = ready(shown);
    expect(s.groups.map((g) => g.kind)).toEqual(["link"]);
    expect(s.newPages).toEqual([]);
    expect(s).toMatchObject({ total: 1, pagesToChange: 1 });
    // Funeral flowers (team-entered) is no longer in the shown plan.
    expect(s.unconfirmed).toBeNull();
    expect(applied).toMatchObject({
      selected: 1,
      available: 4,
      ids: [link.id],
    });
    expect(applied.ids).not.toContain(describe.id);
  });

  test("clear all: nothing shown", () => {
    const { shown, applied } = applySelection(full(), {
      explicit: true,
      ids: [],
    });
    expect(ready(shown)).toMatchObject({
      groups: [],
      newPages: [],
      total: 0,
      seen: null,
    });
    expect(applied.selected).toBe(0);
  });

  test("new pages can be selected on their own", () => {
    const p = full();
    const page = ready(p).newPages[0];
    const { shown } = applySelection(p, { explicit: true, ids: [page.id] });
    expect(ready(shown)).toMatchObject({ total: 0, newPages: [page] });
  });

  test("an action found after the selection is not added; a resolved one is ignored and counted", () => {
    const before = full({ findings: [describeFinding()], tasks: [] });
    const chosen = ids(before);
    // Later: the describe finding was resolved and a link finding appeared.
    const after = full({ findings: [linkFinding()], tasks: [] });
    const { shown, applied } = applySelection(after, {
      explicit: true,
      ids: chosen,
    });
    expect(ready(shown).total).toBe(0);
    expect(applied).toMatchObject({ selected: 0, available: 1, stale: 1 });
  });

  test("URL values are validated: only well-formed ids, no duplicates, bounded", () => {
    const good = "0123456789";
    expect(
      parseSelection("1", [
        good,
        good,
        "XYZ",
        "0123",
        "../etc",
        7,
        "abcdefabcdef",
        "a".repeat(10),
      ]),
    ).toEqual({ explicit: true, ids: [good, "aaaaaaaaaa"] });
    expect(parseSelection("1", good)).toEqual({ explicit: true, ids: [good] });
    expect(parseSelection("1", undefined)).toEqual({ explicit: true, ids: [] });
    const many = Array.from({ length: 500 }, (_, i) =>
      i.toString(16).padStart(10, "0"),
    );
    expect((parseSelection("1", many) as { ids: string[] }).ids).toHaveLength(
      200,
    );
  });

  test("the report URL carries period, inclusion and selection", () => {
    expect(reportQuery("28d", false, { explicit: false, ids: [] })).toBe(
      "?period=28d",
    );
    expect(reportQuery("7d", true, { explicit: false, ids: [] })).toBe(
      "?period=7d&content=include",
    );
    expect(reportQuery("7d", true, { explicit: true, ids: [] })).toBe(
      "?period=7d&content=include&sel=1",
    );
    expect(
      reportQuery("28d", true, {
        explicit: true,
        ids: ["aaaaaaaaaa", "bbbbbbbbbb"],
      }),
    ).toBe("?period=28d&content=include&sel=1&pick=aaaaaaaaaa&pick=bbbbbbbbbb");
  });

  test("the URL round trip reproduces the same report", async () => {
    const p = full();
    const chosen = ids(p).slice(1, 3);
    const q = new URLSearchParams(
      reportQuery("28d", true, { explicit: true, ids: chosen }).slice(1),
    );
    const r = await reportContentPlan(
      "MEMBER",
      { content: q.get("content"), sel: q.get("sel"), pick: q.getAll("pick") },
      async () => p,
    );
    expect(r?.selection.ids).toEqual(chosen);
    expect(r?.included).toBe(true);
  });
});
