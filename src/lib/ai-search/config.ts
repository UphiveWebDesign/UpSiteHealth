import "server-only";
import type { AiSearchProvider } from "@/generated/prisma/enums";
import { serverEnv } from "@/lib/env";
import {
  availableProviders,
  createProvider,
  type SearchProvider,
} from "./providers";

/** Providers configured in this deployment, read from validated env. */
export function configuredProviders(): AiSearchProvider[] {
  return availableProviders(serverEnv());
}

export function providerModel(id: AiSearchProvider): string {
  const env = serverEnv();
  if (id === "GEMINI") return env.GEMINI_MODEL || "gemini-3.8-flash";
  if (id === "PERPLEXITY") return env.PERPLEXITY_PRESET || "fast";
  return "mock-v1";
}

export function makeProvider(
  id: AiSearchProvider,
  brand: { brandName: string; domain: string },
): SearchProvider {
  return createProvider(id, serverEnv(), brand);
}
