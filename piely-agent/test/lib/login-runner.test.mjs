// A login must stay cancellable while it runs: closing the dialog has to abort
// the flow, not just hide the prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { createLoginRunner } from "../../lib/login-runner.mjs";

test("cancel aborts the flow, not just the visible prompt", async () => {
  const runner = createLoginRunner({
    send: () => {},
    answerResolvers: new Map(),
  });

  let aborted = false;
  const models = {
    // Stands in for a flow that is polling or waiting on its callback server:
    // it only settles when the interaction signal aborts.
    login: (_provider, _type, interaction) =>
      new Promise((_resolve, reject) => {
        interaction.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
  };

  const login = runner.login({
    models,
    provider: "anthropic",
    type: "oauth",
    requestId: 7,
  });
  runner.cancel();

  await assert.rejects(login, /aborted/);
  assert.equal(aborted, true, "the flow must be told to stop, not just abandoned");
}, { timeout: 5000 });

test("cancel releases a prompt that is already on screen", async () => {
  const answerResolvers = new Map();
  const runner = createLoginRunner({ send: () => {}, answerResolvers });
  const models = {
    login: (_provider, _type, interaction) =>
      interaction.prompt({ type: "select", message: "pick", options: [] }),
  };

  const login = runner.login({
    models,
    provider: "anthropic",
    type: "oauth",
    requestId: 8,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(answerResolvers.size, 1, "prompt is waiting for an answer");

  runner.cancel();
  await login;
  assert.equal(answerResolvers.size, 0, "no answer stays pending after cancel");
}, { timeout: 5000 });
