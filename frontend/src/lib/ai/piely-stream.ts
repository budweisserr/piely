/**
 * One turn through the piely-agent sidecar. Each call gets its own channel, so
 * two windows streaming at once cannot mix; cancelling stops the sidecar too,
 * instead of leaving it generating in the background.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Message } from "@/types";
import type { ToolCall, ToolDefinition } from "../tools/tool-definitions.ts";
import { CHUNK_POLL_INTERVAL_MS } from "../chat/constants.ts";
import { getPielySelection } from "./piely-selection.ts";

// --- pi (piely-agent sidecar) streaming ---------------------------------------

export interface PielyTurnResult {
  text: string;
  /** Full pi-ai assistant message; needed to continue after a tool call. */
  assistant: unknown | null;
  stopReason: string;
}

export type PielyStreamEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "done"; result: PielyTurnResult };

/** Messages the Rust side pushes through the per-invocation stream channel. */
type PielyStreamMessage =
  | { type: "chunk"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  // Thinking / tool-argument deltas: nothing to show, but the turn is alive.
  | { type: "progress" };

const parseTurnResult = (payload: string): PielyTurnResult => {
  const parsed = JSON.parse(payload) as {
    message?: unknown;
    assistant?: unknown;
    stopReason?: unknown;
  };
  return {
    text: typeof parsed.message === "string" ? parsed.message : "",
    assistant: parsed.assistant ?? null,
    stopReason:
      typeof parsed.stopReason === "string" ? parsed.stopReason : "stop",
  };
};

/** Stops the sidecar's request too, not just this loop. */
const cancelPielyStream = (streamId: string): void => {
  void invoke("piely_cancel_stream", { streamId }).catch(() => {
    // Already finished, or the agent is gone: nothing left to abort.
  });
};

/**
 * Text deltas, finished tool calls, and the final assistant message. The
 * channel belongs to this call only, so nothing leaks in from another stream.
 */
export async function* streamPielyTurn(params: {
  systemPrompt?: string;
  messages: unknown[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}): AsyncIterable<PielyStreamEvent> {
  const { systemPrompt, messages, tools, signal } = params;
  if (signal?.aborted) return;

  const piely = getPielySelection();
  if (!piely) {
    throw new Error(
      "No pi provider selected. Log in to a provider and pick a model in the Dashboard."
    );
  }

  const chunks: string[] = [];
  const toolCalls: ToolCall[] = [];
  let failure: unknown = null;
  let invokeDone = false;
  // Named by the caller (Rust only knows it as a number) so `cancel` can abort
  // this stream and no other window's.
  const streamId = crypto.randomUUID();

  const channel = new Channel<PielyStreamMessage>((message) => {
    if (message.type === "chunk") {
      chunks.push(message.text);
    } else if (message.type === "tool_call") {
      toolCalls.push(message.toolCall);
    }
  });

  const request = invoke<string>("piely_chat_stream", {
    provider: piely.provider,
    model: piely.model.id,
    systemPrompt,
    messages: JSON.stringify(messages),
    tools: tools && tools.length > 0 ? JSON.stringify(tools) : null,
    streamId,
    onEvent: channel,
  })
    .catch((error: unknown) => {
      failure = error;
      return "";
    })
    .finally(() => {
      invokeDone = true;
    });

  let lastText = 0;
  let lastToolCall = 0;
  const drain = (): PielyStreamEvent[] => {
    const events: PielyStreamEvent[] = [];
    for (; lastText < chunks.length; lastText += 1) {
      events.push({ type: "text", text: chunks[lastText] });
    }
    for (; lastToolCall < toolCalls.length; lastToolCall += 1) {
      events.push({ type: "toolCall", call: toolCalls[lastToolCall] });
    }
    return events;
  };

  while (!invokeDone) {
    if (signal?.aborted) {
      cancelPielyStream(streamId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CHUNK_POLL_INTERVAL_MS));
    if (signal?.aborted) {
      cancelPielyStream(streamId);
      return;
    }
    for (const event of drain()) yield event;
  }

  const result = await request;
  if (signal?.aborted) return;
  if (failure) {
    throw failure instanceof Error ? failure : new Error(String(failure));
  }

  // One more tick: the tail of the stream is sent through the channel right
  // before the command resolves, so it may still be in flight.
  await new Promise((resolve) => setTimeout(resolve, CHUNK_POLL_INTERVAL_MS));
  for (const event of drain()) yield event;

  yield { type: "done", result: parseTurnResult(result) };
}

export async function* fetchPielyResponse(params: {
  systemPrompt?: string;
  userMessage: string;
  images?: { data: string; mimeType: string }[];
  history?: Message[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  try {
    const {
      systemPrompt,
      userMessage,
      images = [],
      history = [],
      signal,
    } = params;

    if (signal?.aborted) return;

    // Build pi-ai messages: history as-is, current turn with image parts.
    const messages: { role: string; content: unknown }[] = history.map(
      (msg) => ({ role: msg.role, content: msg.content })
    );
    const content: { type: string; [key: string]: unknown }[] = [
      { type: "text", text: userMessage },
    ];
    for (const image of images) {
      content.push({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      });
    }
    messages.push({
      role: "user",
      content: content.length === 1 ? content[0].text : content,
    });

    for await (const event of streamPielyTurn({
      systemPrompt,
      messages,
      signal,
    })) {
      if (event.type === "text") {
        yield event.text;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    yield `Pi error: ${errorMessage}`;
  }
}
