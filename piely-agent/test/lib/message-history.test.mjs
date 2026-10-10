// Tests the sidecar's message contract and tool-call relay against pi-ai's
// faux provider: no network, no credentials, no stdio.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { buildMessages } from "../../lib/message-history.mjs";
import { streamTurn } from "../../lib/stream-turn.mjs";

// Same shape as the computer-use tools the app sends.
const TOOLS = [
  {
    name: "find_files",
    description: "Search the user's local files by file name.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const toolResult = (call, text) => ({
  role: "toolResult",
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: Date.now(),
});

test("rebuilt history carries the target model's api, not a hard-coded one", () => {
  // opencode serves one model id through four different APIs, so the api of the
  // message has to come from the model being called.
  const model = {
    provider: "opencode",
    id: "big-pickle",
    api: "openai-completions",
  };

  const [, assistant] = buildMessages(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    model
  );

  assert.equal(assistant.api, "openai-completions");
  assert.equal(assistant.provider, "opencode");
  assert.equal(assistant.model, "big-pickle");
  assert.equal(assistant.stopReason, "stop");
});

test("assistant turns and tool results from the previous turn pass through", () => {
  const model = {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    api: "anthropic-messages",
  };
  const assistantTurn = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_1", name: "find_files", arguments: {} },
    ],
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    api: "anthropic-messages",
    stopReason: "toolUse",
    timestamp: 1,
  };

  const [assistant, result] = buildMessages(
    [assistantTurn, toolResult({ id: "call_1", name: "find_files" }, "[]")],
    model
  );

  assert.equal(assistant.content[0].id, "call_1");
  assert.equal(assistant.content[0].name, "find_files");
  assert.equal(assistant.stopReason, "toolUse");
  assert.equal(result.role, "toolResult");
  assert.equal(result.toolCallId, "call_1");
});

test("system messages are not rewritten into user messages", () => {
  const [system] = buildMessages(
    [{ role: "system", content: "be terse" }],
    { provider: "opencode", id: "big-pickle", api: "openai-completions" }
  );

  assert.equal(system.role, "system");
  assert.equal(system.content, "be terse");
});

test("a tool call survives the round trip the app performs", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();

  const events = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("find_files", { query: "budget" })], {
      stopReason: "toolUse",
    }),
  ]);

  const first = await streamTurn(models, model, {
    systemPrompt: "You can search the user's files.",
    messages: [{ role: "user", content: "find my budget file" }],
    tools: TOOLS,
    onEvent: (event) => events.push(event),
  });

  assert.equal(first.stopReason, "toolUse");
  const call = first.assistant.content.find((block) => block.type === "toolCall");
  assert.ok(call, "assistant turn must carry the tool call");
  assert.deepEqual(
    events.filter((event) => event.type === "tool_call").map((event) => event.toolCall.name),
    ["find_files"]
  );

  // Exactly what the app sends back for the next step: the verbatim assistant
  // turn plus the tool result.
  faux.setResponses([fauxAssistantMessage([fauxText("Nothing found.")])]);
  const second = await streamTurn(models, model, {
    systemPrompt: "You can search the user's files.",
    messages: [
      { role: "user", content: "find my budget file" },
      first.assistant,
      toolResult(call, "[]"),
    ],
    tools: TOOLS,
  });

  assert.equal(second.text, "Nothing found.");
  assert.equal(second.stopReason, "stop");
  assert.equal(faux.state.callCount, 2);
});
