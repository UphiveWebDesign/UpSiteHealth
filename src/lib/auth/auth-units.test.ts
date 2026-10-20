import bcrypt from "bcryptjs";
import { describe, expect, test } from "vitest";
import { slugify } from "./accounts";
import { hashPassword, verifyPassword } from "./password";
import { RateLimiter } from "./rate-limit";
import { safeRedirectPath } from "./redirect";
import { generateSessionToken, hashSessionToken } from "./tokens";
import { loginSchema, signupSchema } from "./validation";

describe("passwords", () => {
  test("produce $2b$ bcrypt hashes like the existing users", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$2b\$12\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("verify hashes made with other bcrypt variants and costs", async () => {
    const legacy = (await bcrypt.hash("legacy-pass", 10)).replace(
      /^\$2b\$/,
      "$2a$",
    );
    expect(await verifyPassword("legacy-pass", legacy)).toBe(true);
  });

  test("return false for users without a password hash", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });
});

describe("session tokens", () => {
  test("are random 256-bit values stored only as SHA-256 hashes", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(hashSessionToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a)).toBe(hashSessionToken(a));
    expect(hashSessionToken(a)).not.toContain(a);
  });
});

describe("safeRedirectPath", () => {
  test.each([
    ["/o/acme", "/o/acme"],
    ["/dashboard?x=1", "/dashboard?x=1"],
    ["https://evil.example", "/dashboard"],
    ["//evil.example", "/dashboard"],
    ["/\\evil.example", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    [undefined, "/dashboard"],
    [["/a"], "/dashboard"],
  ])("%j → %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});

describe("validation", () => {
  test("normalizes email case and whitespace", () => {
    const r = loginSchema.parse({
      email: "  Owner@Example.COM ",
      password: "x",
    });
    expect(r.email).toBe("owner@example.com");
  });

  test("enforces signup password rules including bcrypt's 72-byte limit", () => {
    const base = { name: "A", email: "a@b.co", organizationName: "Acme" };
    expect(signupSchema.safeParse({ ...base, password: "short" }).success).toBe(
      false,
    );
    expect(
      signupSchema.safeParse({ ...base, password: "é".repeat(37) }).success,
    ).toBe(false); // 74 bytes
    expect(
      signupSchema.safeParse({ ...base, password: "long enough" }).success,
    ).toBe(true);
  });

  test("allows short legacy passwords at login", () => {
    expect(
      loginSchema.safeParse({ email: "a@b.co", password: "abc" }).success,
    ).toBe(true);
  });
});

describe("RateLimiter", () => {
  test("blocks after the limit and recovers after the window", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.consume("k", 0)).toBe(true);
    expect(limiter.consume("k", 1)).toBe(true);
    expect(limiter.consume("k", 2)).toBe(false);
    expect(limiter.consume("other", 2)).toBe(true);
    expect(limiter.consume("k", 1001)).toBe(true);
  });

  test("reset clears a key", () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.consume("k", 0);
    limiter.reset("k");
    expect(limiter.consume("k", 1)).toBe(true);
  });
});

describe("slugify", () => {
  test.each([
    ["Acme Agency", "acme-agency"],
    ["  Café & Co.  ", "cafe-co"],
    ["!!!", "org"],
  ])("%s → %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});
