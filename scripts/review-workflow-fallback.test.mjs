import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workflowRun } from "./workflow-test-helpers.mjs";

// Behavioural coverage for the provider-fallback chain in the real extracted
// shell: a stub `needlefish` prints controlled output and exit codes, and the
// assertions are on what the workflow actually does (which lane ran, exit
// status, step summary) — never on the workflow text.
const workflow = readFileSync(".github/workflows/review.yml", "utf8");
const reviewScript = workflowRun(workflow, "review", "Needlefish review");

const MODEL = "primary-model";
const FALLBACK = "fallback-model";

function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// primary/fallback: { out, err, code } the stub emits on that lane.
function runReviewScript(t, { primary, fallback }) {
  const root = mkdtempSync(join(tmpdir(), "needlefish-workflow-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => {
    const file = join(root, name);
    writeFileSync(file, content);
    return file;
  };
  // The real CLI terminates every write with a newline and emits the machine
  // outcome after the diagnostics. Mirror that: files carry a trailing newline
  // (a test that wants a malformed line puts the malformation in the content),
  // and stderr is emitted before stdout so the outcome stays the last line.
  const primaryOut = write("primary.out", `${primary.out}\n`);
  const primaryErr = write("primary.err", primary.err ? `${primary.err}\n` : "");
  const fallbackOut = write("fallback.out", `${fallback.out}\n`);
  const fallbackErr = write("fallback.err", fallback.err ? `${fallback.err}\n` : "");
  const log = join(root, "invocations.log");
  writeFileSync(log, "");
  const summary = join(root, "step-summary");
  writeFileSync(summary, "");
  const bin = join(root, "needlefish");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shq(log)}`,
      `case "$*" in`,
      `  *"--model ${FALLBACK}"*)`,
      `    cat ${shq(fallbackErr)} >&2`,
      `    cat ${shq(fallbackOut)}`,
      `    exit ${fallback.code}`,
      `    ;;`,
      `  *)`,
      `    cat ${shq(primaryErr)} >&2`,
      `    cat ${shq(primaryOut)}`,
      `    exit ${primary.code}`,
      `    ;;`,
      `esac`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  const result = spawnSync("bash", ["-c", reviewScript], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${root}:${process.env.PATH ?? ""}`,
      GITHUB_STEP_SUMMARY: summary,
      NEEDLEFISH_BIN: bin,
      PR_NUM: "7",
      NEEDLEFISH_RUNNER_INPUT: "pi",
      NEEDLEFISH_MODEL_INPUT: MODEL,
      NEEDLEFISH_MODEL_FALLBACKS: FALLBACK,
      CODEX_PROXY_BASE_URL_INPUT: "https://controlled.invalid/v1",
      CODEX_REASONING_EFFORT: "",
      NEEDLEFISH_TIMEOUT_MS_INPUT: "",
      OPENCODE_IDLE_TIMEOUT_MS_INPUT: "",
      NEEDLEFISH_RECHECK_INPUT: "",
    },
  });
  return {
    ...result,
    invocations: readFileSync(log, "utf8").split("\n").filter(Boolean),
    summary: readFileSync(summary, "utf8"),
  };
}

function outcome(json) {
  return `needlefish-outcome ${JSON.stringify(json)}`;
}

