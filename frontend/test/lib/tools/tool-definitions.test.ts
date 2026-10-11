import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTER_USE_TOOLS, isConfirmationTool } from "../../../src/lib/tools/tool-definitions.ts";

test("anything that reads or opens local resources asks the user first", () => {
  for (const name of ["read_file", "write_file", "open_file", "open_app"]) {
    assert.equal(isConfirmationTool(name), true, `${name} must ask first`);
  }
});

test("discovery tools run without a confirmation", () => {
  for (const name of [
    "find_files",
    "search_files_content",
    "list_directory",
    "list_apps",
  ]) {
    assert.equal(isConfirmationTool(name), false, `${name} must run without a prompt`);
  }
});

test("write_file says that the user sees the content before it is written", () => {
  const write = COMPUTER_USE_TOOLS.find((tool) => tool.name === "write_file");
  assert.ok(write, "write_file is registered");
  assert.deepEqual(write.parameters.required, ["path", "content"]);
  assert.match(write.description, /confirms first/i);
});

test("the content search tool says what it can and cannot read", () => {
  const search = COMPUTER_USE_TOOLS.find(
    (tool) => tool.name === "search_files_content"
  );
  assert.ok(search, "search_files_content is registered");
  // Documents are unpacked, but a scan has no text: the model must be able to
  // say which files it could not read instead of promising it read them all.
  assert.match(search.description, /documents \(PDF, Word/i);
  assert.match(search.description, /scanned PDFs have no text/i);
});

test("every tool is a named JSON-schema object with parameters", () => {
  for (const tool of COMPUTER_USE_TOOLS) {
    assert.ok(tool.name, "tool name");
    assert.ok(tool.description, `${tool.name} description`);
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.ok(tool.parameters.properties, `${tool.name} properties`);
  }
});
