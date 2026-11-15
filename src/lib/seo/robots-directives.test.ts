import { describe, expect, test } from "vitest";
import {
  headerNoindex,
  metaNoindex,
  noindexSource,
  parseXRobotsTag,
  responseHeadersStored,
  storedXRobotsTag,
} from "./robots-directives";
import { isNoindex } from "./rules";

describe("parseXRobotsTag", () => {
  test("directives without a user agent apply to everyone, lower-cased", () => {
    expect(parseXRobotsTag(["NoIndex, NOFOLLOW"])).toEqual([
      { agent: null, directive: "noindex" },
      { agent: null, directive: "nofollow" },
    ]);
  });

  test("a user-agent prefix scopes the rest of its own line only", () => {
    expect(
      parseXRobotsTag(["googlebot: noindex, nofollow", "noarchive"]),
    ).toEqual([
      { agent: "googlebot", directive: "noindex" },
      { agent: "googlebot", directive: "nofollow" },
      { agent: null, directive: "noarchive" },
    ]);
    expect(parseXRobotsTag(["googlebot: nofollow, bingbot: noindex"])).toEqual([
      { agent: "googlebot", directive: "nofollow" },
      { agent: "bingbot", directive: "noindex" },
    ]);
  });

  test("directives that take a value are not user agents", () => {
    expect(
      parseXRobotsTag([
        "max-snippet: 20, unavailable_after: 2026-12-01T00:00:00Z",
        "googlebot: max-image-preview: large",
      ]),
    ).toEqual([
      { agent: null, directive: "max-snippet: 20" },
      { agent: null, directive: "unavailable_after: 2026-12-01t00:00:00z" },
      { agent: "googlebot", directive: "max-image-preview: large" },
    ]);
  });

  test("missing, empty and blank headers parse to nothing", () => {
    expect(parseXRobotsTag(undefined)).toEqual([]);
    expect(parseXRobotsTag(null)).toEqual([]);
    expect(parseXRobotsTag(["", " , ", "googlebot:"])).toEqual([]);
  });
});

describe("headerNoindex", () => {
  test("noindex or none for all crawlers, Googlebot or Bingbot prohibits indexing", () => {
    expect(headerNoindex(["noindex"])).toEqual({
      noindex: true,
      agents: ["all"],
    });
    expect(headerNoindex(["NONE"])).toEqual({ noindex: true, agents: ["all"] });
    expect(headerNoindex(["GoogleBot: NoIndex"])).toEqual({
      noindex: true,
      agents: ["googlebot"],
    });
    expect(headerNoindex(["bingbot: none", "googlebot: noindex"])).toEqual({
      noindex: true,
      agents: ["bingbot", "googlebot"],
    });
    expect(headerNoindex(["googlebot: noindex", "noindex"]).agents).toEqual([
      "all",
    ]);
  });

  test("directives for other crawlers, or other directives, do not", () => {
    expect(headerNoindex(["otherbot: noindex"]).noindex).toBe(false);
    expect(headerNoindex(["nofollow, noarchive"]).noindex).toBe(false);
    expect(headerNoindex(["max-snippet: 0"]).noindex).toBe(false);
    expect(headerNoindex([]).noindex).toBe(false);
    expect(headerNoindex(undefined).noindex).toBe(false);
  });

  test("a generic noindex on a later line is not swallowed by an earlier prefix", () => {
    // Joined by Node into "otherbot: nofollow, noindex", this would read as
    // otherbot only; stored line by line, the generic noindex counts.
    expect(headerNoindex(["otherbot: nofollow", "noindex"])).toEqual({
      noindex: true,
      agents: ["all"],
    });
  });
});

describe("metaNoindex", () => {
  test("noindex or none in the robots meta tag, any case or separator", () => {
    expect(metaNoindex("noindex, follow")).toBe(true);
    expect(metaNoindex("NOINDEX")).toBe(true);
    expect(metaNoindex("none")).toBe(true);
    expect(metaNoindex("nofollow, NONE")).toBe(true);
    // As before: noindex counts even in a malformed value.
    expect(metaNoindex("noindex;nofollow")).toBe(true);
    expect(metaNoindex("nonexistent")).toBe(false);
    expect(metaNoindex("index,follow")).toBe(false);
    expect(metaNoindex("")).toBe(false);
    expect(metaNoindex(null)).toBe(false);
  });
});

describe("noindexSource and isNoindex", () => {
  const page = (
    robotsMetaRaw: string | null,
    xRobotsTag?: string[] | null,
  ) => ({
    robotsMetaRaw,
    xRobotsTag,
  });

  test("header only, meta only, both, neither", () => {
    expect(noindexSource(page("index, follow", ["noindex"]))).toEqual({
      source: "header",
      headerAgents: ["all"],
    });
    expect(noindexSource(page("noindex", []))).toEqual({
      source: "meta",
      headerAgents: [],
    });
    expect(noindexSource(page("noindex", ["googlebot: noindex"]))).toEqual({
      source: "both",
      headerAgents: ["googlebot"],
    });
    expect(noindexSource(page("index", ["nofollow"]))).toBeNull();
    expect(noindexSource(page(null, null))).toBeNull();
  });

  test("isNoindex reads the header from a stored crawl result when not given", () => {
    const result = { responseHeaders: { xRobotsTag: ["noindex"] } };
    expect(isNoindex({ robotsMetaRaw: null, result })).toBe(true);
    expect(isNoindex({ robotsMetaRaw: null, result: {} })).toBe(false);
    expect(isNoindex({ robotsMetaRaw: "noindex" })).toBe(true);
    // An explicit (empty) header list wins over the stored result.
    expect(isNoindex({ robotsMetaRaw: null, xRobotsTag: [], result })).toBe(
      false,
    );
  });

  test("stored header evidence: recorded (possibly empty) or not recorded", () => {
    expect(storedXRobotsTag({ responseHeaders: { xRobotsTag: [] } })).toEqual(
      [],
    );
    expect(responseHeadersStored({ responseHeaders: { xRobotsTag: [] } })).toBe(
      true,
    );
    // Crawls stored before headers were recorded: unknown, not "absent".
    expect(storedXRobotsTag({ links: [] })).toBeNull();
    expect(responseHeadersStored({ links: [] })).toBe(false);
    expect(responseHeadersStored(null)).toBe(false);
    expect(
      storedXRobotsTag({ responseHeaders: { xRobotsTag: ["a", 3, null] } }),
    ).toEqual(["a"]);
  });
});
