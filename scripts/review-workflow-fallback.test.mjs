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
const FALLBACK = "gpt-6.1-sol";

function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// primary/fallback: { out, err, code } the stub emits on that lane.
function runReviewScript(t, {
  primary, fallback, checks = [], checkResponse, checkExit = 0, runner = "codex",
  tier = "", previousCheckId = 0, snapshotExit = 0, appId = "",
}) {
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
  const gh = write("gh", `#!/bin/sh\ncase "$*" in *--jq*) printf '%s' "$PREVIOUS_CHECK_ID"; exit "$SNAPSHOT_EXIT";; esac\nprintf '%s' "$CHECK_RESPONSE"\nexit "$CHECK_EXIT"\n`);
  chmodSync(gh, 0o755);
  const codex = write("codex", "#!/bin/sh\necho codex-cli-test\n");
  chmodSync(codex, 0o755);
  const bin = join(root, "needlefish");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$CODEX_REASONING_EFFORT $* tier:\${CODEX_SERVICE_TIER:-standard}" >> ${shq(log)}`,
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
      CODEX_BIN: codex,
      PREVIOUS_CHECK_ID: String(previousCheckId),
      SNAPSHOT_EXIT: String(snapshotExit),
      NEEDLEFISH_BIN: bin,
      PR_NUM: "7",
      NEEDLEFISH_RUNNER_INPUT: runner,
      CODEX_SERVICE_TIER: tier,
      NEEDLEFISH_MODEL_INPUT: MODEL,
      NEEDLEFISH_MODEL_FALLBACKS: FALLBACK,
      CODEX_PROXY_BASE_URL_INPUT: "https://controlled.invalid/v1",
      CODEX_PROXY_API_KEY_INPUT: "controlled-test-key",
      CODEX_REASONING_EFFORT: "high",
      GITHUB_RUN_ID: "123",
      GITHUB_REPOSITORY: "owner/repo",
      PR_HEAD_SHA: "a".repeat(40),
      CHECK_RESPONSE: checkResponse ?? JSON.stringify({ check_runs: checks }),
      CHECK_EXIT: String(checkExit),
      NEEDLEFISH_TIMEOUT_MS_INPUT: "",
      OPENCODE_IDLE_TIMEOUT_MS_INPUT: "",
      NEEDLEFISH_RECHECK_INPUT: "",
      NEEDLEFISH_CHECK_APP_ID: appId,
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

for (const exitCode of [0, 1]) {
  test(`a same-head skip with exit ${exitCode} is not an operational failure`, (t) => {
    const result = runReviewScript(t, {
      primary: {
        out: `needlefish-skip ${JSON.stringify({ reason: "same_head", prNumber: 7, headSha: "a".repeat(40) })}`,
        err: "",
        code: exitCode,
      },
      fallback: { out: "", err: "", code: 0 },
    });

    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.invocations.length, 1);
  });
}

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

function runnerCheck(overrides = {}) {
  return {
    id: 1, name: "Needlefish", external_id: "123", app: { slug: "github-actions" },
    status: "completed", conclusion: "failure",
    output: { title: "Needlefish: review failed", summary: "Review errored and did NOT pass this PR.\n\n```\ncodex runner exited 1; likely cause: auth rejected; stderr withheld\n```" },
    ...overrides,
  };
}

test("installed runner auth misclassification uses this run check and Sol medium only on fallback", t => {
  for (const out of ["", outcome({ outcome: "failure", operational: false })]) {
    const result = runReviewScript(t, {
      primary: { out, err: "needlefish review failed: codex runner exited 1; likely cause: auth rejected", code: 1 },
      fallback: { out: outcome({ outcome: "verdict", verdict: "pass" }), err: "", code: 0 },
      checks: [runnerCheck()],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.invocations.length, 2);
    assert.match(result.invocations[0], /^high .*--model primary-model/);
    assert.match(result.invocations[1], /^medium .*--model gpt-6\.1-sol/);
  }
});

test("check lookup stays closed for old runs, other apps, nonterminal checks and verdicts", t => {
  for (const checks of [
    [runnerCheck({ external_id: "older-run" })],
    [runnerCheck({ external_id: JSON.stringify({ v: 2, prNumber: 7, runId: "older-run", roundId: "round", recoveryAttempt: 0 }) })],
    [runnerCheck({ external_id: JSON.stringify({ v: 1, runId: "123" }) })],
    [runnerCheck({ external_id: JSON.stringify({ v: 2, prNumber: 8, runId: "123", roundId: "other", recoveryAttempt: 0 }) })],
    [runnerCheck({ app: { slug: "other-app" } })],
    [runnerCheck({ status: "in_progress" })],
    [runnerCheck({ output: { title: "Needlefish: changes requested", summary: "codex runner exited 1; 429" } })],
    [runnerCheck({ output: { title: "Needlefish: review failed", summary: "Review errored and did NOT pass this PR.\n\n```\ninvalid severity \"codex runner exited 1;\"\n```" } })],
    [runnerCheck(), runnerCheck({ id: 2, conclusion: "success" })],
  ]) {
    const result = runReviewScript(t, { primary: { out: "", err: "", code: 1 }, fallback: { out: "", err: "", code: 0 }, checks });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.invocations.length, 1);
  }
  const malformed = runReviewScript(t, { primary: { out: "", err: "", code: 1 }, fallback: { out: "", err: "", code: 0 }, checkResponse: "not JSON" });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.invocations.length, 1);
});

