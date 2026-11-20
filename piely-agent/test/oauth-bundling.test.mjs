// Guards the compiled-binary failure mode: pi-ai loads its OAuth flows through
// a variable specifier, so a bun-compiled binary contains none of them and
// login fails with "Cannot find module './openai-codex.js'". The hook below
// makes that file unloadable, exactly like the binary, and checks that the
// statically registered flows get past it.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

const MISSING = "SIMULATED: no ./openai-codex.js in the bundle";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./openai-codex.js" &&
      context.parentURL?.includes("auth/oauth/load.js")
    ) {
      throw new Error(MISSING);
    }
    return nextResolve(specifier, context);
  },
});

// A login that never gets past the flow's first prompt: no network, no server.
const attemptLogin = () =>
  builtinModels().login("openai-codex", "oauth", {
    prompt: async () => "",
    notify: () => {},
  });

test("without the bundled flows the dynamic import is what fails", async () => {
  await assert.rejects(attemptLogin(), new RegExp(MISSING));
});

test("registerBunOAuthFlows makes login use the bundled flows", async () => {
  registerBunOAuthFlows();

  await assert.rejects(attemptLogin(), (error) => {
    assert.doesNotMatch(
      String(error.message),
      new RegExp(MISSING),
      "login must not depend on the dynamic OAuth import"
    );
    return true;
  });
});
