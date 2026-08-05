# piely-agent

Sidecar for Piely: it runs [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`) and bridges it to the Tauri app over NDJSON on stdio. The pi coding agent source is pinned as a git submodule at [`../pi`](../pi) (packages/agent, packages/ai, packages/client).

## Requirements

- Node.js >= 22.19 (pi-ai's engines requirement)
- `npm install` in this directory (installs `@earendil-works/pi-ai`)

## Protocol

Each line on stdin is a JSON command; each line on stdout is a JSON message.

```jsonc
// in
{"id":1,"cmd":"list"}
{"id":1,"cmd":"models","provider":"anthropic"}
{"id":1,"cmd":"login","provider":"anthropic","type":"oauth"}
{"id":1,"cmd":"login","provider":"openai","type":"api_key"}
{"id":1,"cmd":"logout","provider":"anthropic"}
{"id":1,"cmd":"stream","provider":"anthropic","model":"claude-sonnet-4-5",
 "systemPrompt":"...","messages":[{"role":"user","content":"hi"}]}
// out
{"id":1,"type":"providers","providers":[{"id":"anthropic","name":"Anthropic","loggedIn":false,"auth":["oauth","api_key"]}]}
{"id":1,"type":"models","models":[{"id":"claude-sonnet-4-5","name":"Claude Sonnet 4.5","input":["text","image"]}]}
{"id":1,"type":"notify","event":{"type":"auth_url","url":"https://..."}}
{"id":1,"type":"prompt","prompt":{"type":"secret","message":"Enter your API key","placeholder":"sk-..."}}
{"id":1,"type":"chunk","text":"Hello"}
{"id":1,"type":"done"}
{"id":1,"type":"error","message":"..."}
// answers to an active prompt
{"id":1,"type":"answer","value":"sk-..."}
```

Credentials persist to the file passed with `--auth-file` (default `auth.json` in the
working directory), in pi's auth.json shape — one credential per provider.

Self check: `node agent.mjs --selfcheck`.

## Bundling

For release builds, compile this into a single executable (`bun build --compile`) and point
the Rust bridge at it via `PIELY_AGENT_PATH` / `PIELY_NODE_BIN`.
