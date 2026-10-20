import { describe, expect, test } from "vitest";
import { normalizeWebsiteUrl, WebsiteUrlError } from "@/lib/websites/url";
import type { CheckResult } from "./checks";
import { decideIssue, deriveWebsiteStatus } from "./rules";

describe("normalizeWebsiteUrl", () => {
  test.each([
    ["example.com", "https://example.com", "example.com"],
    ["HTTPS://Example.COM/", "https://example.com", "example.com"],
    [
      "http://shop.example.com/store?x=1#top",
      "http://shop.example.com/store?x=1",
      "shop.example.com",
    ],
    ["  www.example.org  ", "https://www.example.org", "www.example.org"],
  ])("%s → %s", (input, url, domain) => {
    expect(normalizeWebsiteUrl(input)).toEqual({ url, domain });
  });

  test.each([
    "",
    "ftp://example.com",
    "https://user:pw@example.com",
    "http://localhost:3000",
    "http://192.168.1.10",
    "http://169.254.169.254",
    "intranet",
  ])("rejects %j", (input) => {
    expect(() => normalizeWebsiteUrl(input)).toThrow(WebsiteUrlError);
  });
});

describe("deriveWebsiteStatus", () => {
  test("paused and unknown", () => {
    expect(deriveWebsiteStatus(false, { UPTIME: "HTTP_ERROR" })).toBe("PAUSED");
    expect(deriveWebsiteStatus(true, {})).toBe("UNKNOWN");
  });

  test("BLOCKED is inconclusive, as in production data", () => {
    expect(
      deriveWebsiteStatus(true, {
        UPTIME: "BLOCKED",
        SSL: "SUCCESS",
        DNS: "SUCCESS",
      }),
    ).toBe("HEALTHY");
  });

  test.each([
    [{ UPTIME: "TIMEOUT" }, "CRITICAL"],
    [{ UPTIME: "SUCCESS", SSL: "EXPIRED" }, "CRITICAL"],
    [{ UPTIME: "SUCCESS", DNS: "NXDOMAIN" }, "CRITICAL"],
    [{ UPTIME: "SUCCESS", SSL: "EXPIRING" }, "WARNING"],
    [{ UPTIME: "SUCCESS", DNS: "SERVFAIL" }, "WARNING"],
    [{ UPTIME: "SUCCESS", SSL: "SUCCESS", DNS: "SUCCESS" }, "HEALTHY"],
  ] as const)("%j → %s", (latest, status) => {
    expect(deriveWebsiteStatus(true, latest)).toBe(status);
  });
});

describe("decideIssue", () => {
  const r = (over: Partial<CheckResult>): CheckResult => ({
    type: "UPTIME",
    outcome: "SUCCESS",
    result: null,
    ...over,
  });

  test("uptime failures open a CRITICAL issue; success resolves it", () => {
    expect(decideIssue(r({ outcome: "CONNECTION_ERROR" }))).toMatchObject({
      action: "open",
      severity: "CRITICAL",
    });
    expect(decideIssue(r({ outcome: "SUCCESS" }))).toEqual({
      action: "resolve",
    });
    expect(decideIssue(r({ outcome: "BLOCKED" }))).toEqual({ action: "none" });
  });

  test("SSL expiry severities", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    const soon = new Date("2026-10-27T00:00:00Z");
    expect(
      decideIssue(
        r({ type: "SSL", outcome: "EXPIRING", sslExpiresAt: soon }),
        now,
      ),
    ).toEqual(
      expect.objectContaining({
        severity: "HIGH",
        title: "SSL certificate expires in 7 days",
      }),
    );
    expect(decideIssue(r({ type: "SSL", outcome: "EXPIRED" }))).toMatchObject({
      severity: "CRITICAL",
    });
    expect(decideIssue(r({ type: "SSL", outcome: "DNS_ERROR" }))).toEqual({
      action: "none",
    });
  });

  test("DNS outcomes", () => {
    expect(decideIssue(r({ type: "DNS", outcome: "NXDOMAIN" }))).toMatchObject({
      severity: "CRITICAL",
    });
    expect(decideIssue(r({ type: "DNS", outcome: "SERVFAIL" }))).toMatchObject({
      severity: "HIGH",
    });
    expect(decideIssue(r({ type: "DNS", outcome: "TIMEOUT" }))).toEqual({
      action: "none",
    });
  });
});
