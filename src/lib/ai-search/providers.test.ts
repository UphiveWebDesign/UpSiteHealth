import { describe, expect, test, vi } from "vitest";
import {
  availableProviders,
  classifyProviderHttpError,
  createProvider,
  geminiProvider,
  mockProvider,
  parseGeminiInteraction,
  parsePerplexityResponse,
  perplexityProvider,
  ProviderError,
  providerUnavailableMessage,
} from "./providers";

// Fixtures follow the documented response shapes (2026-10).
const geminiFixture = {
  model: "gemini-3.8-flash",
  status: "completed",
  steps: [
    { type: "google_search_call" },
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "Acme Plumbing is a popular choice in Leeds.",
          annotations: [
            {
              type: "url_citation",
              url: "https://acme.example/",
              title: "Acme",
            },
            {
              type: "url_citation",
              url: "https://acme.example/",
              title: "Acme dup",
            },
            {
              type: "url_citation",
              url: "https://reviews.example/a",
              title: "Reviews",
            },
          ],
        },
      ],
    },
  ],
};

const perplexityFixture = {
  model: "openai/gpt-5.6-luna",
  status: "completed",
  output: [
    {
      type: "search_results",
      queries: ["best plumber leeds"],
      results: [
        {
          id: "1",
          url: "https://dir.example/plumbers",
          title: "Directory",
          snippet: "…",
        },
      ],
    },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Top options include Acme Plumbing [1].",
          annotations: [
            {
              type: "url_citation",
              url: "https://acme.example/",
              title: "Acme",
            },
          ],
        },
      ],
    },
  ],
};

describe("response parsers", () => {
  test("Gemini Interactions: text and de-duplicated url_citation sources", () => {
    expect(parseGeminiInteraction(geminiFixture)).toEqual({
      answer: "Acme Plumbing is a popular choice in Leeds.",
      sources: [
        { url: "https://acme.example/", title: "Acme" },
        { url: "https://reviews.example/a", title: "Reviews" },
      ],
      model: "gemini-3.8-flash",
      sourceVersion: "interactions-v1beta",
    });
  });

  test("Perplexity Agent: message text plus search results and citations", () => {
    const r = parsePerplexityResponse(perplexityFixture);
    expect(r.answer).toBe("Top options include Acme Plumbing [1].");
    expect(r.sources.map((s) => s.url)).toEqual([
      "https://dir.example/plumbers",
      "https://acme.example/",
    ]);
    expect(r.model).toBe("openai/gpt-5.6-luna");
  });

  test("empty outputs are provider errors", () => {
    expect(() =>
      parseGeminiInteraction({ status: "failed", steps: [] }),
    ).toThrow(ProviderError);
    expect(() => parsePerplexityResponse({ output: [] })).toThrow(
      ProviderError,
    );
  });
});

describe("HTTP behaviour", () => {
  test.each([
    [
      429,
      '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}',
      "QUOTA_EXCEEDED",
    ],
    [429, "slow down", "RATE_LIMITED"],
    [400, "bad", "INVALID_QUERY"],
    [401, "bad key", "PROVIDER_ERROR"],
    [503, "", "UNAVAILABLE"],
  ])("HTTP %i → %s", (status, body, expected) => {
    expect(classifyProviderHttpError(status, body).status).toBe(expected);
  });

  test("keys go in headers, never in URLs or error messages", async () => {
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body: unknown;
    }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return new Response("Quota exceeded", { status: 429 });
    }) as unknown as typeof fetch;

    const g = await geminiProvider("g-secret", "gemini-3.8-flash", fetchImpl)
      .ask("q")
      .catch((e) => e);
    const p = await perplexityProvider("p-secret", "fast", fetchImpl)
      .ask("q")
      .catch((e) => e);
    expect(g).toMatchObject({ status: "QUOTA_EXCEEDED" });
    expect(p).toBeInstanceOf(ProviderError);
    expect(calls[0]).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/interactions",
      headers: { "x-goog-api-key": "g-secret" },
      body: {
        model: "gemini-3.8-flash",
        input: "q",
        tools: [{ type: "google_search" }],
        store: false,
      },
    });
    expect(calls[1]).toMatchObject({
      url: "https://api.perplexity.ai/v1/agent",
      headers: { authorization: "Bearer p-secret" },
      body: { preset: "fast", tools: [{ type: "web_search" }] },
    });
    for (const c of calls) expect(c.url).not.toMatch(/secret/);
    expect(`${g.message} ${p.message}`).not.toMatch(/secret/);
  });

  test("timeouts are classified", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await expect(
      geminiProvider("k", "m", fetchImpl).ask("q"),
    ).rejects.toMatchObject({ status: "TIMEOUT" });
  });
});

test("mock provider is deterministic and only advertised providers are available", async () => {
  const mock = mockProvider({ brandName: "Acme", domain: "acme.example" });
  expect(await mock.ask("best plumber")).toEqual(
    await mock.ask("best plumber"),
  );
  expect(availableProviders({})).toEqual(["MOCK"]);
  expect(
    availableProviders({ GEMINI_API_KEY: "x", PERPLEXITY_API_KEY: "y" }),
  ).toEqual(["MOCK", "GEMINI", "PERPLEXITY"]);
});

describe("Perplexity without a key", () => {
  const brand = { brandName: "Acme", domain: "acme.example" };

  test.each([undefined, "", "   "])(
    "key %j → unavailable, no request made",
    (key) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const config = { GEMINI_API_KEY: "g-key", PERPLEXITY_API_KEY: key };
      expect(availableProviders(config)).toEqual(["MOCK", "GEMINI"]);
      let error: unknown;
      try {
        createProvider("PERPLEXITY", config, brand);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        status: "UNAVAILABLE",
        message:
          "Perplexity is not configured. Set PERPLEXITY_API_KEY on the server to enable it.",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    },
  );

  test("Gemini and Mock still work when Perplexity is not configured", () => {
    const config = { GEMINI_API_KEY: "g-key" };
    expect(createProvider("GEMINI", config, brand)).toMatchObject({
      id: "GEMINI",
      searchMode: "WEB_GROUNDED",
    });
    expect(createProvider("MOCK", config, brand).id).toBe("MOCK");
  });

  test("messages name the variable but never a value", () => {
    expect(providerUnavailableMessage("GEMINI")).toBe(
      "Gemini is not configured. Set GEMINI_API_KEY on the server to enable it.",
    );
    expect(providerUnavailableMessage("MOCK")).toBe("Mock is not available.");
  });
});
