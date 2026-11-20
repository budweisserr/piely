/**
 * The computer-use loop: the model asks for a tool, we run it, the result goes
 * back, until the model answers. Read-only tools run straight away; opening
 * files and apps waits for the user's OK.
 */
import {
  COMPUTER_USE_TOOLS,
  isConfirmationTool,
  TOOL_CALLING_INSTRUCTIONS,
} from "../tools/tool-definitions.ts";
import type { ToolCall } from "../tools/tool-definitions.ts";
import { runToolCall } from "../tools/tool-executor.ts";
import {
  TOOL_PROTOCOL_INSTRUCTIONS,
  ToolProtocolFilter,
  toolResultText,
} from "../tools/tool-protocol.ts";
import type { ToolRequest } from "../tools/tool-protocol.ts";
import { explainProviderError } from "./provider-errors.ts";
import { getPlatform } from "../platform.ts";
import { buildEnhancedSystemPrompt } from "./system-prompt.ts";
import { streamPielyTurn } from "./piely-stream.ts";

/** How many tool round-trips one user turn may take. */
const MAX_AGENT_STEPS = 15;

export interface AgentActivity {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  summary?: string;
}

/** Replaces a tool activity in place, or appends it when first seen. */
export const upsertActivity = (
  activities: AgentActivity[],
  activity: AgentActivity
): AgentActivity[] => {
  const index = activities.findIndex((entry) => entry.id === activity.id);
  if (index === -1) {
    return [...activities, activity];
  }
  const next = [...activities];
  next[index] = activity;
  return next;
};

export interface PendingToolAction {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "activity"; activity: AgentActivity }
  | { type: "action"; action: PendingToolAction }
  | { type: "done" };

export interface AgentTurnParams {
  systemPrompt?: string;
  history: { role: string; content: unknown }[];
  userMessage: string;
  images?: { data: string; mimeType: string }[];
  signal?: AbortSignal;
  /** Resolves once the user approves or dismisses a proposed action. */
  approveAction: (action: PendingToolAction) => Promise<boolean>;
  /** For tests: swap the model and the executor. The app never passes these. */
  streamTurn?: typeof streamPielyTurn;
  executeTool?: typeof runToolCall;
}

/** Builds the pi-ai message for the current user turn (text + images). */
const buildUserMessage = (
  userMessage: string,
  images: { data: string; mimeType: string }[]
) => {
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
  return {
    role: "user",
    content: content.length === 1 ? userMessage : content,
  };
};

const toolResultMessage = (
  call: ToolCall,
  text: string,
  isError: boolean
) => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text }],
  isError,
  timestamp: Date.now(),
});

/**
 * Runs a stream, turning a provider failure into a sentence the user can act
 * on. Both loops go through here, so an error reads the same either way.
 */
async function* explained<Params, Event>(
  stream: (params: Params) => AsyncIterable<Event>,
  params: Params
): AsyncIterable<Event> {
  try {
    yield* stream(params);
  } catch (error) {
    throw new Error(
      explainProviderError(
        error instanceof Error ? error.message : String(error)
      )
    );
  }
}

/** The prompt both agent loops run with: tools plus the text fallback. */
const toolSystemPrompt = (base?: string): string =>
  `${buildEnhancedSystemPrompt(base)} ${TOOL_CALLING_INSTRUCTIONS} ${TOOL_PROTOCOL_INSTRUCTIONS} The user is on ${getPlatform()}.`;

/** One user turn: streamed text, tool activity, and pending approvals. */
export async function* runAgentTurn(
  params: AgentTurnParams
): AsyncIterable<AgentEvent> {
  const {
    history,
    userMessage,
    images = [],
    signal,
    approveAction,
    streamTurn = streamPielyTurn,
    executeTool = runToolCall,
  } = params;

  const messages: unknown[] = [
    ...history.map((msg) => ({ role: msg.role, content: msg.content })),
    buildUserMessage(userMessage, images),
  ];
  const systemPrompt = toolSystemPrompt(params.systemPrompt);

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    if (signal?.aborted) return;

    const toolCalls: ToolCall[] = [];
    // A model that ignores the native tool API may still ask in text; the same
    // filter both hides that block from the user and turns it into a call.
    const filter = new ToolProtocolFilter();
    const textRequests: ToolRequest[] = [];
    let assistant: unknown = null;

    for await (const event of explained(streamTurn, {
      systemPrompt,
      messages,
      tools: COMPUTER_USE_TOOLS,
      signal,
    })) {
      if (event.type === "text") {
        const part = filter.push(event.text);
        if (part.text) yield { type: "text", text: part.text };
        textRequests.push(...part.requests);
      } else if (event.type === "toolCall") {
        toolCalls.push(event.call);
        yield {
          type: "activity",
          activity: {
            id: event.call.id,
            name: event.call.name,
            args: event.call.arguments,
            status: "running",
          },
        };
      } else {
        assistant = event.result.assistant;
      }
    }

    if (signal?.aborted) return;
    const tail = filter.flush();
    if (tail.text) yield { type: "text", text: tail.text };
    textRequests.push(...tail.requests);

    const calls: ToolCall[] =
      toolCalls.length > 0
        ? toolCalls
        : textRequests.map((request, index) => ({
            id: `text_${step}_${index}`,
            name: request.name,
            arguments: request.arguments,
          }));

    // No tool calls: the model produced its final answer for this turn.
    if (calls.length === 0 || assistant === null) return;

    // Echo the assistant turn back so the provider sees its own tool calls.
    messages.push(assistant);

    const results = yield* executeToolCalls(calls, {
      approveAction,
      executeTool,
      signal,
    });
    for (const result of results) {
      messages.push(
        toolResultMessage(result.call, result.text, result.isError)
      );
    }
  }

  // Out of steps: say so rather than ending on silence, which looks like the
  // answer was cut off.
  yield {
    type: "text",
    text: `Stopped after ${MAX_AGENT_STEPS} tool steps without a final answer.`,
  };
  yield { type: "done" };
}

