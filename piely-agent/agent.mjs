// Piely sidecar: bridges @earendil-works/pi-ai to the Tauri app over NDJSON on
// stdio. One JSON command per line in, one JSON message per line out:
//
//   in : {"id":1,"cmd":"list"|"models"|"login"|"logout"|"stream", ...}
//   in : {"id":2,"cmd":"cancel_stream","streamId":1}
//   in : {"id":1,"type":"answer","value":"..."}          (reply to a prompt)
//   out: {"id":1,"type":"providers"|"models"|"prompt"|"notify"|"chunk", ...}
//   out: {"id":1,"type":"tool_call","toolCall":{"id","name","arguments"}}
//   out: {"id":1,"type":"done","message":"<text>","assistant":{...},"stopReason":"..."}
//   out: {"id":1,"type":"error","message":"..."}
//
// `stream` takes optional `tools` and returns the final assistant message, so
// the caller can send it back with its tool results for the next turn.
// `cancel_stream` aborts the stream with that `streamId`.
//
// Credentials go to --auth-file, in pi's auth.json shape.
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { buildMessages } from "./lib/message-history.mjs";
import { streamTurn } from "./lib/stream-turn.mjs";
import { createLoginRunner } from "./lib/login-runner.mjs";
import { FileCredentialStore } from "./lib/credential-store.mjs";

// pi-ai hides its OAuth flows behind a variable specifier so bundlers cannot
// follow them into Node-only code. A compiled binary then has no such file, so
// the bundled copies are registered here instead. Harmless under plain node.
registerBunOAuthFlows();

const args = process.argv.slice(2);
const authFlag = args.indexOf("--auth-file");
const authPath = authFlag !== -1 ? args[authFlag + 1] : "auth.json";

const store = new FileCredentialStore(authPath);
const models = builtinModels({ credentials: store });

/// Running streams by request id, so `cancel_stream` can abort one of them.
const streamControllers = new Map();

// --- stdin routing ------------------------------------------------------------
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const answerResolvers = new Map(); // request id -> resolve(value)
const loginRunner = createLoginRunner({ send, answerResolvers });

function send(msg) {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    process.exit(0); // parent (Rust side) gone
  }
}
process.stdout.on("error", () => process.exit(0));

function answerFor(id, value) {
  const resolve = answerResolvers.get(id);
  if (resolve) {
    answerResolvers.delete(id);
    resolve(value);
  }
}

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "answer") {
    answerFor(msg.id, msg.value);
  } else {
    void handle(msg).catch((err) => {
      send({ id: msg.id, type: "error", message: String(err?.message ?? err) });
    });
  }
});

