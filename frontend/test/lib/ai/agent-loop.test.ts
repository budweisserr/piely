// The consent gate: a tool that touches the machine runs only after the user
// approves it. This is the one place where "the model can open things" is made
// safe, so it gets a test that fails if the approval is skipped.
import test from "node:test";
import assert from "node:assert/strict";
import {
  runAgentTurn,
  runTextAgentTurn,
  type AgentTurnParams,
  type TextAgentTurnParams,
} from "../../../src/lib/ai/agent-loop.ts";
import type { PielyStreamEvent } from "../../../src/lib/ai/piely-stream.ts";
import type { ToolCall } from "../../../src/lib/tools/tool-definitions.ts";

const call = (name: string, id = "call_1"): ToolCall => ({
  id,
  name,
  arguments: { path: "/tmp/whatever", name: "Firefox" },
});

/**
 * A fake model: one array of tool calls per turn, then a final answer. The loop
 * keeps calling until a turn has no tool calls, so the last entry must be empty.
 */
const turn =
  (sequence: ToolCall[][]): AgentTurnParams["streamTurn"] => {
    let index = 0;
    return async function* () {
      const calls = sequence[index++] ?? [];
      for (const toolCall of calls) {
        yield { type: "toolCall", call: toolCall } as PielyStreamEvent;
      }
      yield {
        type: "done",
        result: {
          text: "done",
          assistant: {
            role: "assistant",
            content: calls.map(() => ({ type: "toolCall" })),
            stopReason: calls.length > 0 ? "toolUse" : "stop",
          },
          stopReason: calls.length > 0 ? "toolUse" : "stop",
        },
      } as PielyStreamEvent;
    };
  };

const executor =
  (seen: ToolCall[]): AgentTurnParams["executeTool"] =>
  async (toolCall) => {
    seen.push(toolCall);
    return { text: "executed", isError: false, summary: "Executed" };
  };

const runText = async (
  params: Partial<TextAgentTurnParams> &
    Pick<TextAgentTurnParams, "streamText" | "executeTool" | "approveAction">
) => {
  const events = [];
  for await (const event of runTextAgentTurn({
    history: [],
    userMessage: "open firefox",
    ...params,
  })) {
    events.push(event);
  }
  return events;
};

const run = async (
  params: Partial<AgentTurnParams> & Pick<AgentTurnParams, "streamTurn" | "executeTool" | "approveAction">
) => {
  const events = [];
  for await (const event of runAgentTurn({
    history: [],
    userMessage: "open firefox",
    ...params,
  })) {
    events.push(event);
  }
  return events;
};

test("a dismissed action is never executed", async () => {
  const seen: ToolCall[] = [];
  const events = await run({
    streamTurn: turn([[call("open_app")], []]),
    executeTool: executor(seen),
    approveAction: async () => false,
  });

  assert.deepEqual(seen, [], "the tool must not run");
  assert.ok(
    events.some(
      (event) =>
        event.type === "activity" &&
        event.activity.status === "error" &&
        /Dismissed/i.test(event.activity.summary ?? "")
    ),
    "the UI says it was dismissed"
  );
  assert.ok(
    events.some((event) => event.type === "action"),
    "the user was asked first"
  );
});

test("an approved action is executed exactly once", async () => {
  const seen: ToolCall[] = [];
  const asked: string[] = [];
  await run({
    streamTurn: turn([[call("open_app")], []]),
    executeTool: executor(seen),
    approveAction: async (action) => {
      asked.push(action.name);
      return true;
    },
  });

  assert.deepEqual(asked, ["open_app"], "one confirmation, for this call");
  assert.deepEqual(
    seen.map((toolCall) => toolCall.name),
    ["open_app"]
  );
});

test("a read-only tool runs without asking", async () => {
  const seen: ToolCall[] = [];
  let asked = 0;
  await run({
    streamTurn: turn([[call("find_files")], []]),
    executeTool: executor(seen),
    approveAction: async () => {
      asked += 1;
      return false;
    },
  });

  assert.equal(asked, 0, "discovery needs no confirmation");
  assert.deepEqual(
    seen.map((toolCall) => toolCall.name),
    ["find_files"]
  );
});

