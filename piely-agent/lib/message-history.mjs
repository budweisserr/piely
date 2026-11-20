// App messages -> pi-ai messages. Plain {role, content} pairs are rebuilt; turns
// the model produced earlier (assistant blocks, toolResult) are passed through
// untouched, so tool calls and their results survive.

/** Usage block pi-ai expects on a rebuilt assistant message. */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * @param {Array<{role: string, content: unknown}>} raw messages from the app
 * @param {{provider: string, id: string, api: string}} model the turn targets
 */
export function buildMessages(raw, model) {
  const { provider, id: modelId, api } = model;
  let timestamp = Date.now();

  return raw.map((m) => {
    timestamp += 1;

    // Already a pi-ai message: keep it exactly as produced.
    if (m.role === "toolResult") {
      return { timestamp, ...m };
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      return { timestamp, ...m };
    }

    // System messages stay system messages: pi-ai 1.x carries the prompt and
    // the tool list as transcript system messages, and turning one into a user
    // message would change what the model reads.
    if (m.role === "system") {
      return { role: "system", content: m.content, timestamp };
    }

    if (m.role === "assistant") {
      // provider/model/api must name the model this turn targets: pi-ai uses
      // all three to decide whether a message came from the same model. A wrong
      // api makes it treat our own history as another model's. It cannot be a
      // constant: one model id can be served through several APIs.
      return {
        role: "assistant",
        content: [{ type: "text", text: m.content }],
        provider,
        model: modelId,
        api,
        timestamp,
        usage: ZERO_USAGE,
        stopReason: "stop",
      };
    }

    return { role: "user", content: m.content, timestamp };
  });
}
