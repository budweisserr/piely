// Drives the real sidecar over stdio: the Rust bridge closes the dialog and
// sends `cancel_login`, and the login has to settle instead of hanging.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = fileURLToPath(new URL("../agent.mjs", import.meta.url));

const startAgent = () => {
  const authFile = join(mkdtempSync(join(tmpdir(), "piely-login-")), "auth.json");
  const child = spawn(process.execPath, [AGENT, "--auth-file", authFile], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const messages = [];
  const waiters = [];
  let buffered = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (const waiter of [...waiters]) waiter(message);
    }
  });

  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    /** Resolves with the first message (past or future) matching `match`. */
    expect: (match, description, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const found = messages.find(match);
        if (found) return resolve(found);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `${description}: timed out. Got: ${JSON.stringify(messages)}`
            )
          );
        }, timeoutMs);
        const waiter = (message) => {
          if (!match(message)) return;
          clearTimeout(timer);
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(message);
        };
        waiters.push(waiter);
      }),
    stop: () => child.kill(),
  };
};

test("cancel_login settles an interactive login instead of leaving it hanging", async () => {
  const agent = startAgent();
  try {
    // anthropic's flow opens with a local "select login method" prompt, so no
    // network or browser is involved.
    agent.send({ id: 1, cmd: "login", provider: "anthropic", type: "oauth" });
    const prompt = await agent.expect(
      (m) => m.id === 1 && m.type === "prompt",
      "login prompt"
    );
    assert.equal(prompt.prompt.type, "select");

    agent.send({ id: 2, cmd: "cancel_login" });
    await agent.expect(
      (m) => m.id === 2 && m.type === "done",
      "cancel acknowledgement"
    );

    // The login must reach a terminal state now. Before the fix it stayed
    // pending forever, which is what made the next attempt look "in progress".
    const terminal = await agent.expect(
      (m) => m.id === 1 && (m.type === "error" || m.type === "done"),
      "login settles after cancel"
    );
    assert.equal(terminal.id, 1);
  } finally {
    agent.stop();
  }
});

test("a login still works after a cancelled one", async () => {
  const agent = startAgent();
  try {
    agent.send({ id: 1, cmd: "login", provider: "anthropic", type: "oauth" });
    await agent.expect((m) => m.id === 1 && m.type === "prompt", "first prompt");
    agent.send({ id: 2, cmd: "cancel_login" });
    await agent.expect(
      (m) => m.id === 1 && (m.type === "error" || m.type === "done"),
      "first login settles"
    );

    // The retry must prompt again rather than being refused.
    agent.send({ id: 3, cmd: "login", provider: "anthropic", type: "oauth" });
    const retry = await agent.expect(
      (m) => m.id === 3 && m.type === "prompt",
      "retry prompt"
    );
    assert.equal(retry.prompt.type, "select");
  } finally {
    agent.stop();
  }
}, { timeout: 5000 });
