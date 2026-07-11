import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = join(process.cwd(), "scripts", "brief-lint.mjs");

async function fixtureRepo(t, fixtures = {}) {
  const root = await mkdtemp(join(tmpdir(), "needlefish-brief-lint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, { real = false, spec = "export default {};" }] of Object.entries(fixtures)) {
    const directory = join(root, "eval", real ? "fixtures-real" : "fixtures", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "spec.ts"), spec);
  }
  return root;
}

function validCriteria(overrides = {}) {
  return {
    fixtures: ["ordinary-case"],
    riskTier: 2,
    maxMeanNoisePerPositive: 0.5,
    tier1Misses: 0,
    extraPolicy: "allowed",
    ...overrides,
  };
}

function brief(criteria = validCriteria()) {
  return `# Gate\n\n\`\`\`json\n${JSON.stringify({ gateCriteria: criteria }, null, 2)}\n\`\`\`\n`;
}

async function run(t, contents, fixtures = {}, extraArgs = []) {
  const repo = await fixtureRepo(t, fixtures);
  const briefPath = join(repo, "brief.md");
  await writeFile(briefPath, contents);
  const result = spawnSync(process.execPath, [script, briefPath, "--repo", repo, ...extraArgs], {
    encoding: "utf8",
  });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{.*\}\n$/);
  return { repo, result, output: JSON.parse(result.stdout) };
}

function codes(output) {
  return output.failures.map(({ code }) => code);
}

test("passes, accepts unknown keys, resolves both fixture roots, and emits criteria", async (t) => {
  const criteria = validCriteria({ fixtures: ["ordinary-case", "real-case"] });
  const repo = await fixtureRepo(t, {
    "ordinary-case": {},
    "real-case": { real: true },
  });
  const briefPath = join(repo, "brief.md");
  const emittedPath = join(repo, "criteria.json");
  await writeFile(briefPath, brief(criteria));

  const result = spawnSync(
    process.execPath,
    [script, briefPath, "--repo", repo, "--emit-criteria", emittedPath],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { pass: true, failures: [] });
  assert.deepEqual(JSON.parse(await readFile(emittedPath, "utf8")), criteria);
});

test("fails when the brief has no json fenced block", async (t) => {
  const { result, output } = await run(t, "# Gate\n", { "ordinary-case": {} });
  assert.equal(result.status, 1);
  assert.deepEqual(codes(output), ["json-block-count"]);
});

test("fails when the brief has more than one json fenced block", async (t) => {
  const contents = `${brief()}\n\`\`\`json\n{}\n\`\`\`\n`;
  const { output } = await run(t, contents, { "ordinary-case": {} });
  assert.deepEqual(codes(output), ["json-block-count"]);
});

test("fails malformed JSON", async (t) => {
  const { output } = await run(t, "```json\n{ nope }\n```\n");
  assert.deepEqual(codes(output), ["invalid-json"]);
});

test("fails a missing gateCriteria object", async (t) => {
  const { output } = await run(t, "```json\n{}\n```\n");
  assert.deepEqual(codes(output), ["invalid-gate-criteria"]);
});

test("fails invalid fixtures", async (t) => {
  const { output } = await run(t, brief(validCriteria({ fixtures: [""] })));
  assert.deepEqual(codes(output), ["invalid-fixtures"]);
});

test("fails when fixtures is missing and a mistyped fixtureIds key is present", async (t) => {
  const criteria = validCriteria();
  delete criteria.fixtures;
  criteria.fixtureIds = ["ordinary-case"];
  const { output } = await run(t, brief(criteria), { "ordinary-case": {} });
  assert.deepEqual(codes(output), ["invalid-fixtures"]);
});

test("fails an invalid risk tier", async (t) => {
  const { output } = await run(t, brief(validCriteria({ riskTier: 5 })), { "ordinary-case": {} });
  assert.deepEqual(codes(output), ["invalid-risk-tier"]);
});

test("fails a non-finite maxMeanNoisePerPositive", async (t) => {
  const contents = brief().replace('"maxMeanNoisePerPositive": 0.5', '"maxMeanNoisePerPositive": 1e400');
  const { output } = await run(t, contents, { "ordinary-case": {} });
  assert.deepEqual(codes(output), ["invalid-max-mean-noise-per-positive"]);
});

test("fails tier1Misses unless it is numeric zero", async (t) => {
  const { output } = await run(t, brief(validCriteria({ tier1Misses: "0" })), { "ordinary-case": {} });
  assert.deepEqual(codes(output), ["invalid-tier1-misses"]);
});

test("fails negative zero for literal numeric tier1Misses zero", async (t) => {
  const contents = brief().replace('"tier1Misses": 0', '"tier1Misses": -0');
  const { output } = await run(t, contents, { "ordinary-case": {} });
  assert.deepEqual(codes(output), ["invalid-tier1-misses"]);
});

test("fails when a named fixture directory does not exist", async (t) => {
  const { output } = await run(t, brief());
  assert.deepEqual(codes(output), ["fixture-not-found"]);
});

test("detects spaced multiline holdout syntax without leaking its id", async (t) => {
  const secretId = "sealed-case-xyz";
  const contents = `${brief()}\nDo not use ${secretId}.\n`;
  const { result, output } = await run(t, contents, {
    "ordinary-case": {},
    [secretId]: { real: true, spec: "export default { holdout\n :\n true };" },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(output), ["holdout-leak"]);
  assert.match(output.failures[0].detail, /offset \d+/);
  assert.doesNotMatch(result.stdout, new RegExp(secretId));
});

test("returns exit 2 and JSON for invocation errors", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.deepEqual(codes(JSON.parse(result.stdout)), ["internal-error"]);
});
