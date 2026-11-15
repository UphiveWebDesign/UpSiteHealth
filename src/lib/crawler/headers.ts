import type { SafeResponse } from "@/lib/net/safe-fetch";

/**
 * The response headers a crawled page keeps, in CrawlPage.result
 * (`responseHeaders`). An allowlist: only headers the SEO rules read are
 * stored, never cookies, authorization, caching or arbitrary headers.
 * Values are bounded so a hostile server cannot bloat the stored result.
 *
 * - x-robots-tag: indexing directives (seo/robots-directives.ts), one entry
 *   per header line.
 */
export const STORED_RESPONSE_HEADERS = ["x-robots-tag"] as const;

export type StoredResponseHeaders = {
  /** X-Robots-Tag lines as sent (empty: the header was absent). */
  xRobotsTag: string[];
};

const MAX_LINES = 10;
const MAX_LINE_LENGTH = 500;

/** The allowlisted headers of the final response, ready to store. */
export function storedResponseHeaders(
  res: Pick<SafeResponse, "headers" | "headersDistinct">,
): StoredResponseHeaders {
  const distinct = res.headersDistinct?.["x-robots-tag"];
  const joined = res.headers["x-robots-tag"];
  const lines =
    distinct ??
    (joined === undefined ? [] : Array.isArray(joined) ? joined : [joined]);
  return {
    xRobotsTag: lines
      .map((l) => String(l).trim().slice(0, MAX_LINE_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_LINES),
  };
}
