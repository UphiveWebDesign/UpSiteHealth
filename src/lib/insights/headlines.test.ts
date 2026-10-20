import { expect, test } from "vitest";
import { dnsHeadline, sslHeadline, uptimeHeadline } from "./headlines";

const NOW = new Date("2026-10-21T00:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

test("no check yet is explicit, never a zero", () => {
  for (const h of [
    uptimeHeadline(null),
    sslHeadline(null, NOW),
    dnsHeadline(null),
  ]) {
    expect(h).toEqual({
      tone: "neutral",
      title: "No checks yet",
      detail: "Results appear after the first check.",
    });
  }
});

test("uptime", () => {
  expect(
    uptimeHeadline({
      outcome: "SUCCESS",
      httpStatus: 200,
      responseTimeMs: 312,
    }),
  ).toEqual({
    tone: "success",
    title: "Online",
    detail: "HTTP 200 · 312 ms",
  });
  expect(uptimeHeadline({ outcome: "BLOCKED", httpStatus: 403 })).toMatchObject(
    {
      tone: "warning",
      title: "Reachable, but our checker was blocked",
    },
  );
  expect(
    uptimeHeadline({ outcome: "TIMEOUT", errorMessage: "Timed out" }),
  ).toEqual({
    tone: "danger",
    title: "Down",
    detail: "Timed out",
  });
});

test("ssl", () => {
  expect(
    sslHeadline(
      {
        outcome: "SUCCESS",
        sslExpiresAt: inDays(84),
        result: { issuer: "Let's Encrypt" },
      },
      NOW,
    ),
  ).toEqual({
    tone: "success",
    title: "Valid for 84 days",
    detail: "Issued by Let's Encrypt",
  });
  expect(
    sslHeadline({ outcome: "EXPIRING", sslExpiresAt: inDays(9) }, NOW).title,
  ).toBe("Expires in 9 days — renew now");
  expect(sslHeadline({ outcome: "EXPIRED" }, NOW).tone).toBe("danger");
});

test("dns", () => {
  expect(
    dnsHeadline({
      outcome: "SUCCESS",
      result: { a: ["1.1.1.1", "1.0.0.1"], aaaa: [] },
    }),
  ).toEqual({
    tone: "success",
    title: "Resolving",
    detail: "2 address records",
  });
  expect(dnsHeadline({ outcome: "NXDOMAIN" }).title).toBe("Domain not found");
});
