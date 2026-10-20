import { createHash } from "node:crypto";
import type {
  AiSearchMode,
  AiSearchProvider,
  AiSearchResultStatus,
} from "@/generated/prisma/enums";
import type { Source } from "./analysis";

/**
 * AI Search providers. GEMINI and PERPLEXITY are implemented against their
 * documented APIs as of 2026-10 (Gemini Interactions API with google_search;
 * Perplexity Agent API with web_search) but have NOT been verified with live
 * keys. MOCK is deterministic and used by default and in tests.
 */

export type ProviderAnswer = {
  answer: string;
  sources: Source[];
  model: string | null;
  sourceVersion: string | null;
};

export interface SearchProvider {
  id: AiSearchProvider;
  model: string;
  searchMode: AiSearchMode;
  ask(query: string, signal?: AbortSignal): Promise<ProviderAnswer>;
}

export class ProviderError extends Error {
  constructor(
    public readonly status: Exclude<AiSearchResultStatus, "SUCCESS">,
    message: string,
  ) {
    super(message);
  }
}

/** Maps an HTTP failure to a result status without echoing secrets. */
export function classifyProviderHttpError(
  status: number,
  body: string,
): ProviderError {
  if (status === 429) {
    return /quota|RESOURCE_EXHAUSTED|billing/i.test(body)
      ? new ProviderError("QUOTA_EXCEEDED", "Provider quota exceeded")
      : new ProviderError("RATE_LIMITED", "Provider rate limit reached");
  }
  if (status === 400 || status === 422)
    return new ProviderError("INVALID_QUERY", "Provider rejected the query");
  if (status === 401 || status === 403)
    return new ProviderError("PROVIDER_ERROR", "Provider rejected the API key");
  if (status >= 500)
    return new ProviderError(
      "UNAVAILABLE",
      `Provider unavailable (HTTP ${status})`,
    );
  return new ProviderError("PROVIDER_ERROR", `Provider error (HTTP ${status})`);
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const name = (error as Error).name;
    throw name === "TimeoutError" || name === "AbortError"
      ? new ProviderError("TIMEOUT", "Provider timed out")
      : new ProviderError("UNAVAILABLE", "Provider unreachable");
  }
  if (!res.ok)
    throw classifyProviderHttpError(
      res.status,
      await res.text().catch(() => ""),
    );
  return res.json();
}

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Map<string, Source>();
  for (const s of sources) if (s.url && !seen.has(s.url)) seen.set(s.url, s);
  return [...seen.values()];
}

// ─── Gemini (Interactions API) ──────────────────────────────────────────────

type GeminiInteraction = {
  model?: string;
  status?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
};

export function parseGeminiInteraction(
  json: GeminiInteraction,
): ProviderAnswer {
  const texts: string[] = [];
  const sources: Source[] = [];
  for (const step of json.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const c of step.content ?? []) {
      if (c.type === "text" && c.text) texts.push(c.text);
      for (const a of c.annotations ?? []) {
        if (a.type === "url_citation" && a.url)
          sources.push({ url: a.url, title: a.title ?? null });
      }
    }
  }
  if (!texts.length) {
    throw new ProviderError(
      "PROVIDER_ERROR",
      `Gemini returned no text (status ${json.status ?? "unknown"})`,
    );
  }
  return {
    answer: texts.join("\n"),
    sources: dedupeSources(sources),
    model: json.model ?? null,
    sourceVersion: "interactions-v1beta",
  };
}

export function geminiProvider(
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): SearchProvider {
  return {
    id: "GEMINI",
    model,
    searchMode: "WEB_GROUNDED",
    async ask(query, signal) {
      const json = await postJson(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        { "x-goog-api-key": apiKey },
        {
          model,
          input: query,
          tools: [{ type: "google_search" }],
          store: false,
        },
        fetchImpl,
        signal,
      );
      return parseGeminiInteraction(json as GeminiInteraction);
    },
  };
}

// ─── Perplexity (Agent API) ─────────────────────────────────────────────────

