import { describe, expect, test } from "vitest";
import { STORED_RESPONSE_HEADERS, storedResponseHeaders } from "./headers";

describe("storedResponseHeaders", () => {
  test("only allowlisted headers are kept: never cookies or credentials", () => {
    expect(STORED_RESPONSE_HEADERS).toEqual(["x-robots-tag"]);
    const stored = storedResponseHeaders({
      headers: {
        "set-cookie": ["session=secret"],
        authorization: "Bearer secret",
        "www-authenticate": "Basic",
        server: "nginx",
        "x-robots-tag": "noindex",
      },
    });
    expect(stored).toEqual({ xRobotsTag: ["noindex"] });
    expect(JSON.stringify(stored)).not.toMatch(/secret|nginx|Basic/);
  });

  test("separate header lines are preferred over Node's comma-joined value", () => {
    expect(
      storedResponseHeaders({
        headers: { "x-robots-tag": "otherbot: nofollow, noindex" },
        headersDistinct: { "x-robots-tag": ["otherbot: nofollow", "noindex"] },
      }),
    ).toEqual({ xRobotsTag: ["otherbot: nofollow", "noindex"] });
  });

  test("an absent header is recorded as an empty list", () => {
    expect(storedResponseHeaders({ headers: {} })).toEqual({ xRobotsTag: [] });
    expect(storedResponseHeaders({ headers: {}, headersDistinct: {} })).toEqual(
      { xRobotsTag: [] },
    );
  });

  test("values are trimmed and bounded", () => {
    const stored = storedResponseHeaders({
      headers: {},
      headersDistinct: {
        "x-robots-tag": [
          "  noindex  ",
          "",
          "x".repeat(2000),
          ...Array.from({ length: 20 }, (_, i) => `line-${i}`),
        ],
      },
    });
    expect(stored.xRobotsTag[0]).toBe("noindex");
    expect(stored.xRobotsTag[1]).toHaveLength(500);
    expect(stored.xRobotsTag).toHaveLength(10);
  });
});
