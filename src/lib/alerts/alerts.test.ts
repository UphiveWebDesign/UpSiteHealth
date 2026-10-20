import { describe, expect, test } from "vitest";
import { backoffMs, EmailError, resendSender } from "./delivery";
import { alertForCrawl, alertsForCheck, alertsForStatusChange } from "./events";
import { DEFAULT_PREFERENCES, shouldNotify } from "./notify";

const base = {
  websiteId: "w1",
  websiteName: "Shop",
  checkId: "c1",
  daysUntilExpiry: null,
};

describe("alertsForCheck", () => {
  test("uptime incidents open and resolve with linked fingerprints", () => {
    const [open] = alertsForCheck({
      ...base,
      type: "UPTIME",
      outcome: "TIMEOUT",
      issue: "opened",
    });
    expect(open).toMatchObject({
      type: "UPTIME_INCIDENT_OPENED",
      severity: "CRITICAL",
      fingerprint: "w1:uptime",
      sourceRef: "website_check:c1",
    });
    const [resolved] = alertsForCheck({
      ...base,
      type: "UPTIME",
      outcome: "SUCCESS",
      issue: "resolved",
    });
    expect(resolved).toMatchObject({
      type: "UPTIME_INCIDENT_RESOLVED",
      resolves: "w1:uptime",
    });
    expect(
      alertsForCheck({
        ...base,
        type: "UPTIME",
        outcome: "TIMEOUT",
        issue: "unchanged",
      }),
    ).toEqual([]);
  });

  test("SSL problems map to their specific event types", () => {
    expect(
      alertsForCheck({
        ...base,
        type: "SSL",
        outcome: "EXPIRING",
        issue: "opened",
        daysUntilExpiry: 9,
      })[0],
    ).toMatchObject({
      type: "SSL_CERTIFICATE_EXPIRING",
      severity: "HIGH",
      message: expect.stringContaining("9 days"),
    });
    expect(
      alertsForCheck({
        ...base,
        type: "SSL",
        outcome: "EXPIRED",
        issue: "opened",
      })[0].type,
    ).toBe("SSL_CERTIFICATE_EXPIRED");
    expect(
      alertsForCheck({
        ...base,
        type: "SSL",
        outcome: "HOSTNAME_MISMATCH",
        issue: "opened",
      })[0].type,
    ).toBe("SSL_CERTIFICATE_HOSTNAME_MISMATCH");
    // Resolution only closes open SSL alerts (the enum has no SSL "resolved" type).
    const closing = alertsForCheck({
      ...base,
      type: "SSL",
      outcome: "SUCCESS",
      issue: "resolved",
    });
    expect(closing.every((d) => d.fingerprint === "" && d.resolves)).toBe(true);
  });

  test("DNS detected/resolved", () => {
    expect(
      alertsForCheck({
        ...base,
        type: "DNS",
        outcome: "NXDOMAIN",
        issue: "opened",
      })[0],
    ).toMatchObject({
      type: "DNS_ERROR_DETECTED",
      severity: "CRITICAL",
    });
    expect(
      alertsForCheck({
        ...base,
        type: "DNS",
        outcome: "SUCCESS",
        issue: "resolved",
      })[0].type,
    ).toBe("DNS_ERROR_RESOLVED");
  });
});

test("status changes produce degraded/recovered alerts", () => {
  const s = { websiteId: "w1", websiteName: "Shop" };
  expect(
    alertsForStatusChange({ ...s, from: "HEALTHY", to: "CRITICAL" })[0],
  ).toMatchObject({
    type: "WEBSITE_HEALTH_DEGRADED",
    severity: "CRITICAL",
  });
  expect(
    alertsForStatusChange({ ...s, from: "CRITICAL", to: "WARNING" }),
  ).toEqual([]);
  expect(
    alertsForStatusChange({ ...s, from: "WARNING", to: "HEALTHY" })[0],
  ).toMatchObject({
    type: "WEBSITE_HEALTH_RECOVERED",
    resolves: "w1:health:WARNING",
  });
  expect(
    alertsForStatusChange({ ...s, from: "UNKNOWN", to: "HEALTHY" }),
  ).toEqual([]);
});

test("crawl alerts only for failures", () => {
  const c = { websiteId: "w1", websiteName: "Shop", runId: "r1" };
  expect(alertForCrawl({ ...c, status: "COMPLETED", pagesFailed: 0 })).toEqual(
    [],
  );
  expect(
    alertForCrawl({ ...c, status: "PARTIAL", pagesFailed: 3 })[0],
  ).toMatchObject({
    type: "CRAWL_COMPLETED_WITH_ERRORS",
    severity: "MEDIUM",
  });
  expect(
    alertForCrawl({ ...c, status: "FAILED", pagesFailed: 0 })[0].severity,
  ).toBe("HIGH");
});

describe("shouldNotify", () => {
  const ev = {
    type: "UPTIME_INCIDENT_OPENED" as const,
    severity: "HIGH" as const,
  };
  test("defaults notify everything", () => {
    expect(shouldNotify(DEFAULT_PREFERENCES, ev)).toBe(true);
  });
  test("disabled, type filter and minimum severity", () => {
    expect(shouldNotify({ ...DEFAULT_PREFERENCES, enabled: false }, ev)).toBe(
      false,
    );
    expect(
      shouldNotify(
        { ...DEFAULT_PREFERENCES, enabledEventTypes: ["DNS_ERROR_DETECTED"] },
        ev,
      ),
    ).toBe(false);
    expect(
      shouldNotify({ ...DEFAULT_PREFERENCES, minimumSeverity: "CRITICAL" }, ev),
    ).toBe(false);
    expect(
      shouldNotify({ ...DEFAULT_PREFERENCES, minimumSeverity: "HIGH" }, ev),
    ).toBe(true);
  });
});

describe("delivery helpers", () => {
  test("backoff doubles and caps at an hour", () => {
    expect([1, 2, 3, 4, 10].map((a) => backoffMs(a) / 60_000)).toEqual([
      1, 2, 4, 8, 60,
    ]);
  });

  test("Resend sender classifies retryable failures and keeps the key in headers", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    const error = await resendSender("re_secret", "alerts@x.example", fetchImpl)
      .send({ to: "a@b.example", subject: "s", text: "t" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(EmailError);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain("re_secret");
    expect((seen!.headers as Record<string, string>).authorization).toBe(
      "Bearer re_secret",
    );

    const bad = (async () =>
      new Response("{}", { status: 422 })) as unknown as typeof fetch;
    const e2 = await resendSender("k", "f", bad)
      .send({ to: "a", subject: "s", text: "t" })
      .catch((e) => e);
    expect(e2.retryable).toBe(false);
  });
});
