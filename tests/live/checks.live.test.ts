import { describe, expect, test } from "vitest";
import {
  runDnsCheck,
  runSslCheck,
  runUptimeCheck,
} from "@/lib/monitoring/checks";

// Opt-in: hits the real internet. Run with LIVE_NETWORK=1 npx vitest run tests/live
describe.skipIf(process.env.LIVE_NETWORK !== "1")(
  "live monitoring checks",
  () => {
    test("uptime against a public site", { timeout: 20_000 }, async () => {
      const r = await runUptimeCheck("https://example.com");
      expect(["SUCCESS", "BLOCKED"]).toContain(r.outcome);
    });

    test("SSL certificate details", { timeout: 20_000 }, async () => {
      const r = await runSslCheck("https://example.com");
      expect(r.outcome).toBe("SUCCESS");
      expect(r.sslExpiresAt).toBeInstanceOf(Date);
      expect(r.result).toMatchObject({
        issuer: expect.any(String),
        protocol: expect.stringMatching(/^TLSv1\.[23]$/),
        subjectAltNames: expect.arrayContaining([
          expect.stringContaining("example.com"),
        ]),
      });
    });

    test(
      "SSL hostname mismatch and expiry are detected",
      { timeout: 60_000 }, // badssl.com handshakes take 4–7 s each
      async () => {
        expect(
          (await runSslCheck("https://wrong.host.badssl.com")).outcome,
        ).toBe("HOSTNAME_MISMATCH");
        expect((await runSslCheck("https://expired.badssl.com")).outcome).toBe(
          "EXPIRED",
        );
        expect(
          (await runSslCheck("https://self-signed.badssl.com")).outcome,
        ).toBe("TLS_ERROR");
      },
    );

    test("DNS records and NXDOMAIN", { timeout: 20_000 }, async () => {
      const ok = await runDnsCheck("https://example.com");
      expect(ok.outcome).toBe("SUCCESS");
      expect((ok.result as { a: string[] }).a.length).toBeGreaterThan(0);
      const missing = await runDnsCheck(
        "https://does-not-exist-upsitehealth-test.invalid",
      );
      expect(["NXDOMAIN", "DNS_ERROR"]).toContain(missing.outcome);
    });
  },
);

describe.skipIf(process.env.LIVE_NETWORK !== "1")(
  "live PageSpeed Insights",
  () => {
    test(
      "runs a mobile test without an API key",
      { timeout: 120_000 },
      async () => {
        const { runPageSpeed, PageSpeedError } =
          await import("@/lib/performance/pagespeed");
        try {
          const r = await runPageSpeed("https://example.com", "MOBILE");
          expect(r.performanceScore).toBeGreaterThanOrEqual(0);
          expect(r.sourceVersion).toMatch(/^\d+\.\d+/);
        } catch (error) {
          // Anonymous quota can be exhausted; that must surface as a typed error.
          expect(error).toBeInstanceOf(PageSpeedError);
          expect(["RATE_LIMITED", "QUOTA_EXCEEDED"]).toContain(
            (error as InstanceType<typeof PageSpeedError>).code,
          );
        }
      },
    );
  },
);
