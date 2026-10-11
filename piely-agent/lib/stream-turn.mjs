// One assistant turn through pi-ai. Its own file so tests can drive it with
// pi-ai's faux provider: no stdio, no network.
import { buildMessages } from "./message-history.mjs";

/**
 * Streams a single turn and reports what happened.
 *
 * @param {{stream: Function}} models pi-ai models collection
 * @param {object} model the pi-ai model to run
 * @param {object} params
 * @param {string} [params.systemPrompt]
 * @param {Array} params.messages app messages (see buildMessages)
 * @param {Array} [params.tools] pi-ai Tool definitions
 * @param {(event: {type: "chunk"|"tool_call"|"progress", text?: string, toolCall?: object}) => void} [params.onEvent]
 * @param {AbortSignal} [params.signal] aborts the provider request
 * @returns {Promise<{text: string, assistant: unknown, stopReason: string}>}
 */
export async function streamTurn(
  models,
  model,
  { systemPrompt, messages, tools, signal, onEvent = () => {} }
) {
  const context = {
    systemPrompt,
    messages: buildMessages(messages, model),
  };
  if (Array.isArray(tools) && tools.length > 0) {
    context.tools = tools;
  }

  const stream = models.stream(model, context, signal ? { signal } : undefined);
  let text = "";
  let assistant;

  for await (const event of stream) {
    if (event.type === "text_delta") {
      text += event.delta;
      onEvent({ type: "chunk", text: event.delta });
    } else if (event.type === "toolcall_end") {
      // The caller executes the call and feeds the result back for the next
      // turn; partial arguments (toolcall_delta) are deliberately ignored.
      onEvent({ type: "tool_call", toolCall: event.toolCall });
    } else if (event.type === "thinking_delta" || event.type === "toolcall_delta") {
      // Not user-visible text, but proof the turn is alive: a reasoning model
      // can think (or stream a long tool call) for minutes before its first
      // word, and the app treats silence as a stalled provider.
      onEvent({ type: "progress" });
    } else if (event.type === "error") {
      throw new Error(event.error?.errorMessage ?? "Stream failed");
    } else if (event.type === "done") {
      assistant = event.message;
      break;
    }
  }

  return {
    text,
    assistant,
    stopReason: assistant?.stopReason ?? "stop",
  };
}