type PerplexityResponse = {
  model?: string;
  status?: string;
  output?: Array<{
    type?: string;
    results?: Array<{ url?: string; title?: string }>;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
};

export function parsePerplexityResponse(
  json: PerplexityResponse,
): ProviderAnswer {
  const texts: string[] = [];
  const sources: Source[] = [];
  for (const item of json.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) texts.push(c.text);
        for (const a of c.annotations ?? []) {
          if (a.type === "url_citation" && a.url)
            sources.push({ url: a.url, title: a.title ?? null });
        }
      }
    } else if (item.type === "search_results") {
      for (const r of item.results ?? [])
        if (r.url) sources.push({ url: r.url, title: r.title ?? null });
    }
  }
  if (!texts.length) {
    throw new ProviderError(
      "PROVIDER_ERROR",
      `Perplexity returned no text (status ${json.status ?? "unknown"})`,
    );
  }
  return {
    answer: texts.join("\n"),
    sources: dedupeSources(sources),
    model: json.model ?? null,
    sourceVersion: "agent-v1",
  };
}

export function perplexityProvider(
  apiKey: string,
  preset: string,
  fetchImpl: typeof fetch = fetch,
): SearchProvider {
  return {
    id: "PERPLEXITY",
    model: preset,
    searchMode: "SEARCH_AUGMENTED",
    async ask(query, signal) {
      const json = await postJson(
        "https://api.perplexity.ai/v1/agent",
        { authorization: `Bearer ${apiKey}` },
        { preset, input: query, tools: [{ type: "web_search" }], store: false },
        fetchImpl,
        signal,
      );
      return parsePerplexityResponse(json as PerplexityResponse);
    },
  };
}

// ─── Mock ───────────────────────────────────────────────────────────────────

/** Deterministic answers so runs are reproducible without any API key. */
export function mockProvider(brand: {
  brandName: string;
  domain: string;
}): SearchProvider {
  return {
    id: "MOCK",
    model: "mock-v1",
    searchMode: "MODEL_RESPONSE",
    async ask(query) {
      const n = createHash("sha256").update(query).digest()[0];
      const mentioned = n % 3 !== 0;
      const answer = mentioned
        ? `For "${query}", ${brand.brandName} is a well-regarded option worth considering. Other providers also operate in this area.`
        : `For "${query}", several providers are available; compare reviews and pricing before choosing.`;
      return {
        answer,
        sources: mentioned
          ? [
              { url: `https://${brand.domain}/`, title: brand.brandName },
              { url: "https://directory.example/listing", title: "Directory" },
            ]
          : [{ url: "https://directory.example/listing", title: "Directory" }],
        model: "mock-v1",
        sourceVersion: "mock",
      };
    },
  };
}

export type ProviderConfig = {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  PERPLEXITY_API_KEY?: string;
  PERPLEXITY_PRESET?: string;
};

/** Providers usable in this deployment (MOCK is always available). */
export function availableProviders(config: ProviderConfig): AiSearchProvider[] {
  return [
    "MOCK" as const,
    ...(config.GEMINI_API_KEY ? (["GEMINI"] as const) : []),
    ...(config.PERPLEXITY_API_KEY ? (["PERPLEXITY"] as const) : []),
  ];
}

export function createProvider(
  id: AiSearchProvider,
  config: ProviderConfig,
  brand: { brandName: string; domain: string },
): SearchProvider {
  if (id === "GEMINI" && config.GEMINI_API_KEY) {
    return geminiProvider(
      config.GEMINI_API_KEY,
      config.GEMINI_MODEL || "gemini-3.8-flash",
    );
  }
  if (id === "PERPLEXITY" && config.PERPLEXITY_API_KEY) {
    return perplexityProvider(
      config.PERPLEXITY_API_KEY,
      config.PERPLEXITY_PRESET || "fast",
    );
  }
  if (id === "MOCK") return mockProvider(brand);
  throw new ProviderError("UNAVAILABLE", `${id} is not configured`);
}
