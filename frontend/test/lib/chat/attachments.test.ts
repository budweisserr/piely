import test from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_BYTES, selectAttachableFiles } from "../../../src/lib/chat/attachments.ts";

const file = (name: string, size = 10): File =>
  ({ name, size, type: "image/png" }) as unknown as File;

test("selecting more files than there is room for keeps only the free slots", () => {
  // 5 attached out of 6: only one of the four new files may be added.
  const { accepted, rejected } = selectAttachableFiles(
    [file("a"), file("b"), file("c"), file("d")],
    5,
    6
  );

  assert.deepEqual(
    accepted.map((f) => f.name),
    ["a"]
  );
  assert.equal(rejected.length, 3);
});

test("an oversized file is rejected without consuming a slot", () => {
  const { accepted, rejected } = selectAttachableFiles(
    [file("huge", MAX_FILE_BYTES + 1), file("ok")],
    0,
    6
  );

  assert.deepEqual(
    accepted.map((f) => f.name),
    ["ok"]
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /too large/);
});

test("nothing is accepted when the limit is already reached", () => {
  const { accepted, rejected } = selectAttachableFiles([file("a")], 6, 6);

  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});