// --- commands ------------------------------------------------------------------
async function handle(msg) {
  switch (msg.cmd) {
    case "list": {
      const loggedIn = new Set((await store.list()).map((c) => c.providerId));
      send({
        id: msg.id,
        type: "providers",
        providers: models.getProviders().map((p) => ({
          id: p.id,
          name: p.name,
          loggedIn: loggedIn.has(p.id),
          auth: [
            ...(p.auth.oauth ? ["oauth"] : []),
            ...(p.auth.apiKey?.login ? ["api_key"] : []),
          ],
        })),
      });
      send({ id: msg.id, type: "done" });
      break;
    }
    case "models": {
      // Let pi refresh any dynamic provider catalogs, then apply provider-owned
      // availability rules (for example, an account-specific Copilot model
      // picker) instead of exposing the static catalog directly.
      await models.refresh();
      const providerModels = await models.getAvailable(msg.provider);
      send({
        id: msg.id,
        type: "models",
        models: providerModels
          .filter((m) => m.input?.includes("text"))
          .map((m) => ({ id: m.id, name: m.name, input: m.input ?? [] })),
      });
      send({ id: msg.id, type: "done" });
      break;
    }
    case "login": {
      await loginRunner.login({
        models,
        provider: msg.provider,
        type: msg.type,
        requestId: msg.id,
      });
      send({ id: msg.id, type: "done" });
      break;
    }
    case "cancel_login": {
      loginRunner.cancel();
      send({ id: msg.id, type: "done" });
      break;
    }
    case "logout": {
      await models.logout(msg.provider);
      send({ id: msg.id, type: "done" });
      break;
    }
    case "stream": {
      const model = (await models.getAvailable(msg.provider)).find(
        (candidate) => candidate.id === msg.model
      );
      if (!model) {
        send({ id: msg.id, type: "error", message: `Unknown or unavailable model ${msg.provider}/${msg.model}` });
        break;
      }
      // One controller per stream: `cancel_stream` aborts just this request, so
      // a cancelled turn stops costing tokens instead of running to the end.
      const controller = new AbortController();
      streamControllers.set(msg.id, controller);
      try {
        const turn = await streamTurn(models, model, {
          systemPrompt: msg.systemPrompt,
          messages: msg.messages,
          tools: msg.tools,
          signal: controller.signal,
          onEvent: (event) => send({ id: msg.id, ...event }),
        });
        send({
          id: msg.id,
          type: "done",
          message: turn.text,
          assistant: turn.assistant,
          stopReason: turn.stopReason,
        });
      } finally {
        streamControllers.delete(msg.id);
      }
      break;
    }
    case "cancel_stream": {
      // Aborting makes the running stream finish (with an error message), which
      // resolves the stream's own request on the Rust side.
      const controller = streamControllers.get(msg.streamId);
      streamControllers.delete(msg.streamId);
      controller?.abort();
      send({ id: msg.id, type: "done" });
      break;
    }
    default:
      send({ id: msg.id, type: "error", message: `Unknown command: ${msg.cmd}` });
  }
}

// --- self check -----------------------------------------------------------------
// Runs inside the compiled binary, so it must not depend on the test files.
if (process.argv.includes("--selfcheck")) {
  const providers = builtinProviders();
  if (!providers.some((p) => p.id === "anthropic") || !providers.some((p) => p.id === "google")) {
    console.error("selfcheck failed: expected builtin providers");
    process.exit(1);
  }

  // Providers such as opencode re-serve one model id through several APIs, so a
  // rebuilt history message must carry the api of the model being called.
  const model = { provider: "opencode", id: "big-pickle", api: "openai-completions" };
  const history = buildMessages(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: [{ type: "text", text: "x" }] },
    ],
    model
  );
  if (
    history.length !== 3 ||
    history[1].role !== "assistant" ||
    history[1].api !== model.api ||
    history[1].provider !== model.provider ||
    history[1].model !== model.id ||
    history[1].stopReason !== "stop"
  ) {
    console.error("selfcheck failed: message conversion");
    process.exit(1);
  }

  // Tool turns echo the assistant message back together with toolResult
  // messages; both must survive the conversion untouched.
  const assistantTurn = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "find_files", arguments: { query: "x" } }],
    provider: model.provider,
    model: model.id,
    api: model.api,
    stopReason: "toolUse",
    timestamp: 1,
  };
  const toolOutput = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "find_files",
    content: [{ type: "text", text: "[]" }],
    isError: false,
    timestamp: 2,
  };
  const roundTrip = buildMessages(
    [{ role: "user", content: "find x" }, assistantTurn, toolOutput],
    model
  );
  if (
    roundTrip[1].content?.[0]?.name !== "find_files" ||
    roundTrip[1].stopReason !== "toolUse" ||
    roundTrip[2].role !== "toolResult" ||
    roundTrip[2].toolCallId !== "call_1"
  ) {
    console.error("selfcheck failed: tool message conversion");
    process.exit(1);
  }

  // The compiled binary has no OAuth flow files: login works only because
  // registerBunOAuthFlows() ran above. A bogus method fails at the first local
  // prompt, so this check needs no network.
  try {
    await models.login("openai-codex", "oauth", {
      prompt: async () => "",
      notify: () => {},
    });
    console.error("selfcheck failed: oauth login unexpectedly continued");
    process.exit(1);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/cannot find module|no such file/i.test(message)) {
      console.error(`selfcheck failed: oauth flows are not bundled (${message})`);
      process.exit(1);
    }
  }

  console.log("selfcheck ok");
  process.exit(0);
}
