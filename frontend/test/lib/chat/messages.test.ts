import test from "node:test";
import assert from "node:assert/strict";
import { endsWithUserMessage, toModelHistory } from "../../../src/lib/chat/messages.ts";
import type { ChatMessage } from "@/types";

const msg = (
  role: ChatMessage["role"],
  content: string,
  timestamp = 1
): ChatMessage => ({ id: `${role}-${content}`, role, content, timestamp });

test("stored newest-first order is reversed before it reaches the model", () => {
  const stored = [msg("assistant", "second"), msg("user", "first")];

  assert.deepEqual(
    toModelHistory(stored).map((m) => m.content),
    ["first", "second"]
  );
});

test("the newest message is the first entry, not the last", () => {
  const stored = [msg("user", "hello"), msg("assistant", "hi")];

  assert.equal(endsWithUserMessage(stored, "hello"), true);
  assert.equal(endsWithUserMessage(stored, "hi"), false);
  assert.equal(endsWithUserMessage([], "hello"), false);
});
