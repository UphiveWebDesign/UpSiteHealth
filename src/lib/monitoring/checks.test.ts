import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { NetPolicy } from "@/lib/net/ssrf";
import {
  classifyHttpStatus,
  evaluateCertificate,
  parseSubjectAltNames,
  runDnsCheck,
  runUptimeCheck,
  type DnsLookups,
} from "./checks";

const NOW = new Date("2026-10-20T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe("classifyHttpStatus", () => {
  test.each([
    [200, "SUCCESS"],
    [204, "SUCCESS"],
    [304, "SUCCESS"],
    [401, "BLOCKED"],
    [403, "BLOCKED"],
    [429, "BLOCKED"],
    [404, "HTTP_ERROR"],
    [500, "HTTP_ERROR"],
    [503, "HTTP_ERROR"],
  ])("%i → %s", (status, outcome) => {
    expect(classifyHttpStatus(status)).toBe(outcome);
  });
});

describe("evaluateCertificate", () => {
  const ok = { hostnameMismatch: false, untrusted: false };
  test("valid, expiring, expired", () => {
    expect(evaluateCertificate({ ...ok, validTo: days(90) }, NOW)).toBe(
      "SUCCESS",
    );
    expect(evaluateCertificate({ ...ok, validTo: days(10) }, NOW)).toBe(
      "EXPIRING",
    );
    expect(evaluateCertificate({ ...ok, validTo: days(-1) }, NOW)).toBe(
      "EXPIRED",
    );
  });
  test("expiry outranks hostname mismatch, which outranks trust errors", () => {
    expect(
      evaluateCertificate(
        { validTo: days(-1), hostnameMismatch: true, untrusted: true },
        NOW,
      ),
    ).toBe("EXPIRED");
    expect(
      evaluateCertificate(
        { validTo: days(90), hostnameMismatch: true, untrusted: true },
        NOW,
      ),
    ).toBe("HOSTNAME_MISMATCH");
    expect(
      evaluateCertificate({ ...ok, validTo: days(90), untrusted: true }, NOW),
    ).toBe("TLS_ERROR");
  });
});

test("parseSubjectAltNames keeps DNS names only", () => {
  expect(
    parseSubjectAltNames(
      "DNS:example.com, DNS:www.example.com, IP Address:1.2.3.4",
    ),
  ).toEqual(["example.com", "www.example.com"]);
  expect(parseSubjectAltNames(undefined)).toEqual([]);
});

describe("runDnsCheck", () => {
  const err = (code: string) =>
    Promise.reject(Object.assign(new Error(code), { code }));
  const fake = (over: Partial<DnsLookups>): DnsLookups => ({
    resolve4: () => Promise.resolve(["93.184.216.34"]),
    resolve6: () => err("ENODATA"),
    resolveCname: () => err("ENODATA"),
    ...over,
  });

  test("records the production result shape {a, aaaa, cname}", async () => {
    const r = await runDnsCheck("https://example.com", fake({}));
    expect(r).toMatchObject({
      type: "DNS",
      outcome: "SUCCESS",
      result: { a: ["93.184.216.34"], aaaa: [], cname: [] },
    });
    expect(r.errorMessage).toBeUndefined();
  });

  test.each([
    ["ENOTFOUND", "NXDOMAIN"],
    ["ESERVFAIL", "SERVFAIL"],
    ["ETIMEOUT", "TIMEOUT"],
    ["ENODATA", "DNS_ERROR"],
  ])("%s with no addresses → %s", async (code, outcome) => {
    const r = await runDnsCheck(
      "https://example.com",
      fake({ resolve4: () => err(code), resolve6: () => err(code) }),
    );
    expect(r.outcome).toBe(outcome);
  });

  test("blocks internal hostnames without querying DNS", async () => {
    const r = await runDnsCheck("http://db.internal/", fake({}));
    expect(r.outcome).toBe("BLOCKED");
  });
});

describe("runUptimeCheck", () => {
  let server: Server;
  let port: number;
  const policy: NetPolicy = {
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    isAllowed: (ip) => ip === "127.0.0.1",
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/forbidden") res.writeHead(403);
      else if (req.url === "/down") res.writeHead(502);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  test("success records status, final URL and timing with a null result", async () => {
    const r = await runUptimeCheck(`http://site.test:${port}/`, policy);
    expect(r).toMatchObject({
      type: "UPTIME",
      outcome: "SUCCESS",
      httpStatus: 200,
      result: null,
    });
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  test("bot-blocked and server errors are distinguished", async () => {
    expect(
      (await runUptimeCheck(`http://site.test:${port}/forbidden`, policy))
        .outcome,
    ).toBe("BLOCKED");
    expect(
      (await runUptimeCheck(`http://site.test:${port}/down`, policy)).outcome,
    ).toBe("HTTP_ERROR");
  });

  test("SSRF-blocked destinations are reported, not fetched", async () => {
    const r = await runUptimeCheck("http://169.254.169.254/");
    expect(r.outcome).toBe("BLOCKED");
  });
});
