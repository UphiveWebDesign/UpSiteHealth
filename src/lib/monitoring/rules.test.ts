import { describe, expect, test } from "vitest";
import { normalizeWebsiteUrl, WebsiteUrlError } from "@/lib/websites/url";
import type { CheckResult } from "./checks";
import {
  confirmedUptimeOutcome,
  confirmIssueDecision,
  confirmsFailure,
  decideIssue,
  deriveWebsiteStatus,
  isUptimeDown,
  issueResolution,
  uptimeConfirmationWindowMs,
  UPTIME_FAILURES_TO_CONFIRM,
  type RecordedCheck,
} from "./rules";

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

describe("issueResolution", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 21, 12, m));
  test("open issues have no resolution", () => {
    expect(
      issueResolution(
        { status: "OPEN", resolvedAt: null, lastSeenAt: t(0) },
        t(5),
      ),
    ).toBeNull();
  });
  test("resolved by a passing check is verified", () => {
    expect(
      issueResolution(
        { status: "RESOLVED", resolvedAt: t(5), lastSeenAt: t(5) },
        null,
      ),
    ).toBe("verified");
  });
  test("resolved by hand stays unverified until a later check passes", () => {
    const manual = { status: "RESOLVED", resolvedAt: t(10), lastSeenAt: t(0) };
    expect(issueResolution(manual, null)).toBe("unverified");
    expect(issueResolution(manual, t(9))).toBe("unverified");
    expect(issueResolution(manual, t(15))).toBe("verified");
  });
});

