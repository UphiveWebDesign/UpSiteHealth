import { z } from "zod";

/** Optional setting where an empty string (as in .env.example) means "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Runtime connection (Supabase pooler in production).
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
  ALLOW_SIGNUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Bearer secret for /api/cron/work. Unset or empty → the endpoint is disabled.
  CRON_SECRET: optional(z.string().min(32, "must be at least 32 characters")),
  // Optional integrations. Unset → feature falls back or is hidden.
  PAGESPEED_API_KEY: optional(z.string()),
  GEMINI_API_KEY: optional(z.string()),
  GEMINI_MODEL: optional(z.string()),
  PERPLEXITY_API_KEY: optional(z.string()),
  PERPLEXITY_PRESET: optional(z.string()),
  // Email notifications via Resend. Both unset → deliveries become NOT_CONFIGURED.
  RESEND_API_KEY: optional(z.string()),
  EMAIL_FROM: optional(z.string()),
  // Public base URL used in email links, e.g. https://app.example.com
  APP_URL: optional(z.url()),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Validated server environment. Parsed lazily so builds do not need secrets. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report variable names only — never values.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server environment: ${names}`);
  }
  cached = parsed.data;
  return cached;
}
