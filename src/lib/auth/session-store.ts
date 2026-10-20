import type { PrismaClient } from "@/generated/prisma/client";
import { generateSessionToken, hashSessionToken } from "./tokens";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionUser = { id: string; email: string; name: string | null };

export async function createSessionRecord(
  db: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<{ token: string; expires: Date }> {
  const token = generateSessionToken();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await db.session.create({
    data: { sessionToken: hashSessionToken(token), userId, expires },
  });
  return { token, expires };
}

/** Returns the session's user, or null if the token is unknown or expired. */
export async function findSessionUser(
  db: PrismaClient,
  token: string,
  now = new Date(),
): Promise<SessionUser | null> {
  const sessionToken = hashSessionToken(token);
  const session = await db.session.findUnique({
    where: { sessionToken },
    select: {
      expires: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });
  if (!session) return null;
  if (session.expires <= now) {
    await db.session.deleteMany({ where: { sessionToken } });
    return null;
  }
  return session.user;
}

export async function deleteSessionRecord(
  db: PrismaClient,
  token: string,
): Promise<void> {
  await db.session.deleteMany({
    where: { sessionToken: hashSessionToken(token) },
  });
}

/** Signs a user out everywhere, e.g. after a password change. */
export async function deleteAllUserSessions(
  db: PrismaClient,
  userId: string,
): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { userId } });
  return count;
}
