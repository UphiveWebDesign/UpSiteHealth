import type { CrawlResourceType } from "@/generated/prisma/enums";

/** Canonical form used for de-duplication (`crawl_pages.normalizedUrl`). */
export function normalizeCrawlUrl(
  href: string,
  base?: string | URL,
): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url.href;
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Same site if the hostname matches, treating `www.` as equivalent. */
export function isInternalUrl(url: string, siteHost: string): boolean {
  try {
    return bareHost(new URL(url).hostname) === bareHost(siteHost);
  } catch {
    return false;
  }
}

const EXTENSION_TYPES: Array<[RegExp, CrawlResourceType]> = [
  [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)$/i, "IMAGE"],
  [/\.pdf$/i, "PDF"],
  [/\.(mp4|webm|mov|avi|mkv|m4v)$/i, "VIDEO"],
  [/\.(mp3|wav|ogg|m4a|flac|aac)$/i, "AUDIO"],
  [/\.(zip|gz|tgz|rar|7z|tar|bz2|dmg|exe|msi)$/i, "ARCHIVE"],
  [
    /\.(css|js|mjs|json|xml|txt|woff2?|ttf|eot|otf|csv|xlsx?|docx?|pptx?)$/i,
    "OTHER",
  ],
];

/** Guesses a non-HTML resource from its path, so it is not crawled as a page. */
export function resourceTypeFromPath(url: string): CrawlResourceType | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  for (const [pattern, type] of EXTENSION_TYPES)
    if (pattern.test(path)) return type;
  return null;
}

export function resourceTypeFromContentType(
  contentType: string | undefined,
): CrawlResourceType {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml"))
    return "HTML";
  if (ct.startsWith("image/")) return "IMAGE";
  if (ct.includes("pdf")) return "PDF";
  if (ct.startsWith("video/")) return "VIDEO";
  if (ct.startsWith("audio/")) return "AUDIO";
  if (/zip|gzip|x-tar|x-7z|rar/.test(ct)) return "ARCHIVE";
  return "OTHER";
}
