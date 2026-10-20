import { afterEach, describe, expect, test, vi } from "vitest";
import { log, redactString, runBackground, serializeError } from "./log";

afterEach(() => vi.restoreAllMocks());

/** Captures every console line written during `fn` as parsed JSON. */
async function capture(fn: () => unknown | Promise<unknown>) {
  const lines: string[] = [];
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation(
      (line: string) => void lines.push(line),
    );
  }
  await fn();
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const BCRYPT = "$2b$12$" + "a".repeat(53);
const SHA = "f".repeat(64);

describe("redactString", () => {
  test.each([
    [
      "postgresql://user:hunter2@db.example.com:5432/x",
      "postgresql://user:[redacted]@db.example.com:5432/x",
    ],
    ["Authorization: Bearer abc.def-123", "Authorization: Bearer [redacted]"],
    ["key AIza" + "B".repeat(35), "key [redacted]"],
    ["resend re_" + "c".repeat(24), "resend [redacted]"],
    [
      "https://api.example/x?key=secret123&a=1",
      "https://api.example/x?key=[redacted]&a=1",
    ],
    [`passwordHash: "${BCRYPT}"`, 'passwordHash: "[redacted-bcrypt]"'],
    [`sessionToken: "${SHA}"`, 'sessionToken: "[redacted-sha256]"'],
  ])("%s", (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  test("leaves ordinary identifiers alone", () => {
    expect(redactString("job cmvgsv2u6000vlfit8tcydrm2 failed")).toBe(
      "job cmvgsv2u6000vlfit8tcydrm2 failed",
    );
  });
});

describe("log", () => {
  test("writes one JSON line per event at the right level", async () => {
    const lines = await capture(() => {
      log.info("a", { websiteId: "w1" });
      log.warn("b");
      log.error("c", {}, new Error("boom"));
    });
    expect(lines.map((l) => [l.level, l.event])).toEqual([
      ["info", "a"],
      ["warn", "b"],
      ["error", "c"],
    ]);
    expect(lines[0]).toMatchObject({ websiteId: "w1", ts: expect.any(String) });
    expect(lines[2].error).toMatchObject({ name: "Error", message: "boom" });
  });

  test("drops values under sensitive keys, at any depth", async () => {
    const [line] = await capture(() =>
      log.error("x", {
        password: "p",
        apiKey: "k",
        authorization: "Bearer t",
        nested: { cookie: "c", sessionToken: "s", ok: "visible" },
        DATABASE_URL: "postgres://u:p@h/d",
      }),
    );
    expect(line).toMatchObject({
      password: "[redacted]",
      apiKey: "[redacted]",
      authorization: "[redacted]",
      DATABASE_URL: "[redacted]",
      nested: {
        cookie: "[redacted]",
        sessionToken: "[redacted]",
        ok: "visible",
      },
    });
  });

  test("secrets inside error messages and stacks never reach the output", async () => {
    const error = Object.assign(
      new Error(
        `connect failed postgresql://app:Sup3rS3cret@db.x:6543/p token ${SHA}`,
      ),
      { code: "P1001" },
    );
    const lines = await capture(() =>
      log.error("db_failed", { runId: "r1" }, error),
    );
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("Sup3rS3cret");
    expect(raw).not.toContain(SHA);
    expect(lines[0].error).toMatchObject({ code: "P1001" });
  });
});

test("serializeError handles non-Error values", () => {
  expect(serializeError("plain")).toEqual({ message: "plain" });
});

describe("runBackground", () => {
  test("logs failures with context and never rethrows", async () => {
    const lines = await capture(() =>
      runBackground("pagespeed_run", { websiteId: "w1" }, async () => {
        throw Object.assign(new Error("PageSpeed Insights quota exceeded"), {
          code: "QUOTA_EXCEEDED",
        });
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      event: "background_task_failed",
      task: "pagespeed_run",
      websiteId: "w1",
      error: { code: "QUOTA_EXCEEDED" },
    });
  });

  test("is silent on success", async () => {
    expect(await capture(() => runBackground("t", {}, async () => 1))).toEqual(
      [],
    );
  });
});
