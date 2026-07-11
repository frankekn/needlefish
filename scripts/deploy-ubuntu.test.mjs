import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("deploy does not install an optional model runner", async () => {
  const script = await readFile("scripts/deploy-ubuntu.sh", "utf8");

  assert.doesNotMatch(script, /npm install -g @mariozechner\/pi/);
});
