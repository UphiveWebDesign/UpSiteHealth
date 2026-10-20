"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  authenticate,
  EmailTakenError,
  registerAccount,
} from "@/lib/auth/accounts";
import {
  loginLimiterByEmail,
  loginLimiterByIp,
  signupLimiterByIp,
} from "@/lib/auth/rate-limit";
import { safeRedirectPath } from "@/lib/auth/redirect";
import { endSession, startSession } from "@/lib/auth/session";
import { loginSchema, signupSchema } from "@/lib/auth/validation";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/env";

export type AuthFormState =
  | {
      error?: string;
      fieldErrors?: Record<string, string[] | undefined>;
      email?: string;
    }
  | undefined;

const GENERIC_LOGIN_ERROR = "Incorrect email or password.";
const RATE_LIMITED = "Too many attempts. Try again in a few minutes.";

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown"
  );
}

export async function login(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, email };
  }

  const ip = await clientIp();
  if (
    !loginLimiterByIp.consume(ip) ||
    !loginLimiterByEmail.consume(parsed.data.email)
  ) {
    return { error: RATE_LIMITED, email };
  }

  const user = await authenticate(
    db(),
    parsed.data.email,
    parsed.data.password,
  );
  if (!user) return { error: GENERIC_LOGIN_ERROR, email };

  loginLimiterByEmail.reset(parsed.data.email);
  await startSession(user.id);
  redirect(safeRedirectPath(formData.get("next")));
}

export async function signup(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!serverEnv().ALLOW_SIGNUP) {
    return { error: "Sign-up is currently disabled." };
  }
  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    organizationName: formData.get("organizationName"),
  });
  const email = String(formData.get("email") ?? "");
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, email };
  }
  if (!signupLimiterByIp.consume(await clientIp())) {
    return { error: RATE_LIMITED, email };
  }

  let organizationSlug: string;
  try {
    const result = await registerAccount(db(), parsed.data);
    await startSession(result.user.id);
    organizationSlug = result.organizationSlug;
  } catch (error) {
    if (error instanceof EmailTakenError)
      return { error: error.message, email };
    throw error;
  }
  redirect(`/o/${organizationSlug}`);
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