interface ToolRunContext {
  approveAction: (action: PendingToolAction) => Promise<boolean>;
  executeTool: typeof runToolCall;
  signal?: AbortSignal;
}

interface ToolRunResult {
  call: ToolCall;
  text: string;
  isError: boolean;
}

/** The result a model gets when the user refuses: stop asking, move on. */
const DISMISSED =
  "The user dismissed this action. Do not retry it; acknowledge and continue.";

/**
 * Runs tool calls in order, asking the user first for the ones that change
 * anything. Shared by the native loop and the text-protocol loop so the consent
 * gate cannot differ between them. Returns one result per call, to be fed back
 * in the shape the running model understands.
 */
async function* executeToolCalls(
  calls: ToolCall[],
  { approveAction, executeTool, signal }: ToolRunContext
): AsyncGenerator<AgentEvent, ToolRunResult[], void> {
  const results: ToolRunResult[] = [];

  for (const call of calls) {
    if (signal?.aborted) return results;

    if (isConfirmationTool(call.name)) {
      const action = {
        id: call.id,
        name: call.name,
        args: call.arguments,
      };
      yield { type: "action", action };
      const approved = await approveAction(action);
      if (signal?.aborted) return results;
      if (!approved) {
        yield {
          type: "activity",
          activity: { ...action, status: "error", summary: "Dismissed by the user" },
        };
        results.push({ call, text: DISMISSED, isError: true });
        continue;
      }
    }

    const outcome = await executeTool(call);
    yield {
      type: "activity",
      activity: {
        id: call.id,
        name: call.name,
        args: call.arguments,
        status: outcome.isError ? "error" : "done",
        summary: outcome.summary,
      },
    };
    results.push({ call, text: outcome.text, isError: outcome.isError });
  }

  return results;
}

/** Streams plain text for one turn; provided by the caller, never by the app. */
export type TextTurnStream = (params: {
  systemPrompt: string;
  history: { role: string; content: unknown }[];
  userMessage: string;
  images: { data: string; mimeType: string }[];
  signal?: AbortSignal;
}) => AsyncIterable<string>;

export interface TextAgentTurnParams {
  systemPrompt?: string;
  history: { role: string; content: unknown }[];
  userMessage: string;
  /** Images attached to the user's turn; only the first turn carries them. */
  images?: { data: string; mimeType: string }[];
  signal?: AbortSignal;
  approveAction: (action: PendingToolAction) => Promise<boolean>;
  /** How a turn is streamed when the model has no native tool support. */
  streamText: TextTurnStream;
  /** For tests. */
  executeTool?: typeof runToolCall;
}

/**
 * The same loop for models that can only produce text: their tool request comes
 * back as a ```tool block instead of a native call, and the result is sent as
 * the next user message.
 */
export async function* runTextAgentTurn(
  params: TextAgentTurnParams
): AsyncIterable<AgentEvent> {
  const {
    history,
    userMessage,
    images = [],
    signal,
    approveAction,
    streamText,
    executeTool = runToolCall,
  } = params;

  const systemPrompt = toolSystemPrompt(params.systemPrompt);
  const messages: { role: string; content: unknown }[] = [...history];
  let turnInput = userMessage;

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    if (signal?.aborted) return;

    const filter = new ToolProtocolFilter();
    const requests: ToolRequest[] = [];
    let assistantText = "";

    const emit = function* (part: { text: string; requests: ToolRequest[] }) {
      if (part.text) {
        assistantText += part.text;
        yield { type: "text", text: part.text } as AgentEvent;
      }
      requests.push(...part.requests);
    };

    for await (const chunk of explained(streamText, {
      systemPrompt,
      history: messages,
      userMessage: turnInput,
      images: step === 0 ? images : [],
      signal,
    })) {
      yield* emit(filter.push(chunk));
    }
    if (signal?.aborted) return;
    yield* emit(filter.flush());

    // No tool request in the answer: that was the final answer.
    if (requests.length === 0) return;

    // Keep what the model said, then answer with the tool results.
    messages.push({ role: "assistant", content: assistantText });

    const calls: ToolCall[] = requests.map((request, index) => ({
      id: `text_${step}_${index}`,
      name: request.name,
      arguments: request.arguments,
    }));
    const results = yield* executeToolCalls(calls, {
      approveAction,
      executeTool,
      signal,
    });
    if (signal?.aborted) return;

    turnInput = results
      .map((result) =>
        toolResultText(result.call.name, {
          text: result.text,
          isError: result.isError,
          summary: "",
        })
      )
      .join("\n");
  }

  yield {
    type: "text",
    text: `Stopped after ${MAX_AGENT_STEPS} tool steps without a final answer.`,
  };
  yield { type: "done" };
}
