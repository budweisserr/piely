import test from "node:test";
import assert from "node:assert/strict";
import { writeMessages } from "../../../src/lib/database/write-messages.ts";

type Db = Parameters<typeof writeMessages>[0];

/** Records every statement so the test can assert what the writer did. */
const fakeDb = (rows: { id: string; content: string; attached_files: string | null }[]) => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    select: async () => rows,
    execute: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowsAffected: 1, lastInsertId: 0 };
    },
  };
  return { db: db as unknown as Db, calls };
};

const message = (id: string, content: string, timestamp = 1) => ({
  id,
  role: "user" as const,
  content,
  timestamp,
});

test("a message this caller does not know about is kept, not deleted", async () => {
  // The dashboard wrote "hello" while the overlay held its own copy. Saving the
  // overlay's list must not remove it.
  const { db, calls } = fakeDb([
    { id: "msg_1", content: "hello", attached_files: null },
  ]);

  await writeMessages(db, "conv", [message("msg_2", "world", 2)]);

  assert.equal(calls.length, 1, "only the new message is written");
  assert.match(calls[0].sql, /^INSERT INTO messages/);
  assert.equal(
    calls.some((call) => call.sql.startsWith("DELETE")),
    false,
    "nothing is deleted"
  );
});

test("writing an unchanged conversation issues no write at all", async () => {
  const { db, calls } = fakeDb([
    { id: "msg_1", content: "hello", attached_files: null },
  ]);

  await writeMessages(db, "conv", [message("msg_1", "hello")]);

  assert.deepEqual(calls, []);
});

test("changed content is upserted with the new text", async () => {
  const { db, calls } = fakeDb([
    { id: "msg_1", content: "hello", attached_files: null },
  ]);

  await writeMessages(db, "conv", [message("msg_1", "hello there", 7)]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT\(id\) DO UPDATE/);
  assert.deepEqual(calls[0].params, ["msg_1", "conv", "user", "hello there", 7, null]);
});

test("an invalid message is skipped instead of aborting the write", async () => {
  const { db, calls } = fakeDb([]);

  await writeMessages(db, "conv", [
    { id: "", role: "user", content: "no id", timestamp: 1 },
    message("msg_1", "keep me"),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], "msg_1");
});
