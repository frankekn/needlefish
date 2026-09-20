import assert from "node:assert/strict";
import test from "node:test";
import { workflowRun } from "./workflow-test-helpers.mjs";

const workflowWith = (steps) => JSON.stringify({ jobs: { review: { steps } } });

test("workflowRun preserves script text and stops before later keys, steps and jobs", () => {
  const source = [
    "jobs:",
    "  review:",
    "    steps:",
    "      - id: target",
    '        name: "Check [x] (a+b)?"',
    "        run: |-",
    "          # keep this comment",
    '          printf "%s\\n" "$PR_NUM"',
    "          cat <<'EOF'",
    "            ${{ inputs.pr_number }}",
    "          EOF",
    "        env:",
    "          PR_NUM: literal",
    "      - run: echo following-step",
    "  other:",
    "    steps:",
    '      - name: "Check [x] (a+b)?"',
    "        run: echo wrong-job",
    "",
  ].join("\n");
  const expected = [
    "# keep this comment",
    'printf "%s\\n" "$PR_NUM"',
    "cat <<'EOF'",
    "  ${{ inputs.pr_number }}",
    "EOF",
  ].join("\n");
  assert.equal(workflowRun(source, "review", "Check [x] (a+b)?"), expected);
  assert.equal(workflowRun(source.replaceAll("\n", "\r\n"), "review", "Check [x] (a+b)?"), expected);
  assert.equal(workflowRun(source, "other", "Check [x] (a+b)?"), "echo wrong-job");
  assert.throws(() => workflowRun(source, "review", "target"), /exactly one step/);
});

for (const [style, expected] of [
  ["|", "echo one\necho two\n"],
  ["|-", "echo one\necho two"],
  ["|+", "echo one\necho two\n\n"],
  [">-", "echo one echo two"],
]) {
  test(`workflowRun honors YAML ${style} scalar semantics`, () => {
    const source = `jobs:\n  review:\n    steps:\n      - name: target\n        run: ${style}\n          echo one\n          echo two\n\n`;
    assert.equal(workflowRun(source, "review", "target"), expected);
  });
}

test("workflowRun accepts inline scalars and preserves leading and trailing script whitespace", () => {
  const source = "jobs: { review: { steps: [{ name: target, run: 'echo inline' }] } }";
  assert.equal(workflowRun(source, "review", "target"), "echo inline");
  const run = "  echo padded  \n\n";
  assert.equal(workflowRun(workflowWith([{ name: "target", run }]), "review", "target"), run);
});

test("workflowRun resolves a YAML alias within the requested job", () => {
  const source = "jobs:\n  review:\n    steps:\n      - &task\n        name: target\n        run: echo shared\n  other:\n    steps:\n      - *task\n";
  assert.equal(workflowRun(source, "other", "target"), "echo shared");
});

test("workflowRun rejects a missing job or non-array steps", () => {
  for (const workflow of [null, [], {}, { jobs: null }, { jobs: {} },
    { jobs: { review: { uses: "./reusable.yml" } } },
    { jobs: { review: { steps: {} } } },
    { jobs: { review: { steps: null } } },
  ]) {
    assert.throws(() => workflowRun(JSON.stringify(workflow), "review", "target"), /review must have steps/);
  }
});

test("workflowRun rejects a missing named step instead of selecting an unnamed or id-only step", () => {
  for (const steps of [[], [null, false, "target"], [{ id: "target", run: "echo id-only" }],
    [{ name: "other", run: "echo other" }],
  ]) {
    assert.throws(() => workflowRun(workflowWith(steps), "review", "target"), /exactly one step named target/);
  }
});

test("workflowRun rejects duplicate step names in the same job", () => {
  const source = workflowWith([
    { name: "target", run: "echo first" },
    { name: "target", run: "echo second" },
  ]);
  assert.throws(() => workflowRun(source, "review", "target"), /exactly one step named target/);
});

test("workflowRun rejects missing, empty and non-string run values", () => {
  for (const run of [undefined, null, false, 42, [], {}, "", " \n "]) {
    const source = workflowWith([{ name: "target", run }]);
    assert.throws(() => workflowRun(source, "review", "target"), /must have a non-empty run script/);
  }
});

test("workflowRun propagates malformed YAML and duplicate-key errors", () => {
  for (const source of ["jobs: [", "jobs:\n  review:\n    steps:\n      - name: target\n        run: echo first\n        run: echo second\n"]) {
    assert.throws(() => workflowRun(source, "review", "target"), { name: "YAMLParseError" });
  }
});

test("workflowRun reads each supplied source without caching an earlier script", () => {
  for (const run of ["echo before", "echo after"]) {
    assert.equal(workflowRun(workflowWith([{ name: "target", run }]), "review", "target"), run);
  }
});
