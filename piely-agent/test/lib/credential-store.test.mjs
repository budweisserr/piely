// The credential store is what pi-ai reads provider logins from, and it holds
// OAuth tokens: these tests pin the round trip and the file permissions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../lib/credential-store.mjs";

const freshPath = async () =>
  join(await mkdtemp(join(tmpdir(), "piely-store-")), "auth.json");

test("credentials round-trip through the file", async () => {
  const path = await freshPath();
  const store = new FileCredentialStore(path);
  await store.modify("anthropic", () => ({ type: "api_key", key: "sk-test" }));

  assert.deepEqual(await store.read("anthropic"), {
    type: "api_key",
    key: "sk-test",
  });
  assert.deepEqual(await store.list(), [
    { providerId: "anthropic", type: "api_key" },
  ]);

  // A second process (or a restart) must see the same credential.
  const reloaded = new FileCredentialStore(path);
  assert.deepEqual(await reloaded.read("anthropic"), {
    type: "api_key",
    key: "sk-test",
  });
});

test("the auth file is 0600, also when it already existed as 0644", async () => {
  const path = await freshPath();
  await writeFile(path, "{}", { mode: 0o644 });

  const store = new FileCredentialStore(path);
  await store.modify("anthropic", () => ({ type: "api_key", key: "sk-test" }));

  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`);
});

test("delete removes one provider and keeps the others", async () => {
  const path = await freshPath();
  const store = new FileCredentialStore(path);
  await store.modify("anthropic", () => ({ type: "api_key", key: "a" }));
  await store.modify("openai", () => ({ type: "api_key", key: "b" }));

  await store.delete("anthropic");

  assert.equal(await store.read("anthropic"), undefined);
  assert.deepEqual(await store.read("openai"), { type: "api_key", key: "b" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    openai: { type: "api_key", key: "b" },
  });
});

test("a damaged auth file is kept instead of being overwritten", async () => {
  const path = await freshPath();
  await writeFile(path, "{not json");

  const store = new FileCredentialStore(path);
  assert.deepEqual(await store.list(), [], "damaged file == no credentials");

  // The old file survives next to the new one: the logins can be recovered
  // instead of being dropped by the first write after the damage.
  assert.equal(await readFile(`${path}.corrupt`, "utf8"), "{not json");

  await store.modify("anthropic", () => ({ type: "api_key", key: "sk-test" }));
  assert.deepEqual(await store.read("anthropic"), {
    type: "api_key",
    key: "sk-test",
  });
});
