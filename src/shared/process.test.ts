import assert from "node:assert/strict";
import test from "node:test";
import { runText } from "./process";

test("runText reports spawn errors", () => {
  assert.throws(() => runText("__needlefish_missing_command__", []), /ENOENT/);
});

test("runText trims stdout by default", () => {
  const script = "process.stdout.write(' abc \\n \\n');";
  assert.equal(runText(process.execPath, ["-e", script]), "abc");
});

test("runText preserveOutput keeps trailing whitespace including a blank context line", () => {
  const script = "process.stdout.write(' abc \\n \\n');";
  assert.equal(
    runText(process.execPath, ["-e", script], { preserveOutput: true }),
    " abc \n \n"
  );
});

test("runText still trims stderr on command failure", () => {
  const script = "process.stderr.write(' boom \\n'); process.exit(1);";
  assert.throws(
    () => runText(process.execPath, ["-e", script]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `${process.execPath} -e ${script} failed: boom`);
      return true;
    }
  );
});
