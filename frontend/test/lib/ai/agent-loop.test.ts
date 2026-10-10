// The consent gate: a tool that touches the machine runs only after the user
// approves it. This is the one place where "the model can open things" is made
// safe, so it gets a test that fails if the approval is skipped.
import test from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn, type AgentTurnParams } from "../../../src/lib/ai/agent-loop.ts";
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
