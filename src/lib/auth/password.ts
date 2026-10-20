import bcrypt from "bcryptjs";

// Existing production users have bcrypt `$2b$` hashes; keep the same algorithm.
const BCRYPT_COST = 12;

/** bcrypt only uses the first 72 bytes, so longer passwords are rejected up front. */
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Verifies a password. When there is no stored hash (unknown user), it still
 * runs a full bcrypt comparison so response timing does not reveal whether
 * the account exists.
 */
export async function verifyPassword(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) {
    dummyHash ??= bcrypt.hash("timing-equaliser", BCRYPT_COST);
    await bcrypt.compare(password, await dummyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}
