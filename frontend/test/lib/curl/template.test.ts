import test from "node:test";
import assert from "node:assert/strict";
import { buildDynamicMessages } from "../../../src/lib/curl/template.ts";
import type { Message } from "@/types";

// Shape of a built-in provider template: one system message and a user message
// carrying the {{TEXT}} / {{IMAGE}} placeholders.
const template = [
  { role: "system", content: "{{SYSTEM_PROMPT}}" },
  {
    role: "user",
    content: [
      { type: "text", text: "{{TEXT}}" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,{{IMAGE}}" },
      },
    ],
  },
];

const history: Message[] = [
  { role: "user", content: "older" },
  { role: "assistant", content: "newer" },
];

test("history keeps its order and the new message lands at the placeholder", () => {
  const result = buildDynamicMessages(template, history, "now", []);

  assert.deepEqual(
    result.map((m) => m.role),
    ["system", "user", "assistant", "user"]
  );
  assert.equal(result[3].content[0].text, "now");
});

test("with no image the image placeholder is dropped, not sent empty", () => {
  const result = buildDynamicMessages(template, [], "now", []);

  // [system, user]: the image part is removed from the user message.
  assert.equal(result[1].content.length, 1);
  assert.equal(result[1].content[0].text, "now");
});

test("one base64 image becomes one image part", () => {
  const result = buildDynamicMessages(template, [], "now", ["AAA"]);

  assert.equal(result[1].content.length, 2);
  assert.match(result[1].content[1].image_url.url, /AAA$/);
});

test("a template without a text placeholder falls back to plain history", () => {
  const result = buildDynamicMessages(
    [{ role: "system", content: "static" }],
    history,
    "now",
    []
  );

  assert.deepEqual(
    result.map((m) => m.role),
    ["user", "assistant", "user"]
  );
  assert.equal(result[2].content, "now");
});
