import assert from "node:assert/strict";
import test from "node:test";
import { runText } from "./process";

test("runText reports spawn errors", () => {
  assert.throws(() => runText("__needlefish_missing_command__", []), /ENOENT/);
});
