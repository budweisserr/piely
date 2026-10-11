/**
 * The one place that decides how a turn is answered: the tool loop when the pi
 * sidecar is selected, a plain stream otherwise. Both chat surfaces use it.
 */
import { fetchAIResponse } from "./answer-stream.ts";
import { runAgentTurn, runTextAgentTurn } from "./agent-loop.ts";
import type { AgentActivity, PendingToolAction } from "./agent-loop.ts";
import { shouldUsePiely } from "./piely-selection.ts";
import type { Message, TYPE_PROVIDER } from "@/types";

export interface ChatTarget {
  usePiely: boolean;
  provider?: TYPE_PROVIDER;
}

/** Resolves which backend answers this turn, or throws a user-facing error. */
export const resolveChatTarget = (
  selectedAIProvider: { provider: string; variables: Record<string, string> },
  allAiProviders: TYPE_PROVIDER[]
): ChatTarget => {
  const usePiely = shouldUsePiely();
  if (!selectedAIProvider.provider && !usePiely) {
    throw new Error("Please select an AI provider in settings");
  }

  const provider = allAiProviders.find(
    (p) => p.id === selectedAIProvider.provider
  );
  if (!provider && !usePiely) {
    throw new Error("Invalid provider selected");
  }

  return { usePiely, provider };
};

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "activity"; activity: AgentActivity };

/** Streams one turn, with tool activity when the agent loop is in use. */
export async function* streamChat(params: {
  target: ChatTarget;
  selectedProvider: { provider: string; variables: Record<string, string> };
  systemPrompt?: string;
  history: Message[];
  userMessage: string;
  images: { data: string; mimeType: string }[];
  signal?: AbortSignal;
  toolCallingEnabled: boolean;
  approveAction: (action: PendingToolAction) => Promise<boolean>;
}): AsyncIterable<ChatStreamEvent> {
  const {
    target,
    selectedProvider,
    systemPrompt,
    history,
    userMessage,
    images,
    signal,
    toolCallingEnabled,
    approveAction,
  } = params;

  if (toolCallingEnabled && target.usePiely) {
    // Computer use: one user turn can span several model round-trips.
    for await (const event of runAgentTurn({
      systemPrompt,
      history,
      userMessage,
      images,
      signal,
      approveAction,
    })) {
      if (event.type === "text" || event.type === "activity") {
        yield event;
      }
    }
    return;
  }

  if (toolCallingEnabled) {
    // A curl provider has no tool API, so the model asks in text and the result
    // comes back as the next user message (see tools/tool-protocol.ts).
    for await (const event of runTextAgentTurn({
      systemPrompt,
      history,
      userMessage,
      images,
      signal,
      approveAction,
      streamText: (turn) =>
        fetchAIResponse({
          provider: target.provider,
          selectedProvider,
          systemPrompt: turn.systemPrompt,
          history: turn.history as Message[],
          userMessage: turn.userMessage,
          images: turn.images,
          signal: turn.signal,
        }),
    })) {
      if (event.type === "text" || event.type === "activity") {
        yield event;
      }
    }
    return;
  }

  for await (const chunk of fetchAIResponse({
    provider: target.usePiely ? undefined : target.provider,
    selectedProvider,
    systemPrompt,
    history,
    userMessage,
    images,
    signal,
  })) {
    yield { type: "text", text: chunk };
  }
}
