import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import {
  BlockedDestinationError,
  resolvePinned,
  strictPolicy,
  type NetPolicy,
  type ResolvedAddress,
} from "./ssrf";

export type FetchFailureCode =
  | "INVALID_URL"
  | "BLOCKED"
  | "DNS_ERROR"
  | "TIMEOUT"
  | "CONNECTION_ERROR"
  | "TLS_ERROR"
  | "BODY_TOO_LARGE"
  | "TOO_MANY_REDIRECTS"
  | "UNKNOWN_ERROR";

export class SafeFetchError extends Error {
  constructor(
    public readonly code: FetchFailureCode,
    message: string,
    public readonly url?: string,
  ) {
    super(message);
  }
}

export type SafeFetchOptions = {
  method?: "GET" | "HEAD";
  userAgent?: string;
  accept?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  /** "error" fails with BODY_TOO_LARGE; "truncate" keeps the first bytes. */
  onBodyTooLarge?: "error" | "truncate";
  policy?: NetPolicy;
};

export type SafeResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  finalUrl: string;
  redirectCount: number;
  body: Buffer;
  truncated: boolean;
  remoteAddress: string;
  elapsedMs: number;
};

export const DEFAULT_USER_AGENT =
  "UpSiteHealthBot/1.0 (+https://upsitehealth.example/crawler)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TLS_CODES =
  /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "EPROTO",
]);

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("INVALID_URL", "Invalid URL", raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(
      "INVALID_URL",
      "Only http and https are allowed",
      raw,
    );
  }
  if (url.username || url.password) {
    throw new SafeFetchError(
      "INVALID_URL",
      "Credentials in URLs are not allowed",
      raw,
    );
  }
  return url;
}

export function classifyNetworkError(
  error: unknown,
  url?: string,
): SafeFetchError {
  if (error instanceof SafeFetchError) return error;
  if (error instanceof BlockedDestinationError) {
    return new SafeFetchError("BLOCKED", error.message, url);
  }
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") {
    return new SafeFetchError("DNS_ERROR", `DNS lookup failed (${code})`, url);
  }
  if (code === "ETIMEDOUT")
    return new SafeFetchError("TIMEOUT", "Timed out", url);
  if (TLS_CODES.test(code))
    return new SafeFetchError("TLS_ERROR", `TLS error (${code})`, url);
  if (CONNECTION_CODES.has(code)) {
    return new SafeFetchError(
      "CONNECTION_ERROR",
      `Connection failed (${code})`,
      url,
    );
  }
  return new SafeFetchError("UNKNOWN_ERROR", message.slice(0, 300), url);
}

function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [
        pinned,
      ]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

type Hop = Omit<SafeResponse, "finalUrl" | "redirectCount" | "elapsedMs">;

function requestOnce(
  url: URL,
  pinned: ResolvedAddress,
  opts: Required<Omit<SafeFetchOptions, "policy">>,
  deadline: number,
): Promise<Hop> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Socket events can race (e.g. "end" after an overflow destroy); settle once.
    let settled = false;
    const resolve = (hop: Hop) => {
      if (settled) return;
      settled = true;
      resolvePromise(hop);
    };
    const reject = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new SafeFetchError("TIMEOUT", "Timed out", url.href));
      return;
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        agent: false,
        lookup: pinnedLookup(pinned),
        headers: {
          "user-agent": opts.userAgent,
          accept: opts.accept,
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            truncated,
            remoteAddress: pinned.address,
          });
        if (
          opts.method === "HEAD" ||
          REDIRECT_STATUSES.has(res.statusCode ?? 0)
        ) {
          res.resume();
          res.on("end", finish);
          return;
        }
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.length > opts.maxBodyBytes) {
            if (opts.onBodyTooLarge === "error") {
              reject(
                new SafeFetchError(
                  "BODY_TOO_LARGE",
                  "Response body too large",
                  url.href,
                ),
              );
              req.destroy();
              return;
            }
            chunks.push(chunk.subarray(0, opts.maxBodyBytes - size));
            size = opts.maxBodyBytes;
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on("end", finish);
        res.on("error", (e) => reject(classifyNetworkError(e, url.href)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new SafeFetchError("TIMEOUT", "Timed out", url.href));
    }, remaining);
    req.on("error", (e) => reject(classifyNetworkError(e, url.href)));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

/**
 * SSRF-safe HTTP client. Redirects are followed manually so every hop is
 * re-validated against the address policy.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const opts = {
    method: options.method ?? "GET",
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    accept: options.accept ?? "*/*",
    timeoutMs: options.timeoutMs ?? 10_000,
    maxRedirects: options.maxRedirects ?? 5,
    maxBodyBytes: options.maxBodyBytes ?? 2 * 1024 * 1024,
    onBodyTooLarge: options.onBodyTooLarge ?? "error",
  } as const;
  const policy = options.policy ?? strictPolicy;
  const started = Date.now();
  const deadline = started + opts.timeoutMs;

  let url = parseHttpUrl(rawUrl);
  let method = opts.method;
  for (let redirects = 0; ; redirects++) {
    let hop: Hop;
    try {
      const pinned = await resolvePinned(url.hostname, policy);
      hop = await requestOnce(url, pinned, { ...opts, method }, deadline);
    } catch (error) {
      throw classifyNetworkError(error, url.href);
    }
    const location = hop.headers.location;
    if (REDIRECT_STATUSES.has(hop.status) && location) {
      if (redirects >= opts.maxRedirects) {
        throw new SafeFetchError(
          "TOO_MANY_REDIRECTS",
          "Too many redirects",
          url.href,
        );
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new SafeFetchError(
          "INVALID_URL",
          "Invalid redirect location",
          url.href,
        );
      }
      url = parseHttpUrl(next.href);
      if (hop.status === 303) method = "GET";
      continue;
    }
    return {
      ...hop,
      finalUrl: url.href,
      redirectCount: redirects,
      elapsedMs: Date.now() - started,
    };
  }
}
