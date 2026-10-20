import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { hashPassword, verifyPassword } from "./password";
import type { SessionUser } from "./session-store";
import type { SignupInput } from "./validation";

/**
 * Checks email + password. Email matching is case-insensitive so existing
 * accounts created with mixed-case addresses keep working.
 */
export async function authenticate(
  db: PrismaClient,
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, name: true, passwordHash: true },
  });
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok) return null;
  return { id: user.id, email: user.email, name: user.name };
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "org";
}

/**
 * Changes a password after verifying the current one, and revokes every
 * session for the user (the caller starts a fresh one for this device).
 */
export async function changePassword(
  db: PrismaClient,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(currentPassword, user?.passwordHash)))
    return false;
  const passwordHash = await hashPassword(newPassword);
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { passwordHash } }),
    db.session.deleteMany({ where: { userId } }),
  ]);
  return true;
}

export class EmailTakenError extends Error {
  constructor() {
    super("An account with that email already exists.");
  }
}

/** Creates a user, their organization, and an OWNER membership atomically. */
export async function registerAccount(
  db: PrismaClient,
  input: SignupInput,
): Promise<{ user: SessionUser; organizationSlug: string }> {
  const existing = await db.user.findFirst({
    where: { email: { equals: input.email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) throw new EmailTakenError();

  const passwordHash = await hashPassword(input.password);
  const base = slugify(input.organizationName);

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug =
      attempt === 0
        ? base
        : `${base}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      return await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: input.name, email: input.email, passwordHash },
          select: { id: true, email: true, name: true },
        });
        const org = await tx.organization.create({
          data: { name: input.organizationName, slug },
          select: { id: true, slug: true },
        });
        await tx.organizationMember.create({
          data: { organizationId: org.id, userId: user.id, role: "OWNER" },
        });
        return { user, organizationSlug: org.slug };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const target = String(error.meta?.target ?? "");
      if (target.includes("email")) throw new EmailTakenError();
      // Otherwise the slug was taken: retry with a suffix.
    }
  }
  throw new Error("Could not allocate a unique organization slug.");
}

function isUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
