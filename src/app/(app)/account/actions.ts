"use server";

import { z } from "zod";
import { changePassword } from "@/lib/auth/accounts";
import { requireUser } from "@/lib/auth/dal";
import { RateLimiter } from "@/lib/auth/rate-limit";
import { startSession } from "@/lib/auth/session";
import { signupSchema } from "@/lib/auth/validation";
import { db } from "@/lib/db";

type State = { error?: string; ok?: string } | undefined;

const limiter = new RateLimiter(5, 15 * 60 * 1000);
const newPassword = signupSchema.shape.password;

export async function changePasswordAction(
  _prev: State,
  formData: FormData,
): Promise<State> {
  const user = await requireUser();
  if (!limiter.consume(user.id))
    return { error: "Too many attempts. Try again later." };

  const parsed = z
    .object({
      current: z.string().min(1, "Enter your current password."),
      next: newPassword,
      confirm: z.string(),
    })
    .refine((v) => v.next === v.confirm, "The new passwords do not match.")
    .refine(
      (v) => v.next !== v.current,
      "Choose a password you have not used here.",
    )
    .safeParse({
      current: formData.get("current"),
      next: formData.get("next"),
      confirm: formData.get("confirm"),
    });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const ok = await changePassword(
    db(),
    user.id,
    parsed.data.current,
    parsed.data.next,
  );
  if (!ok) return { error: "Your current password is incorrect." };
  limiter.reset(user.id);
  await startSession(user.id); // all other sessions were revoked
  return { ok: "Password changed. Other devices have been signed out." };
}
