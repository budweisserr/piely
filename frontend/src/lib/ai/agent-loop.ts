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
import { getPlatform } from "../platform.ts";
import { buildEnhancedSystemPrompt } from "./system-prompt.ts";
import { streamPielyTurn } from "./piely-stream.ts";

const MAX_AGENT_STEPS = 8;

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
  const systemPrompt = `${buildEnhancedSystemPrompt(
    params.systemPrompt
  )} ${TOOL_CALLING_INSTRUCTIONS} The user is on ${getPlatform()}.`;

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    if (signal?.aborted) return;

    const toolCalls: ToolCall[] = [];
    let assistant: unknown = null;

    for await (const event of streamTurn({
      systemPrompt,
      messages,
      tools: COMPUTER_USE_TOOLS,
      signal,
    })) {
      if (event.type === "text") {
        yield { type: "text", text: event.text };
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
    // No tool calls: the model produced its final answer for this turn.
    if (toolCalls.length === 0 || assistant === null) return;

    // Echo the assistant turn back so the provider sees its own tool calls.
    messages.push(assistant);

    for (const call of toolCalls) {
      if (signal?.aborted) return;

      if (isConfirmationTool(call.name)) {
        yield {
          type: "action",
          action: { id: call.id, name: call.name, args: call.arguments },
        };
        const approved = await approveAction({
          id: call.id,
          name: call.name,
          args: call.arguments,
        });
        if (signal?.aborted) return;
        if (!approved) {
          yield {
            type: "activity",
            activity: {
              id: call.id,
              name: call.name,
              args: call.arguments,
              status: "error",
              summary: "Dismissed by the user",
            },
          };
          messages.push(
            toolResultMessage(
              call,
              "The user dismissed this action. Do not retry it; acknowledge and continue.",
              true
            )
          );
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
      messages.push(
        toolResultMessage(call, outcome.text, outcome.isError)
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
