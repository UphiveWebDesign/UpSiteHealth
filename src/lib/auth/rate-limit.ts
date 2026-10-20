/**
 * Fixed-window, in-memory rate limiter for login and signup attempts.
 *
 * Limitation: state is per server instance and resets on restart. That is
 * enough to slow brute-force attempts on a single instance; a shared store is
 * needed before scaling out (tracked in recovery/RECOVERY.md).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt. Returns false when the key is over its limit. */
  consume(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

export const loginLimiterByEmail = new RateLimiter(5, FIFTEEN_MINUTES);
export const loginLimiterByIp = new RateLimiter(30, FIFTEEN_MINUTES);
export const signupLimiterByIp = new RateLimiter(5, 60 * 60 * 1000);
