import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, "eslint.config.js") });
const boundaryRules = new Set(["no-restricted-imports", "no-restricted-syntax"]);

async function boundaryMessages(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  assert.ok(!result.messages.some(({ message }) => /ignored|no matching configuration/i.test(message)),
    `The example must actually be linted: ${filePath}`);
  return result.messages.filter(({ ruleId }) => boundaryRules.has(ruleId));
}

for (const [file, target] of [
  ["src/shared/example.ts", "../core/review.js"],
  ["src/shared/example.ts", "../adapters/local.js"],
  ["src/shared/example.ts", "../cli/args.js"],
  ["src/shared/nested/example.ts", "../../cli.js"],
  ["src/core/example.ts", "../adapters/local.js"],
  ["src/core/example.ts", "../cli/args.js"],
  ["src/adapters/example.ts", "../cli.js"],
  ["src/adapters/nested/example.ts", "../../cli/args.js"],
  ["src/shared/example.ts", "../../src/core/review"],
]) {
  test(`architecture rejects upward dependency: ${file} -> ${target}`, async () => {
    assert.ok((await boundaryMessages(file, `export { value } from ${JSON.stringify(target)};`)).length > 0);
  });
}

for (const target of [
  "../../eval/run.js", "../../scripts/workflow-test-helpers.mjs",
  "./repo.test", "./repo.test.ts", "./repo.test.js",
  "./runner-test-fixtures", "./runner-test-fixtures.ts", "./runner-test-fixtures.js",
  "node:test", "node:test/reporters",
]) {
  test(`architecture keeps development dependency out of every production layer: ${target}`, async () => {
    for (const file of ["src/cli.ts", "src/cli/example.ts", "src/adapters/example.ts", "src/core/example.ts", "src/shared/example.ts"]) {
      assert.ok((await boundaryMessages(file, `import ${JSON.stringify(target)};`)).length > 0, file);
    }
  });
}

for (const target of ["../core/review.js", "../../eval/run.js", "./runner-test-fixtures.js"]) {
  for (const code of [
    `import * as value from "${target}"; export { value };`,
    `import type { Value } from "${target}"; export type { Value };`,
    `import { type Value } from "${target}"; export type { Value };`,
    `export * from "${target}";`,
    `export type { Value } from "${target}";`,
    `export const value = import("${target}");`,
    `export type Value = import("${target}").Value;`,
  ]) {
    test(`architecture rejects alternate import syntax: ${code}`, async () => {
      assert.ok((await boundaryMessages("src/shared/example.ts", code)).length > 0);
    });
  }
}

for (const [file, target] of [
  ["src/cli.ts", "./adapters/local.js"],
  ["src/cli/args.ts", "../adapters/local.js"],
  ["src/adapters/local.ts", "../core/review.js"],
  ["src/adapters/local.ts", "../shared/schema.js"],
  ["src/core/review.ts", "../shared/codex.js"],
  ["src/core/review.ts", "./verdict.js"],
  ["src/shared/repo.ts", "./schema.js"],
  ["src/shared/repo.ts", "node:fs"],
  ["src/shared/repo.ts", "./core-utils.js"],
  ["src/shared/repo.ts", "./contest.js"],
  ["src/shared/repo.test.ts", "../core/verdict.js"],
  ["src/shared/runner-test-fixtures.ts", "node:test"],
  ["src/shared/runner-test-fixtures.test.ts", "./runner-test-fixtures.js"],
  ["eval/example.ts", "../src/core/review.js"],
]) {
  test(`architecture permits intended dependency: ${file} -> ${target}`, async () => {
    assert.deepEqual(await boundaryMessages(file, `export { value } from ${JSON.stringify(target)};`), []);
  });
}

test("architecture permits downward type and literal dynamic imports", async () => {
  for (const code of [
    'import type { Value } from "./schema.js"; export type { Value };',
    'export type Value = import("./schema.js").Value;',
    'export const value = import("./schema.js");',
  ]) {
    assert.deepEqual(await boundaryMessages("src/shared/example.ts", code), []);
  }
});

test("architecture exemptions leave ordinary TypeScript lint rules enabled", async () => {
  for (const file of ["src/shared/example.test.ts", "src/shared/example-test-fixtures.ts"]) {
    const [result] = await eslint.lintText("export type Value = any;", { filePath: resolve(root, file) });
    assert.equal(result.fatalErrorCount, 0);
    assert.ok(result.messages.some(({ ruleId }) => ruleId === "@typescript-eslint/no-explicit-any"), file);
  }
});