test("failed check API cannot authorize fallback even with a valid body", t => {
  const result = runReviewScript(t, { primary: { out: "", err: "", code: 1 }, fallback: { out: "", err: "", code: 0 }, checks: [runnerCheck()], checkExit: 1 });
  assert.equal(result.status, 1);
  assert.equal(result.invocations.length, 1);
});

test("Sol fallback is disabled for incompatible runners", t => {
  for (const runner of ["claude", "opencode", "grok", "pi"]) {
    const result = runReviewScript(t, { runner, primary: { out: outcome({ outcome: "failure", operational: true }), err: "", code: 1 }, fallback: { out: "", err: "", code: 0 } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.invocations.length, 1, runner);
  }
});

test("fallback does not inherit primary fast tier", t => {
  const result = runReviewScript(t, { tier: "fast", primary: { out: outcome({ outcome: "failure", operational: true }), err: "", code: 1 }, fallback: { out: "PASS", err: "", code: 0 } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.invocations[0], /tier:fast$/);
  assert.match(result.invocations[1], /^medium .*tier:standard$/);
});

test("an exhausted shared review deadline never starts a fresh fallback budget", t => {
  const checks = [runnerCheck({ output: { title: "Needlefish: review failed", summary: "Review errored and did NOT pass this PR.\n\n```\nNeedlefish review deadline exceeded\n```" } })];
  const result = runReviewScript(t, { primary: { out: outcome({ outcome: "failure", operational: false }), err: "", code: 1 }, fallback: { out: "PASS", err: "", code: 0 }, checks });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.invocations.length, 1);
});

test("compatibility fallback requires a check created after this invocation snapshot", t => {
  for (const [previousCheckId, id, snapshotExit, expected] of [[1, 1, 0, 1], [1, 2, 0, 2], [0, 2, 1, 1]]) {
    const result = runReviewScript(t, { previousCheckId, snapshotExit, primary: { out: "", err: "", code: 1 }, fallback: { out: "PASS", err: "", code: 0 }, checks: [runnerCheck({ id })] });
    assert.equal(result.invocations.length, expected, result.stderr);
    assert.equal(result.status, expected === 2 ? 0 : 1, result.stderr);
  }
});

test("versioned delivery metadata preserves this workflow run fallback", t => {
 const result = runReviewScript(t, {
  primary: { out: "", err: "", code: 1 },
  fallback: { out: outcome({ outcome: "verdict", verdict: "pass" }), err: "", code: 0 },
  checks: [runnerCheck({ external_id: JSON.stringify({ v: 2, prNumber: 7, runId: "123", roundId: "round", recoveryAttempt: 0 }) })],
 });
 assert.equal(result.status, 0, result.stderr);
 assert.equal(result.invocations.length, 2);
 assert.match(result.invocations[1], /--model gpt-6\.1-sol/);
});

test("compatibility fallback honors the configured check App ID", t => {
  const primary = { out: "", err: "", code: 1 };
  const fallback = { out: "PASS", err: "", code: 0 };
  const custom = runnerCheck({ app: { id: 4812, slug: "private-review-app" } });
  for (const [appId, expected] of [["4812", 2], ["9999", 1], ["", 1], ["invalid", 1]]) {
    const result = runReviewScript(t, { primary, fallback, checks: [custom], appId });
    assert.equal(result.invocations.length, expected, `App ID ${appId}: ${result.stderr}`);
    assert.equal(result.status, expected === 2 ? 0 : 1, result.stderr);
  }
});
