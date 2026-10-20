import { describe, expect, test } from "vitest";
import { PageSpeedError, parsePageSpeed, runPageSpeed } from "./pagespeed";

const fixture = {
  id: "https://example.com/",
  lighthouseResult: {
    finalUrl: "https://example.com/",
    lighthouseVersion: "13.4.1",
    categories: { performance: { score: 0.87 } },
    audits: {
      "largest-contentful-paint": { numericValue: 2345.6 },
      "cumulative-layout-shift": { numericValue: 0.04321 },
      "first-contentful-paint": { numericValue: 1200.2 },
      "server-response-time": { numericValue: 310.4 },
    },
  },
  loadingExperience: {
    metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 180 } },
  },
};

describe("parsePageSpeed", () => {
  test("maps Lighthouse audits to observation columns", () => {
    expect(parsePageSpeed(fixture, "MOBILE", "https://example.com")).toEqual({
      url: "https://example.com/",
      strategy: "MOBILE",
      sourceVersion: "13.4.1",
      performanceScore: 87,
      lcpMs: 2346,
      inpMs: 180,
      clsScore: 0.043,
      fcpMs: 1200,
      ttfbMs: 310,
    });
  });

  test("missing metrics become null", () => {
    const r = parsePageSpeed(
      {
        lighthouseResult: {
          categories: { performance: { score: null } },
          audits: {},
        },
      },
      "DESKTOP",
      "https://x.example",
    );
    expect(r).toMatchObject({
      performanceScore: null,
      lcpMs: null,
      inpMs: null,
      url: "https://x.example",
    });
  });

  test("a response without Lighthouse data is an error", () => {
    expect(() => parsePageSpeed({}, "MOBILE", "u")).toThrow(PageSpeedError);
  });
});

describe("runPageSpeed", () => {
  const respond = (status: number, body: unknown) =>
    (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      })) as typeof fetch;

  test("passes strategy, category and optional key", async () => {
    let requested = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify(fixture));
    }) as typeof fetch;
    await runPageSpeed("https://example.com", "DESKTOP", {
      apiKey: "k123",
      fetchImpl,
    });
    const u = new URL(requested);
    expect(u.searchParams.get("strategy")).toBe("desktop");
    expect(u.searchParams.get("category")).toBe("performance");
    expect(u.searchParams.get("key")).toBe("k123");
  });

  test.each([
    [429, "Rate limit exceeded", "RATE_LIMITED"],
    [429, "Quota exceeded for quota metric", "QUOTA_EXCEEDED"],
    [400, "bad url", "INVALID_URL"],
    [500, "oops", "UNAVAILABLE"],
  ])("HTTP %i (%s) → %s", async (status, body, code) => {
    await expect(
      runPageSpeed("https://example.com", "MOBILE", {
        fetchImpl: respond(status, body),
      }),
    ).rejects.toMatchObject({ code });
  });

  test("error messages never include the API key", async () => {
    const error = await runPageSpeed("https://example.com", "MOBILE", {
      apiKey: "secret-key-value",
      fetchImpl: respond(500, "boom"),
    }).catch((e) => e);
    expect(String(error.message)).not.toContain("secret-key-value");
  });
});
