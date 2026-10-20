import { parseHttpUrl, SafeFetchError } from "@/lib/net/safe-fetch";
import { assertPublicHostname, BlockedDestinationError } from "@/lib/net/ssrf";

export class WebsiteUrlError extends Error {}

/**
 * Normalizes user input into the stored `url` and `domain`. Matches existing
 * rows: lower-case host, no trailing slash for a bare origin
 * (`https://example.com`), paths kept, fragments dropped.
 */
export function normalizeWebsiteUrl(raw: string): {
  url: string;
  domain: string;
} {
  const input = raw.trim();
  if (!input) throw new WebsiteUrlError("Enter a website URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : `https://${input}`;

  let url: URL;
  try {
    url = parseHttpUrl(withScheme);
    assertPublicHostname(url.hostname);
  } catch (error) {
    if (error instanceof BlockedDestinationError) {
      throw new WebsiteUrlError(
        "Internal or private addresses cannot be monitored.",
      );
    }
    if (error instanceof SafeFetchError) {
      throw new WebsiteUrlError("Enter a valid http or https URL.");
    }
    throw error;
  }
  if (!url.hostname.includes(".") && !url.hostname.includes(":")) {
    throw new WebsiteUrlError("Enter a full domain name, such as example.com.");
  }

  url.hash = "";
  const bareOrigin = url.pathname === "/" && !url.search;
  return {
    url: bareOrigin ? url.origin : url.href,
    domain: url.hostname,
  };
}
