import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { filterByHoldout, fixtureSetHash, loadFixtures } from "./fixture-catalog";
import type { FixtureSpec } from "./types";

function spec(id: string, extra: Partial<FixtureSpec> = {}): FixtureSpec {
  return {
    id, kind: "negative", defectClass: "catalog-test", description: "catalog-only test data",
    baseFiles: { "src/a.ts": "old\n" }, headFiles: { "src/a.ts": "new\n" },
    expected: { verdict: "pass" }, ...extra,
  };
}

// Only the catalog is copied: importing or using it must not need run.ts,
// the review pipeline, a CLI executable, or provider credentials.
async function isolatedCatalog(t: TestContext, real = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-catalog #"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evalDir = path.join(root, "eval");
  const shared = path.join(evalDir, "shared");
  mkdirSync(shared, { recursive: true });
  mkdirSync(path.join(evalDir, "fixtures"));
  if (real) mkdirSync(path.join(evalDir, "fixtures-real"));
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  const catalog = path.join(shared, "fixture-catalog.ts");
  copyFileSync(new URL("./fixture-catalog.ts", import.meta.url), catalog);
  const module: typeof import("./fixture-catalog") = await import(pathToFileURL(catalog).href);
  const add = (group: "fixtures" | "fixtures-real", dir: string, value: FixtureSpec) => {
    const target = path.join(evalDir, group, dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "spec.ts"), `export default ${JSON.stringify(value)} satisfies unknown;\n`);
  };
  return { evalDir, module, add };
}

test("catalog discovery preserves directory order within primary then real fixtures", async (t) => {
  const f = await isolatedCatalog(t);
  // IDs intentionally disagree with directory order; do not globally sort them.
  f.add("fixtures", "z-last", spec("a-id"));
  f.add("fixtures", "a-first", spec("z-id"));
  f.add("fixtures-real", "z-real", spec("b-real-id"));
  f.add("fixtures-real", "a-real", spec("y-real-id"));
  assert.deepEqual((await f.module.loadFixtures(null)).map((s) => s.id), ["z-id", "a-id", "y-real-id", "b-real-id"]);
  assert.deepEqual((await f.module.loadFixtures("^a-")).map((s) => s.id), ["z-id", "y-real-id"]);
  assert.deepEqual(await f.module.loadFixtures(""), await f.module.loadFixtures(null));
  assert.deepEqual(await f.module.loadFixtures("does-not-match"), []);
});

test("catalog discovery skips loose files, directories without specs and absent defaults", async (t) => {
  const f = await isolatedCatalog(t);
  writeFileSync(path.join(f.evalDir, "fixtures", "loose.ts"), "throw new Error('must not import');\n");
  mkdirSync(path.join(f.evalDir, "fixtures", "missing-spec"));
  mkdirSync(path.join(f.evalDir, "fixtures", "no-default"));
  writeFileSync(path.join(f.evalDir, "fixtures", "no-default", "spec.ts"), "export const ignored = true;\n");
  f.add("fixtures", "present", spec("present"));
  assert.deepEqual((await f.module.loadFixtures(null)).map((s) => s.id), ["present"]);
});

test("catalog discovery retains optional fixtures-real and required fixtures semantics", async (t) => {
  const f = await isolatedCatalog(t, false);
  assert.deepEqual(await f.module.loadFixtures(null), []);
  f.add("fixtures", "primary", spec("primary"));
  assert.deepEqual((await f.module.loadFixtures(null)).map((s) => s.id), ["primary"]);
  await assert.rejects(f.module.loadFixtures("["), SyntaxError);
  rmSync(path.join(f.evalDir, "fixtures"), { recursive: true });
  await assert.rejects(f.module.loadFixtures(null), { code: "ENOENT" });
});

test("catalog discovery propagates spec import failures", async (t) => {
  const f = await isolatedCatalog(t);
  const dir = path.join(f.evalDir, "fixtures", "broken");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "spec.ts"), "throw new Error('catalog fixture failed');\nexport default {};\n");
  await assert.rejects(f.module.loadFixtures(null), /catalog fixture failed/);
});

