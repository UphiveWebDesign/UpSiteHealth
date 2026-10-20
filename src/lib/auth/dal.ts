import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { readSessionUser } from "./session";
import type { SessionUser } from "./session-store";

/** Current user or null, memoised per request. */
export const getCurrentUser = cache(readSessionUser);

/** Current user, or redirect to /login. Use in every protected page and action. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
