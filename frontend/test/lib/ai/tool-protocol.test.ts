// The text protocol: models without native tool calls ask in a fenced block.
// The filter must hand the block to the loop, never to the user, and must leave
// ordinary code blocks alone.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolProtocolFilter,
  parseToolRequest,
} from "../../../src/lib/tools/tool-protocol.ts";

const block = (json: string) => "```tool\n" + json + "\n```";

test("parses a tool block with the documented shape", () => {
  const request = parseToolRequest('{"name":"find_files","arguments":{"query":"x"}}');
  assert.deepEqual(request, { name: "find_files", arguments: { query: "x" } });
});

test("accepts the parameter aliases models write anyway", () => {
  assert.deepEqual(parseToolRequest('{"tool":"read_file","parameters":{"path":"/a"}}'), {
    name: "read_file",
    arguments: { path: "/a" },
  });
  assert.deepEqual(parseToolRequest('{"name":"read_file"}')?.arguments, {});
});

test("rejects anything that is not a known tool call", () => {
  assert.equal(parseToolRequest('{"name":"rm_rf","arguments":{}}'), null, "unknown tool");
  assert.equal(parseToolRequest('{"name":"read_file","arguments":[1]}'), null, "array args");
  assert.equal(parseToolRequest("not json"), null);
  assert.equal(parseToolRequest('{"arguments":{"path":"/a"}}'), null, "no name");
});

test("a plain answer streams through untouched", () => {
  const filter = new ToolProtocolFilter();
  // The last two characters wait for the next chunk: a fence could start with
  // "``". Nothing may be lost, and the tail arrives on flush.
  const parts = [
    filter.push("Hello "),
    filter.push("there"),
    filter.flush(),
  ];
  assert.equal(parts.map((part) => part.text).join(""), "Hello there");
  assert.deepEqual(
    parts.flatMap((part) => part.requests),
    []
  );
});

test("a tool block is taken out of the text, even split across chunks", () => {
  const filter = new ToolProtocolFilter();
  const seen = [];
  seen.push(filter.push("Let me look.\n\n```to"));
  seen.push(filter.push('ol\n{"name":"find_files",'));
  seen.push(filter.push('"arguments":{"query":"budget"}}\n``'));
  seen.push(filter.push("`\nThat is all."));
  seen.push(filter.flush());

  const text = seen.map((part) => part.text).join("");
  const requests = seen.flatMap((part) => part.requests);
  assert.equal(text, "Let me look.\n\n\nThat is all.");
  assert.deepEqual(requests, [
    { name: "find_files", arguments: { query: "budget" } },
  ]);
});

test("ordinary code blocks and malformed blocks stay visible", () => {
  const filter = new ToolProtocolFilter();
  const python = filter.push("```python\nprint(1)\n```\n");
  const malformed = filter.push(block("{oops"));
  const dangling = filter.flush();

  assert.match(python.text, /print\(1\)/, "a python block is shown");
  assert.equal(python.requests.length, 0);
  assert.match(malformed.text, /\{oops/, "a broken block is shown, not swallowed");
  assert.equal(malformed.requests.length + dangling.requests.length, 0);
});

test("two requests in one answer are both reported", () => {
  const filter = new ToolProtocolFilter();
  const part = filter.push(
    block('{"name":"find_files","arguments":{"query":"a"}}') +
      " and " +
      block('{"name":"list_apps"}')
  );
  assert.equal(part.requests.length, 2);
  assert.equal(part.text, " and ");
});
