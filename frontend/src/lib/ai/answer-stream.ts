/**
 * Which source answers one request: the pi sidecar when the user logged in
 * there and picked a model, otherwise the selected curl provider.
 */
import type { Message, TYPE_PROVIDER } from "@/types";

import { shouldUsePiely } from "./piely-selection.ts";
import { buildEnhancedSystemPrompt } from "./system-prompt.ts";
import { fetchPielyResponse } from "./piely-stream.ts";
import { fetchCurlProviderResponse } from "./curl-provider.ts";

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  images?: { data: string; mimeType: string }[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  try {
    const { provider, selectedProvider, systemPrompt, signal } = params;

    // Check if already aborted
    if (signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(systemPrompt);

    // Check if we should use pi (login + providers) instead of curl providers
    if (shouldUsePiely()) {
      yield* fetchPielyResponse({
        systemPrompt: enhancedSystemPrompt,
        userMessage: params.userMessage,
        images: params.images ?? [],
        history: params.history ?? [],
        signal,
      });
      return;
    }
    if (!provider) {
      throw new Error(`Provider not provided`);
    }

    yield* fetchCurlProviderResponse({
      provider,
      selectedProvider,
      systemPrompt: enhancedSystemPrompt,
      history: params.history ?? [],
      userMessage: params.userMessage,
      images: params.images ?? [],
      signal,
    });
  } catch (error) {
    throw new Error(
      `Error in fetchAIResponse: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}