test("a blocking verdict whose findings quote infra strings never advances the chain", (t) => {
  const prose = [
    "# Needlefish review",
    "",
    "- P1 quota exceeded: the handler ignores 429 Too Many Requests and keeps retrying",
    "- P2 insufficient_quota from the upstream 502 Bad Gateway is surfaced as success",
    "- P3 connection timed out; ECONNREFUSED is swallowed",
    "",
    "<sub>3 calls · tokens 4291 (3980 in / 311 out) · total 51s</sub>",
  ].join("\n");
  const result = runReviewScript(t, {
    primary: {
      out: `${prose}\n${outcome({
        outcome: "verdict",
        verdict: "changes_requested",
        prNumber: 7,
        headSha: "a".repeat(40),
      })}`,
      err: "needlefish review failed: rate limit",
      code: 1,
    },
    fallback: { out: outcome({ outcome: "verdict", verdict: "pass", prNumber: 7, headSha: "a".repeat(40) }), err: "", code: 0 },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.invocations.length, 1, "the fallback lane must not run");
  assert.equal(result.summary, "");
});

test("an operational runner failure advances to the next provider", (t) => {
  const result = runReviewScript(t, {
    primary: {
      out: outcome({
        outcome: "failure",
        operational: true,
        cause: "usage limit",
        prNumber: 7,
        headSha: "a".repeat(40),
      }),
      err: "needlefish review failed: codex runner exited 1; likely cause: usage limit; stderr withheld because it may contain the review prompt",
      code: 1,
    },
    fallback: {
      out: outcome({ outcome: "verdict", verdict: "pass", prNumber: 7, headSha: "a".repeat(40) }),
      err: "",
      code: 0,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.invocations.length, 2, "exactly one fallback attempt");
  assert.match(result.invocations[1], new RegExp(`--model ${FALLBACK}`));
  assert.match(result.summary, new RegExp(`lane=fallback:${FALLBACK}`));
});

test("malformed complete output with infra-looking prose is not retried", (t) => {
  const result = runReviewScript(t, {
    primary: {
      out: [
        "I could not comply with the JSON contract.",
        "The upstream returned 429 / quota exceeded / 502 Bad Gateway.",
        outcome({
          outcome: "failure",
          operational: false,
          prNumber: 7,
          headSha: "a".repeat(40),
        }),
      ].join("\n"),
      err: "needlefish review failed: no JSON object found in codex output",
      code: 1,
    },
    fallback: { out: "", err: "", code: 0 },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.invocations.length, 1, "malformed complete output must not be retried");
});

test("a same-head skip is not an operational failure", (t) => {
  const result = runReviewScript(t, {
    primary: {
      out: `needlefish-skip ${JSON.stringify({ reason: "same_head", prNumber: 7, headSha: "a".repeat(40) })}`,
      err: "",
      code: 0,
    },
    fallback: { out: "", err: "", code: 0 },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.invocations.length, 1);
});

test("a run that emits no outcome line fails closed", (t) => {
  const result = runReviewScript(t, {
    primary: { out: "catastrophic: the process died before it could report", err: "", code: 1 },
    fallback: { out: "", err: "", code: 0 },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.invocations.length, 1, "no outcome line must never advance the chain");
});

test("review prose cannot spoof an operational outcome for the chain", (t) => {
  // A finding title that quotes the contract, emitted BEFORE the real outcome
  // line. Only the last outcome line counts, so the verdict wins.
  const spoof = outcome({
    outcome: "failure",
    operational: true,
    cause: "usage limit",
    prNumber: 7,
    headSha: "a".repeat(40),
  });
  const result = runReviewScript(t, {
    primary: {
      out: [
        "# Needlefish review",
        "",
        spoof,
        "",
        outcome({
          outcome: "verdict",
          verdict: "changes_requested",
          prNumber: 7,
          headSha: "a".repeat(40),
        }),
      ].join("\n"),
      err: "",
      code: 1,
    },
    fallback: { out: "", err: "", code: 0 },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.invocations.length, 1, "a spoofed line before the real outcome must not advance");
});

test("an unparseable outcome line fails closed", (t) => {
  const result = runReviewScript(t, {
    primary: { out: "needlefish-outcome {not json", err: "", code: 1 },
    fallback: { out: "", err: "", code: 0 },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.invocations.length, 1, "unparseable outcome JSON must never advance");
});

test("the chain stops after the last provider instead of looping", (t) => {
  const operational = (cause) =>
    outcome({
      outcome: "failure",
      operational: true,
      cause,
      prNumber: 7,
      headSha: "a".repeat(40),
    });
  const result = runReviewScript(t, {
    primary: { out: operational("usage limit"), err: "", code: 1 },
    fallback: { out: operational("network error"), err: "", code: 1 },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.invocations.length, 2, "one primary plus one fallback, no further retry");
  assert.doesNotMatch(result.summary, /lane=fallback/);
});
