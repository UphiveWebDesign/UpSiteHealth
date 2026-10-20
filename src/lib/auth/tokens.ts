import { createHash, randomBytes } from "node:crypto";

/** 256-bit random session token, sent only in the HttpOnly cookie. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The database stores only this hash, so a leaked table cannot be replayed. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
