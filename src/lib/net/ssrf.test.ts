import { describe, expect, test } from "vitest";
import {
  assertPublicHostname,
  BlockedDestinationError,
  isPublicAddress,
  resolvePinned,
  type NetPolicy,
} from "./ssrf";

describe("isPublicAddress", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // hex-encoded mapped loopback
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1", // NAT64 of 10.0.0.1
    "2002:7f00:1::", // 6to4 of 127.0.0.1
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe("assertPublicHostname", () => {
  test.each([
    "localhost",
    "LOCALHOST.",
    "db.internal",
    "printer.local",
    "x.localhost",
    "127.0.0.1",
    "[::1]",
  ])("rejects %s", (host) => {
    expect(() => assertPublicHostname(host)).toThrow(BlockedDestinationError);
  });

  test("accepts public names", () => {
    expect(() => assertPublicHostname("example.com")).not.toThrow();
  });
});

describe("resolvePinned", () => {
  const policy = (answers: string[]): NetPolicy => ({
    resolve: async () =>
      answers.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    isAllowed: isPublicAddress,
  });

  test("pins a public IPv4 address when available", async () => {
    await expect(
      resolvePinned("example.com", policy(["2606:4700::1", "93.184.216.34"])),
    ).resolves.toEqual({ address: "93.184.216.34", family: 4 });
  });

  test("rejects a hostname if any answer is internal (mixed records)", async () => {
    await expect(
      resolvePinned("rebind.example", policy(["93.184.216.34", "10.0.0.5"])),
    ).rejects.toBeInstanceOf(BlockedDestinationError);
  });

  test("rejects empty answers", async () => {
    await expect(resolvePinned("x.example", policy([]))).rejects.toBeInstanceOf(
      BlockedDestinationError,
    );
  });

  test("rejects literal internal IPs under the strict policy", async () => {
    await expect(resolvePinned("169.254.169.254")).rejects.toBeInstanceOf(
      BlockedDestinationError,
    );
  });
});
