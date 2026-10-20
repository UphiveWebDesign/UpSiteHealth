import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { safeFetch, SafeFetchError } from "./safe-fetch";
import type { NetPolicy } from "./ssrf";

// Test-only policy: "site.test" and "other.test" resolve to the local test
// server; "internal.test" resolves to a private address that must be refused.
const testPolicy: NetPolicy = {
  resolve: async (host) => {
    if (host === "internal.test") return [{ address: "10.0.0.7", family: 4 }];
    if (host === "nowhere.test") {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    }
    return [{ address: "127.0.0.1", family: 4 }];
  },
  isAllowed: (ip) => ip === "127.0.0.1",
};

let server: Server;
let port: number;
let lastUserAgent: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUserAgent = req.headers["user-agent"];
    const path = req.url ?? "/";
    if (path === "/ok") return res.end("hello");
    if (path === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      return res.end();
    }
    if (path === "/to-internal") {
      res.writeHead(301, { location: `http://internal.test:${port}/secret` });
      return res.end();
    }
    if (path === "/loop") {
      res.writeHead(302, { location: "/loop" });
      return res.end();
    }
    if (path === "/big") return res.end("x".repeat(5000));
    if (path === "/slow") return setTimeout(() => res.end("late"), 2000);
    if (path === "/404") {
      res.writeHead(404);
      return res.end("missing");
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const url = (path: string, host = "site.test") =>
  `http://${host}:${port}${path}`;

describe("safeFetch", () => {
  test("fetches through the pinned address and sends the bot user agent", async () => {
    const res = await safeFetch(url("/ok"), { policy: testPolicy });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello");
    expect(res.remoteAddress).toBe("127.0.0.1");
    expect(lastUserAgent).toMatch(/^UpSiteHealthBot\/1\.0/);
  });

  test("follows redirects and reports the final URL and count", async () => {
    const res = await safeFetch(url("/redirect"), { policy: testPolicy });
    expect(res.finalUrl).toBe(url("/ok"));
    expect(res.redirectCount).toBe(1);
  });

  test("re-validates every redirect hop and blocks internal targets", async () => {
    await expect(
      safeFetch(url("/to-internal"), { policy: testPolicy }),
    ).rejects.toMatchObject({
      code: "BLOCKED",
    });
  });

  test("stops redirect loops", async () => {
    await expect(
      safeFetch(url("/loop"), { policy: testPolicy, maxRedirects: 3 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  test("enforces the body limit or truncates on request", async () => {
    await expect(
      safeFetch(url("/big"), { policy: testPolicy, maxBodyBytes: 1000 }),
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    const res = await safeFetch(url("/big"), {
      policy: testPolicy,
      maxBodyBytes: 1000,
      onBodyTooLarge: "truncate",
    });
    expect(res.body).toHaveLength(1000);
    expect(res.truncated).toBe(true);
  });

  test("times out slow responses", async () => {
    await expect(
      safeFetch(url("/slow"), { policy: testPolicy, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("returns HTTP error statuses instead of throwing", async () => {
    expect((await safeFetch(url("/404"), { policy: testPolicy })).status).toBe(
      404,
    );
  });

  test("classifies DNS failures", async () => {
    await expect(
      safeFetch(url("/ok", "nowhere.test"), { policy: testPolicy }),
    ).rejects.toMatchObject({ code: "DNS_ERROR" });
  });

  test.each([
    ["ftp://site.test/file", "INVALID_URL"],
    ["http://user:pass@site.test/", "INVALID_URL"],
    ["not a url", "INVALID_URL"],
  ])("rejects %s", async (raw, code) => {
    await expect(safeFetch(raw, { policy: testPolicy })).rejects.toMatchObject({
      code,
    });
  });

  test("the default strict policy refuses loopback and metadata endpoints", async () => {
    for (const target of [
      url("/ok", "127.0.0.1"),
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
    ]) {
      const error = await safeFetch(target).catch((e) => e);
      expect(error).toBeInstanceOf(SafeFetchError);
      expect(error.code).toBe("BLOCKED");
    }
  });
});