/** A native stream that answers with text only (no tool_call events). */
const textOnlyTurn =
  (answers: string[]): AgentTurnParams["streamTurn"] =>
  async function* () {
    const text = answers.shift() ?? "";
    yield { type: "text", text } as PielyStreamEvent;
    yield {
      type: "done",
      result: {
        text,
        assistant: {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
        },
        stopReason: "stop",
      },
    } as PielyStreamEvent;
  };

/** A text-only model: one canned answer per turn. */
const textTurn =
  (answers: string[]): TextAgentTurnParams["streamText"] =>
  (params) => {
    const answer = answers.shift() ?? "";
    return (async function* () {
      // Stream in pieces: the filter has to cope with split chunks.
      for (const piece of [answer.slice(0, 12), answer.slice(12)]) {
        if (piece) yield piece;
      }
      void params;
    })();
  };

test("a text-only model asks for a tool in a block and gets the result back", async () => {
  const seen: ToolCall[] = [];
  const asked: string[] = [];
  const prompts: string[] = [];
  const script = textTurn([
    'Let me look:\n```tool\n{"name":"find_files","arguments":{"query":"roof"}}\n```',
    "Found it.",
  ]);
  const events = await runText({
    approveAction: async (action) => {
      asked.push(action.name);
      return true;
    },
    executeTool: executor(seen),
    streamText: (params) => {
      prompts.push(params.userMessage);
      return script(params);
    },
  });

  assert.deepEqual(asked, [], "discovery needs no confirmation");
  assert.deepEqual(
    seen.map((call) => call.name),
    ["find_files"]
  );
  const text = events
    .filter((event) => event.type === "text")
    .map((event) => (event as { text: string }).text)
    .join("");
  assert.equal(text, "Let me look:\nFound it.", "the block is not shown");
  assert.match(prompts[1], /TOOL RESULT \(find_files\)/, "the result went back");
});

test("a text-only model cannot write a file the user dismissed", async () => {
  const seen: ToolCall[] = [];
  const prompts: string[] = [];
  const script = textTurn([
    '```tool\n{"name":"write_file","arguments":{"path":"/tmp/a.md","content":"x"}}\n```',
    "Understood.",
  ]);
  const events = await runText({
    approveAction: async () => false,
    executeTool: executor(seen),
    streamText: (params) => {
      prompts.push(params.userMessage);
      return script(params);
    },
  });

  assert.deepEqual(seen, [], "nothing was written");
  assert.ok(
    events.some((event) => event.type === "action"),
    "the user was asked"
  );
  assert.match(prompts[1], /TOOL RESULT \(write_file\) \[failed\]/, "the model learns it failed");
});

test("a pi model that ignores the tool API is understood through the protocol", async () => {
  const seen: ToolCall[] = [];
  const events = await run({
    streamTurn: textOnlyTurn([
      'Let me look.\n```tool\n{"name":"find_files","arguments":{"query":"x"}}\n```',
      "Nothing there.",
    ]),
    executeTool: executor(seen),
    approveAction: async () => true,
  });

  assert.deepEqual(
    seen.map((call) => call.name),
    ["find_files"],
    "the text request was executed"
  );
  const text = events
    .filter((event) => event.type === "text")
    .map((event) => (event as { text: string }).text)
    .join("");
  assert.equal(text, "Let me look.\nNothing there.", "no block in the answer");
});

test("cancelling the turn stops before the next model call", async () => {
  const controller = new AbortController();
  const seen: ToolCall[] = [];
  const events = await run({
    signal: controller.signal,
    streamTurn: turn([[call("open_app")], []]),
    executeTool: executor(seen),
    approveAction: async () => {
      controller.abort();
      return true;
    },
  });

  assert.deepEqual(seen, [], "nothing runs after the user cancels");
  assert.equal(
    events.some((event) => event.type === "text"),
    false,
    "no further turn was started"
  );
});
