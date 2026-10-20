import { z } from "zod";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from "./password";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email("Enter a valid email address."))
  .transform(normalizeEmail);

const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .refine(
    (p) => Buffer.byteLength(p, "utf8") <= MAX_PASSWORD_BYTES,
    `Use at most ${MAX_PASSWORD_BYTES} bytes.`,
  );

export const loginSchema = z.object({
  email,
  // Never length-check login passwords beyond bcrypt's limit: legacy
  // passwords may be shorter than today's minimum.
  password: z.string().min(1, "Enter your password.").max(1024),
});

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100),
  email,
  password,
  organizationName: z
    .string()
    .trim()
    .min(2, "Enter an organization name.")
    .max(100),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