describe("uptime confirmation (a second consecutive failure)", () => {
  const NOW = new Date("2026-11-15T12:00:00Z");
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
  // The default 5-minute interval and the queue's 3 × 2-minute leases.
  const WINDOW = uptimeConfirmationWindowMs(5, 3 * 2 * 60_000);
  const r = (over: Partial<CheckResult>): CheckResult => ({
    type: "UPTIME",
    outcome: "SUCCESS",
    result: null,
    ...over,
  });
  const prev = (outcome: CheckResult["outcome"], minutesAgo = 5) => ({
    outcome,
    at: ago(minutesAgo),
  });
  const confirm = (
    outcome: CheckResult["outcome"],
    previous: RecordedCheck | null,
    type: CheckResult["type"] = "UPTIME",
  ) => {
    const result = r({ type, outcome });
    return confirmIssueDecision(
      decideIssue(result),
      result,
      previous,
      NOW,
      WINDOW,
    );
  };

  test("two consecutive failures are required, within a window derived from the schedule", () => {
    expect(UPTIME_FAILURES_TO_CONFIRM).toBe(2);
    expect(WINDOW).toBe(16 * 60_000);
    expect(uptimeConfirmationWindowMs(60, 6 * 60_000)).toBe(126 * 60_000);
  });

  test("a first failure is pending: no issue yet, same text if confirmed", () => {
    for (const previous of [null, prev("SUCCESS"), prev("BLOCKED")]) {
      expect(confirm("TIMEOUT", previous)).toMatchObject({
        action: "pending",
        severity: "CRITICAL",
        title: "Website is unreachable",
      });
    }
  });

  test("a failure after a recent failure confirms the outage", () => {
    expect(confirm("TIMEOUT", prev("CONNECTION_ERROR"))).toMatchObject({
      action: "open",
      severity: "CRITICAL",
    });
    expect(confirm("HTTP_ERROR", prev("HTTP_ERROR", 1))).toMatchObject({
      action: "open",
    });
  });

  test("the window: at its edge a failure still confirms; just past it, or after a long gap, it does not", () => {
    expect(confirm("TIMEOUT", prev("TIMEOUT", 16)).action).toBe("open");
    expect(confirm("TIMEOUT", prev("TIMEOUT", 16.01)).action).toBe("pending");
    // Monitoring paused for three weeks while the site was down.
    expect(confirm("TIMEOUT", prev("TIMEOUT", 3 * 7 * 24 * 60)).action).toBe(
      "pending",
    );
    expect(confirmsFailure(prev("TIMEOUT", 10), NOW, WINDOW)).toBe(true);
    expect(confirmsFailure(prev("BLOCKED", 1), NOW, WINDOW)).toBe(false);
    expect(confirmsFailure(null, NOW, WINDOW)).toBe(false);
  });

  test("inconclusive outcomes neither confirm nor count as down", () => {
    // BLOCKED: bot protection or our address policy; UNKNOWN_ERROR: the
    // checker itself; INVALID_URL: configuration. None is an outage.
    for (const o of ["BLOCKED", "UNKNOWN_ERROR", "INVALID_URL"] as const) {
      expect(isUptimeDown(o)).toBe(false);
      expect(confirm(o, prev("TIMEOUT"))).toEqual({ action: "none" });
      expect(confirm("TIMEOUT", prev(o)).action).toBe("pending");
    }
  });

  test("success still resolves at once; other check types are unchanged", () => {
    expect(confirm("SUCCESS", prev("TIMEOUT"))).toEqual({ action: "resolve" });
    expect(confirm("EXPIRED", null, "SSL")).toMatchObject({
      action: "open",
      severity: "CRITICAL",
    });
    expect(confirm("NXDOMAIN", prev("SUCCESS"), "DNS")).toMatchObject({
      action: "open",
    });
  });

  test("website status uses the confirmed uptime outcome", () => {
    const latest = (outcome: CheckResult["outcome"]) => ({ outcome, at: NOW });
    const c = (
      l: CheckResult["outcome"],
      p: RecordedCheck | null | undefined,
    ) => confirmedUptimeOutcome(latest(l), p, WINDOW);
    // First failure: status stays where the previous check left it.
    expect(c("TIMEOUT", prev("SUCCESS"))).toBe("SUCCESS");
    expect(c("TIMEOUT", prev("BLOCKED"))).toBe("BLOCKED");
    expect(c("TIMEOUT", undefined)).toBeUndefined();
    // After a long gap an old failure is neither a confirmation nor a status.
    expect(c("TIMEOUT", prev("TIMEOUT", 600))).toBeUndefined();
    // Second recent failure: down.
    expect(c("TIMEOUT", prev("HTTP_ERROR"))).toBe("TIMEOUT");
    // Not a failure: as measured.
    expect(c("SUCCESS", prev("TIMEOUT"))).toBe("SUCCESS");
    expect(c("BLOCKED", prev("TIMEOUT"))).toBe("BLOCKED");
    expect(
      deriveWebsiteStatus(true, {
        UPTIME: c("TIMEOUT", prev("SUCCESS")),
        SSL: "SUCCESS",
        DNS: "SUCCESS",
      }),
    ).toBe("HEALTHY");
    expect(deriveWebsiteStatus(true, { UPTIME: c("TIMEOUT", undefined) })).toBe(
      "UNKNOWN",
    );
    expect(
      deriveWebsiteStatus(true, { UPTIME: c("TIMEOUT", prev("TIMEOUT")) }),
    ).toBe("CRITICAL");
  });

  test("an open confirmed incident keeps the site CRITICAL whatever an inconclusive check says", () => {
    const open = { uptimeIncidentOpen: true };
    for (const UPTIME of ["BLOCKED", "UNKNOWN_ERROR", "SUCCESS"] as const)
      expect(deriveWebsiteStatus(true, { UPTIME, SSL: "SUCCESS" }, open)).toBe(
        "CRITICAL",
      );
    expect(deriveWebsiteStatus(true, {}, open)).toBe("CRITICAL");
    // Paused monitoring stays paused.
    expect(deriveWebsiteStatus(false, { UPTIME: "BLOCKED" }, open)).toBe(
      "PAUSED",
    );
    // No open incident: as before.
    expect(deriveWebsiteStatus(true, { UPTIME: "BLOCKED" })).toBe("HEALTHY");
  });
});