const holdouts = Object.freeze([
  Object.freeze(spec("unset")), Object.freeze(spec("false", { holdout: false })),
  Object.freeze(spec("true", { holdout: true })),
]);
for (const [mode, ids] of [
  ["include", ["unset", "false", "true"]], ["exclude", ["unset", "false"]], ["only", ["true"]],
] as const) {
  test(`catalog holdout ${mode} preserves order and does not mutate the input`, () => {
    const selected = filterByHoldout(holdouts, mode);
    assert.deepEqual(selected.map((s) => s.id), ids);
    assert.notEqual(selected, holdouts);
    assert.ok(selected.every((s) => holdouts.includes(s)));
    assert.deepEqual(filterByHoldout([], mode), []);
  });
}

const golden = [
  spec("z", { holdout: true, tier: 3, deletedFiles: ["z.ts", "a.ts"],
    renamedFiles: [{ from: "z.ts", to: "q.ts" }, { from: "a.ts", to: "b.ts" }],
    provenance: { repo: "example/catalog", pr: 1, kind: "clean-negative" } }),
  spec("a"),
];

test("catalog hash retains the pre-extraction golden digest and is input-order independent", () => {
  // Captured from main@42cbdc9's unchanged fixtureSetHash on this synthetic data.
  assert.equal(fixtureSetHash(golden), "39f8301c791011d1");
  assert.equal(fixtureSetHash([...golden].reverse()), fixtureSetHash(golden));
  assert.equal(fixtureSetHash([]), "4f53cda18c2baa0c");
});

test("catalog hash normalizes deletion/rename ordering without mutating arrays", () => {
  const before = JSON.stringify(golden);
  const reordered = { ...golden[0], deletedFiles: [...golden[0].deletedFiles!].reverse(),
    renamedFiles: [...golden[0].renamedFiles!].reverse() };
  assert.equal(fixtureSetHash([reordered, golden[1]]), fixtureSetHash(golden));
  assert.equal(JSON.stringify(golden), before);
  const plain = spec("plain");
  assert.equal(fixtureSetHash([plain]), fixtureSetHash([{ ...plain, holdout: false, deletedFiles: [], renamedFiles: [] }]));
});

test("catalog hash keeps all existing contract fields and excludes display-only metadata", () => {
  const plain = spec("plain");
  const original = fixtureSetHash([plain]);
  const changes: Partial<FixtureSpec>[] = [
    { id: "other" }, { kind: "positive" }, { tier: 1 },
    { baseFiles: { "src/a.ts": "different\n" } }, { headFiles: { "src/a.ts": "different\n" } },
    { expected: { verdict: "needs_human" } }, { holdout: true }, { deletedFiles: ["src/a.ts"] },
    { renamedFiles: [{ from: "src/a.ts", to: "src/b.ts" }] },
    { provenance: { repo: "example/catalog", pr: 2, kind: "clean-negative" } },
  ];
  for (const change of changes) assert.notEqual(fixtureSetHash([{ ...plain, ...change }]), original);
  assert.equal(fixtureSetHash([{ ...plain, description: "other", defectClass: "other" }]), original);
});

test("catalog hash preserves existing object-key serialization order", () => {
  const first = spec("key-order", { baseFiles: { "a.ts": "a", "b.ts": "b" } });
  const reversed = { ...first, baseFiles: { "b.ts": "b", "a.ts": "a" } };
  // Sorting these keys would change historic report identities: not part of this refactor.
  assert.notEqual(fixtureSetHash([first]), fixtureSetHash([reversed]));
});

test("integration: run.ts retains the identical catalog exports", async () => {
  const legacy = await import("../run");
  assert.equal(legacy.loadFixtures, loadFixtures);
  assert.equal(legacy.filterByHoldout, filterByHoldout);
  assert.equal(legacy.fixtureSetHash, fixtureSetHash);
});

test("integration: document generators import the catalog rather than the executor", () => {
  const evalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const name of ["gen-readme.ts", "gen-baseline-doc.ts", "gen-site.ts"]) {
    const source = readFileSync(path.join(evalDir, name), "utf8");
    assert.match(source, /from ["']\.\/shared\/fixture-catalog["']/);
    assert.doesNotMatch(source, /from ["']\.\/run(?:\.[cm]?[jt]s)?["']/);
  }
});
