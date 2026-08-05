// Piely sidecar: bridges the pi-ai package (@earendil-works/pi-ai) to the Piely
// Tauri app. Speaks NDJSON over stdio:
//
//   in : {"id":1,"cmd":"list"|"models"|"login"|"logout"|"stream", ...}
//   in : {"id":1,"type":"answer","value":"..."}          (reply to a prompt)
//   out: {"id":1,"type":"providers"|"models"|"prompt"|"notify"|"chunk", ...}
//   out: {"id":1,"type":"done"} | {"id":1,"type":"error","message":"..."}
//
// Credentials are persisted to --auth-file (auth.json, same shape as pi's CLI).
import { readFile, rename, writeFile } from "node:fs/promises";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai";

const args = process.argv.slice(2);
const authFlag = args.indexOf("--auth-file");
const authPath = authFlag !== -1 ? args[authFlag + 1] : "auth.json";

// --- File-backed credential store (single process, serialized writes) --------
class FileCredentialStore {
  constructor(path) {
    this.path = path;
    this.credentials = new Map();
    this.loaded = this.load();
    this.chains = new Map();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      for (const [providerId, credential] of Object.entries(parsed)) {
        this.credentials.set(providerId, credential);
      }
    } catch {
      // missing/corrupt file == no credentials
    }
  }

  async persist() {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.credentials), null, 2));
    await rename(tmp, this.path);
  }

  enqueue(providerId, task) {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(task);
    this.chains.set(providerId, queued.catch(() => {}));
    return queued;
  }

  async read(providerId) {
    await this.loaded;
    return this.credentials.get(providerId);
  }

  async list() {
    await this.loaded;
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(providerId, fn) {
    return this.enqueue(providerId, async () => {
      await this.loaded;
      const current = this.credentials.get(providerId);
      const next = await fn(current);
      if (next !== undefined) this.credentials.set(providerId, next);
      await this.persist();
      return next ?? current;
    });
  }

  delete(providerId) {
    return this.enqueue(providerId, async () => {
      await this.loaded;
      this.credentials.delete(providerId);
      await this.persist();
    });
  }
}

const store = new FileCredentialStore(authPath);
const models = builtinModels({ credentials: store });

// --- stdin routing ------------------------------------------------------------
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const answerResolvers = new Map(); // request id -> resolve(value)

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

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
        providers: builtinProviders().map((p) => ({
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
      const providerModels = models.getModels(msg.provider) ?? [];
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
      await models.login(msg.provider, msg.type ?? "oauth", {
        prompt: (prompt) =>
          new Promise((resolve) => {
            answerResolvers.set(msg.id, resolve);
            send({ id: msg.id, type: "prompt", prompt });
            // manual_code prompts race a local callback server; when the
            // server wins the flow aborts the prompt and continues on its own.
            prompt.signal?.addEventListener("abort", () => {
              answerResolvers.delete(msg.id);
              resolve(undefined);
            });
          }),
        notify: (event) => send({ id: msg.id, type: "notify", event }),
      });
      send({ id: msg.id, type: "done" });
      break;
    }
    case "logout": {
      await models.logout(msg.provider);
      send({ id: msg.id, type: "done" });
      break;
    }
    case "stream": {
      const model = models.getModel(msg.provider, msg.model);
      if (!model) {
        send({ id: msg.id, type: "error", message: `Unknown model ${msg.provider}/${msg.model}` });
        break;
      }
      const context = {
        systemPrompt: msg.systemPrompt,
        messages: buildMessages(msg.messages, msg.provider, msg.model),
      };
      const stream = models.stream(model, context);
      let fullText = "";
      for await (const event of stream) {
        if (event.type === "text_delta") {
          fullText += event.delta;
          send({ id: msg.id, type: "chunk", text: event.delta });
        } else if (event.type === "error") {
          send({
            id: msg.id,
            type: "error",
            message: event.error?.errorMessage ?? "Stream failed",
          });
          return;
        } else if (event.type === "done") {
          break;
        }
      }
      send({ id: msg.id, type: "done", message: fullText });
      break;
    }
    default:
      send({ id: msg.id, type: "error", message: `Unknown command: ${msg.cmd}` });
  }
}

// --- message conversion ---------------------------------------------------------
function buildMessages(raw, provider, model) {
  let timestamp = Date.now();
  return raw.map((m) => {
    timestamp += 1;
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: m.content }],
        provider,
        model,
        api: "openai-chat-completions",
        timestamp,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      };
    }
    if (Array.isArray(m.content)) {
      return { role: "user", content: m.content, timestamp };
    }
    return { role: "user", content: m.content, timestamp };
  });
}

// --- self check -----------------------------------------------------------------
if (process.argv.includes("--selfcheck")) {
  const providers = builtinProviders();
  if (!providers.some((p) => p.id === "anthropic") || !providers.some((p) => p.id === "google")) {
    console.error("selfcheck failed: expected builtin providers");
    process.exit(1);
  }
  const msgs = buildMessages(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: [{ type: "text", text: "x" }] },
    ],
    "anthropic",
    "claude-sonnet-4-5"
  );
  if (msgs.length !== 3 || msgs[1].role !== "assistant" || msgs[1].stopReason !== "stop") {
    console.error("selfcheck failed: message conversion");
    process.exit(1);
  }
  console.log("selfcheck ok");
  process.exit(0);
}
