import "server-only";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  createSessionRecord,
  deleteSessionRecord,
  findSessionUser,
  type SessionUser,
} from "./session-store";

const isProduction = process.env.NODE_ENV === "production";

// `__Host-` binds the cookie to this exact origin over HTTPS (production only,
// because it requires the Secure flag).
export const SESSION_COOKIE = isProduction
  ? "__Host-ush_session"
  : "ush_session";

/** Call only from Server Actions or Route Handlers (cookies are writable there). */
export async function startSession(userId: string): Promise<void> {
  const { token, expires } = await createSessionRecord(db(), userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function readSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return findSessionUser(db(), token);
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSessionRecord(db(), token);
  store.delete(SESSION_COOKIE);
}
