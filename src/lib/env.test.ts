import { afterEach, describe, expect, test, vi } from "vitest";

const BASE = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("./env")).serverEnv();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serverEnv", () => {
  test("values copied verbatim from .env.example are valid", async () => {
    const env = await load({ ...BASE, ALLOW_SIGNUP: "true", CRON_SECRET: "" });
    expect(env.CRON_SECRET).toBeUndefined();
    expect(env.ALLOW_SIGNUP).toBe(true);
  });

  test("an empty or whitespace Perplexity key is treated as not set", async () => {
    for (const value of ["", "   "]) {
      const env = await load({
        ...BASE,
        GEMINI_API_KEY: "g-key",
        PERPLEXITY_API_KEY: value,
        PERPLEXITY_PRESET: "",
      });
      expect(env.PERPLEXITY_API_KEY).toBeUndefined();
      expect(env.PERPLEXITY_PRESET).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBe("g-key");
    }
  });

  test("a short cron secret is rejected, naming the variable but not the value", async () => {
    await expect(
      load({ ...BASE, CRON_SECRET: "tooshort-secret" }),
    ).rejects.toThrow(/^Invalid server environment: CRON_SECRET$/);
  });

  test("a non-postgres DATABASE_URL is rejected", async () => {
    await expect(load({ DATABASE_URL: "mysql://x" })).rejects.toThrow(
      /DATABASE_URL/,
    );
  });
});
