import { describe, expect, test } from "vitest";
import { analyzeCrawl, type StoredCrawlPage } from "./analyze";
import {
  classifyChanges,
  countChanges,
  type CrawlSide,
  type StoredFinding,
} from "./compare";
import type { RecheckRun } from "./recheck";

const HOST = "a.example";
const T1 = new Date("2026-10-01T00:00:00Z");
const T2 = new Date("2026-10-08T00:00:00Z");
const DESC = "A meta description that is long enough to pass the minimum.";
const done: RecheckRun = {
  status: "COMPLETED",
  robotsTxtStatus: "found",
  sitemapUrlsDiscovered: 3,
};

function page(path: string, o: Partial<StoredCrawlPage> = {}): StoredCrawlPage {
  return {
    id: path,
    url: `https://${HOST}${path}`,
    status: "CRAWLED",
    skipReason: null,
    resourceType: "HTML",
    httpStatus: 200,
    title: `A good title for ${path} page`,
    metaDescription: `${DESC} ${path}`,
    canonicalUrl: null,
    robotsMetaRaw: null,
    h1Count: 1,
    wordCount: 400,
    result: { images: [], structuredData: [] },
    ...o,
  };
}
const side = (
  analyzedAt: Date,
  pages: StoredCrawlPage[],
  run: RecheckRun = done,
): CrawlSide => ({ analyzedAt, run, ...analyzeCrawl(pages, run, HOST) });
const kinds = (items: ReturnType<typeof classifyChanges>) =>
  items.map((i) => [i.kind, i.ruleId, i.url?.replace(`https://${HOST}`, "")]);
// Unique short titles: TECH_TITLE_TOO_SHORT without a duplicate-title finding.
const short = (path: string) => ({ title: `Short ${path}` });
const stored = (
  fingerprint: string,
  o: Partial<StoredFinding> = {},
): [string, StoredFinding] => [
  fingerprint,
  { id: fingerprint, fingerprint, status: "OPEN", firstSeenAt: T1, ...o },
];
const fp = (path: string) => `TECH_TITLE_TOO_SHORT::https://${HOST}${path}`;

describe("classifyChanges", () => {
  test("new, unchanged and fixed", () => {
    const items = classifyChanges(
      side(T1, [page("/a", short("/a")), page("/b", short("/b"))]),
      side(T2, [page("/a", short("/a")), page("/b"), page("/c", short("/c"))]),
      new Map([stored(fp("/a")), stored(fp("/b"))]),
    );
    expect(kinds(items)).toEqual([
      ["new", "TECH_TITLE_TOO_SHORT", "/c"],
      ["fixed", "TECH_TITLE_TOO_SHORT", "/b"],
      ["unchanged", "TECH_TITLE_TOO_SHORT", "/a"],
    ]);
    expect(items.find((i) => i.kind === "fixed")?.findingId).toBe(fp("/b"));
  });

  test("an error page, a skipped page or missing data is not fixed", () => {
    const before = side(T1, [
      page("/err", short("/err")),
      page("/skip", short("/skip")),
      page("/img", {
        result: { images: [{ src: "x", alt: null }], structuredData: [] },
      }),
      page("/gone", short("/gone")),
    ]);
    const after = side(T2, [
      page("/err", { httpStatus: 503, result: null }),
      page("/skip", { status: "SKIPPED", skipReason: "BUDGET_EXCEEDED" }),
      page("/img", { result: {} }), // older crawl shape: no stored images
    ]);
    const items = classifyChanges(before, after, new Map());
    const notRechecked = items.filter((i) => i.kind === "not-rechecked");
    expect(
      notRechecked.map((i) => [
        i.url?.replace(`https://${HOST}`, ""),
        i.reason,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["/gone", "Not rechecked: the page was not crawled this time."],
        [
          "/skip",
          "Not rechecked: the page was skipped because the crawl reached its page limit.",
        ],
        [
          "/err",
          "Not rechecked: the page returned HTTP 503, so its content could not be checked.",
        ],
        [
          "/img",
          "Not rechecked: the crawl did not store the data this check needs.",
        ],
      ]),
    );
    expect(items.some((i) => i.kind === "fixed")).toBe(false);
    // The error itself is new.
    expect(kinds(items)[0]).toEqual(["new", "TECH_HTTP_ERROR", "/err"]);
  });

  test("site-wide findings need a completed crawl to be fixed", () => {
    const dup = { title: "The same title on two pages" };
    const before = side(T1, [page("/a", dup), page("/b", dup)]);
    const partial = side(T2, [page("/a"), page("/b")], {
      ...done,
      status: "PARTIAL",
    });
    expect(
      classifyChanges(before, partial, new Map()).map((i) => i.kind),
    ).toEqual(["not-rechecked"]);
    const complete = side(T2, [page("/a"), page("/b")]);
    expect(
      classifyChanges(before, complete, new Map()).map((i) => i.kind),
    ).toEqual(["fixed"]);
  });

  test("came back: seen before the previous crawl, absent in it, present now", () => {
    const items = classifyChanges(
      side(T2, [page("/a")]),
      side(new Date("2026-10-15T00:00:00Z"), [page("/a", short("/a"))]),
      new Map([stored(fp("/a"), { status: "OPEN", firstSeenAt: T1 })]),
    );
    expect(kinds(items)).toEqual([["came-back", "TECH_TITLE_TOO_SHORT", "/a"]]);
  });

  test("when the previous crawl could not check it, it is not called new or came back", () => {
    const prev = side(T2, [page("/a", { status: "SKIPPED" })]);
    const cur = side(new Date("2026-10-15T00:00:00Z"), [
      page("/a", short("/a")),
    ]);
    expect(
      classifyChanges(prev, cur, new Map([stored(fp("/a"))])).map((i) => [
        i.kind,
        i.previouslyUnchecked,
      ]),
    ).toEqual([["unchanged", true]]);
    expect(
      classifyChanges(prev, cur, new Map()).map((i) => [
        i.kind,
        i.previouslyUnchecked,
      ]),
    ).toEqual([["new", true]]);
  });

  test("ignored findings are never fixed, new or came back", () => {
    const ignored = new Map([stored(fp("/a"), { status: "IGNORED" })]);
    for (const [before, after] of [
      [[page("/a", short("/a"))], [page("/a")]], // gone
      [[page("/a")], [page("/a", short("/a"))]], // appeared
      [[page("/a", short("/a"))], [page("/a", short("/a"))]], // present in both
    ]) {
      expect(
        classifyChanges(side(T1, before), side(T2, after), ignored).map(
          (i) => i.kind,
        ),
      ).toEqual(["ignored"]);
    }
  });

  test("countChanges reports every category, including zeros", () => {
    expect(
      countChanges(
        classifyChanges(
          side(T1, [page("/a", short("/a"))]),
          side(T2, [page("/a")]),
          new Map(),
        ),
      ),
    ).toEqual({
      new: 0,
      "came-back": 0,
      fixed: 1,
      "not-rechecked": 0,
      unchanged: 0,
      ignored: 0,
    });
  });
});
