// `cancel_stream` relies on the abort signal reaching the provider request:
// without it the aborted turn keeps generating (and billing) in the sidecar.
// This drives streamTurn with a provider that only ends when it is aborted.
import test from "node:test";
import assert from "node:assert/strict";
import { streamTurn } from "../../lib/stream-turn.mjs";

const MODEL = { provider: "test", id: "test-model", api: "test-api" };

const fakeModels = (seen) => ({
  stream(model, context, options) {
    seen.model = model;
    seen.options = options;
    const signal = options?.signal;
    return (async function* () {
      yield { type: "text_delta", delta: "Hel" };
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", resolve, { once: true });
      });
      yield {
        type: "error",
        reason: "aborted",
        error: { errorMessage: "Request aborted" },
      };
    })();
  },
});

test("an aborted turn stops at the provider instead of running to the end", async () => {
  const seen = {};
  const controller = new AbortController();
  const events = [];

  const turn = streamTurn(fakeModels(seen), MODEL, {
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });

  controller.abort();
  await assert.rejects(turn, /aborted/i);

  assert.equal(seen.options?.signal, controller.signal, "signal reaches the provider");
  assert.equal(events[0].type, "chunk");
  assert.equal(events[0].text, "Hel", "text already sent stays sent");
});

test("no signal still streams normally", async () => {
  const models = {
    stream: () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "text_delta", delta: "ok" };
        yield { type: "done", message: { stopReason: "stop" } };
      },
    }),
  };

  const turn = await streamTurn(models, MODEL, {
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(turn.text, "ok");
  assert.equal(turn.stopReason, "stop");
});

test("thinking and tool-argument deltas are reported as progress, not as text", async () => {
  // A reasoning model can be silent for minutes of thinking: without these
  // keep-alives the idle timeout would abandon a turn that is working.
  const models = {
    stream: () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "thinking_delta", delta: "let me think" };
        yield { type: "toolcall_delta", delta: '{"qu' };
        yield { type: "text_delta", delta: "answer" };
        yield { type: "done", message: { stopReason: "stop" } };
      },
    }),
  };

  const events = [];
  const turn = await streamTurn(models, MODEL, {
    messages: [{ role: "user", content: "hi" }],
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["progress", "progress", "chunk"]
  );
  assert.equal(turn.text, "answer", "thinking is not shown to the user");
});
