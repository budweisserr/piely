import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTER_USE_TOOLS, isConfirmationTool } from "../../../src/lib/tools/tool-definitions.ts";

test("anything that reads or opens local resources asks the user first", () => {
  for (const name of ["read_file", "open_file", "open_app"]) {
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

test("the content search tool says what it can and cannot read", () => {
  const search = COMPUTER_USE_TOOLS.find(
    (tool) => tool.name === "search_files_content"
  );
  assert.ok(search, "search_files_content is registered");
  // Snippets come from text files only, so the model must be able to say that
  // instead of promising it searched the user's PDFs.
  assert.match(search.description, /text files only/i);
});

test("every tool is a named JSON-schema object with parameters", () => {
  for (const tool of COMPUTER_USE_TOOLS) {
    assert.ok(tool.name, "tool name");
    assert.ok(tool.description, `${tool.name} description`);
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.ok(tool.parameters.properties, `${tool.name} properties`);
  }
});
