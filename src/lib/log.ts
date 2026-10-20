/**
 * Structured server logging: one JSON object per line (stdout for info,
 * stderr for warn/error) so hosting log viewers can filter by `event`.
 *
 * Never pass secrets in. As a second line of defence, values under sensitive
 * keys are dropped and secret-looking substrings are masked everywhere,
 * including error messages and stacks.
 */

type Level = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|session|^key$|dsn|database_url|direct_url/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // user:password@ in connection strings and URLs
  [/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):[^@/\s]+@/gi, "$1:[redacted]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]"], // Google API keys
  [/\bre_[A-Za-z0-9_]{16,}/g, "[redacted]"], // Resend
  [/\bpplx-[A-Za-z0-9]{16,}/g, "[redacted]"], // Perplexity
  [/\bsbp_[a-f0-9]{20,}/g, "[redacted]"], // Supabase access tokens
  [
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    "[redacted-jwt]",
  ],
  [/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi, "$1[redacted]"],
  // Prisma validation errors can echo query arguments, e.g. a password hash
  // or a stored session-token hash; mask both formats.
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, "[redacted-bcrypt]"],
  [/\b[a-f0-9]{64}\b/g, "[redacted-sha256]"],
];

export function redactString(value: string): string {
  return SECRET_PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), value);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return redactString(value).slice(0, 2000);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Name, message, code and a short stack — no request bodies or raw causes. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error))
    return { message: redactString(String(error)).slice(0, 500) };
  const e = error as Error & { code?: unknown; status?: unknown };
  return {
    name: e.name,
    message: redactString(e.message).slice(0, 1000),
    ...(e.code !== undefined ? { code: String(e.code) } : {}),
    ...(e.status !== undefined ? { status: String(e.status) } : {}),
    stack: e.stack
      ? redactString(e.stack).split("\n").slice(0, 8).join("\n")
      : undefined,
  };
}

function write(
  level: Level,
  event: string,
  fields: LogFields = {},
  error?: unknown,
) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(sanitize(fields) as LogFields),
    ...(error !== undefined ? { error: serializeError(error) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "info") console.log(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
}

export const log = {
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields, error?: unknown) =>
    write("warn", event, fields, error),
  error: (event: string, fields?: LogFields, error?: unknown) =>
    write("error", event, fields, error),
};

/**
 * Runs fire-and-forget work (e.g. inside `after()`), logging instead of
 * silently discarding failures. Never rethrows.
 */
export async function runBackground(
  task: string,
  fields: LogFields,
  fn: () => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  try {
    await fn();
  } catch (error) {
    log.error(
      "background_task_failed",
      { task, ...fields, durationMs: Date.now() - started },
      error,
    );
  }
}
