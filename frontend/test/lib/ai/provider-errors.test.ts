import assert from "node:assert/strict";
import test from "node:test";

import { explainProviderError } from "../../../src/lib/ai/provider-errors.ts";

test("a model the account cannot use points at the dashboard", () => {
  const raw =
    '404: {"message":"The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}';

  const explained = explainProviderError(raw);
  assert.match(explained, /not available for your account/i);
  assert.match(explained, /dashboard/i);
  assert.ok(!explained.includes("model_not_found"), "raw json is not shown");
});

test("auth, rate limit and outage errors get their own sentence", () => {
  assert.match(explainProviderError("401: invalid_api_key"), /rejected the login/i);
  assert.match(explainProviderError("429: rate limit reached"), /rate limiting/i);
  assert.match(explainProviderError("503: upstream overloaded"), /try again/i);
  assert.match(explainProviderError("TypeError: fetch failed"), /internet connection/i);
});

test("anything unrecognised is passed through unchanged", () => {
  const odd = "context length exceeded: 128000 tokens";
  assert.equal(explainProviderError(odd), odd);
});
