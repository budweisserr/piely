# piely-agent

Sidecar for Piely: it runs [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`) and bridges it to the Tauri app over NDJSON on stdio.

The runtime package comes from npm, pinned by `package-lock.json`
(`@earendil-works/pi-ai` 1.1.0). The git submodule at [`../pi`](../pi)
(packages/agent, packages/ai, packages/client) is the upstream source of that
same version, kept for reference — it is not built or linked. When the npm
package is bumped, bump the submodule too, or the reference source lies about
what the sidecar actually runs.

## Layout

```text
agent.mjs                  stdio wrapper: NDJSON in, NDJSON out, command routing
lib/credential-store.mjs   the auth.json store pi-ai reads logins from
lib/login-runner.mjs       one interactive login, cancellable while it runs
lib/message-history.mjs    app messages -> pi-ai messages (incl. tool results)
lib/stream-turn.mjs        one assistant turn through pi-ai
test/agent.test.mjs        drives agent.mjs over stdio
test/lib/…                 one file per lib module, without stdio or network
```

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
{"id":1,"cmd":"cancel_login"}
{"id":2,"cmd":"cancel_stream","streamId":1}
{"id":1,"cmd":"stream","provider":"anthropic","model":"claude-sonnet-4-5",
 "systemPrompt":"...","messages":[{"role":"user","content":"hi"}],
 "tools":[{"name":"find_files","description":"...","parameters":{...}}]}
// out
{"id":1,"type":"providers","providers":[{"id":"anthropic","name":"Anthropic","loggedIn":false,"auth":["oauth","api_key"]}]}
{"id":1,"type":"models","models":[{"id":"claude-sonnet-4-5","name":"Claude Sonnet 4.5","input":["text","image"]}]}
{"id":1,"type":"notify","event":{"type":"auth_url","url":"https://..."}}
{"id":1,"type":"prompt","prompt":{"type":"secret","message":"Enter your API key","placeholder":"sk-..."}}
{"id":1,"type":"chunk","text":"Hello"}
{"id":1,"type":"tool_call","toolCall":{"id":"call_1","name":"find_files","arguments":{"query":"budget"}}}
{"id":1,"type":"progress"}  // thinking / tool-argument deltas: no user text, proves the turn is alive
{"id":1,"type":"done","message":"Found it","assistant":{...},"stopReason":"stop"}
{"id":1,"type":"error","message":"..."}
// answers to an active prompt
{"id":1,"type":"answer","value":"sk-..."}
```

`stream` is one assistant turn. When `stopReason` is `toolUse`, the caller appends
`assistant` plus `toolResult` messages to `messages` and calls `stream` again;
`tool_call` events carry each finished call so the caller can execute it.

`cancel_login` aborts an interactive `login` that is still running. The app sends
it when the login dialog is closed: without it the flow keeps polling or holds the
provider's OAuth callback port, so the next login cannot start. The cancelled
`login` then reports `error` (or `done` if it had already finished).

`cancel_stream` aborts the running `stream` whose request id is `streamId`
(the cancel itself uses its own id). The aborted stream settles with an `error`
message, which is what resolves the original `stream` request.

## Bundling note (OAuth)

pi-ai deliberately loads its OAuth flow modules through a variable specifier so
bundlers cannot follow them into Node-only code. A compiled binary therefore
contains none of those files, and login fails with
`Cannot find module './openai-codex.js' from /$bunfs/root/piely-agent` unless the
statically bundled copies are registered first. `agent.mjs` does that with
`registerBunOAuthFlows()` from `@earendil-works/pi-ai/bun-oauth`. Do not remove
that import: it is what makes OAuth login work in the shipped binary.

## Tests

```bash
npm test                    # message contract, tool round trip, OAuth bundling,
                            #   stream/login cancellation, credential store
node agent.mjs --selfcheck  # runs inside the compiled binary too
```

The tool round trip uses pi-ai's faux provider, so it needs no network and no
credentials.

Credentials persist to the file passed with `--auth-file` (default `auth.json` in the
working directory), in pi's auth.json shape — one credential per provider. The
file is written with mode `0600`: it holds OAuth tokens and API keys.

Self check: `node agent.mjs --selfcheck`.

## Bundling

For release builds, compile this into a single executable (`bun build --compile`) and point
the Rust bridge at it via `PIELY_AGENT_PATH` / `PIELY_NODE_BIN`.
