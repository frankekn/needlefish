import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchTouchesGatingPredicate, review } from "./review";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import type { Bundle } from "../shared/schema";

test("review preserves deep evidence through tail coverage", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      "  const finding = { severity: 'P2', title: 'Deep bug', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'The changed path breaks.', suggestedFix: 'Fix the path.', validation: 'pnpm test' };",
      "  const evidence = 'EVIDENCE finding:Deep bug changed=src/app.ts:1 effect=bad path';",
      "  if (input.includes('review-MAP pass')) {",
      "    if (!input.includes('Review body') || !input.includes('review comment')) { process.stderr.write('missing map PR metadata'); process.exit(1); }",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'consumer', files: ['src/unchanged.ts'], why: 'consumer only', risk: 'high', edges: [] }] }));",
      "    return;",
      "  }",
      "  if (input.includes('doing a DEEP review')) {",
      "    if (!input.includes('tail-coverage') || !input.includes('src/app.ts')) { process.stderr.write('missing tail coverage'); process.exit(1); }",
      "    if (!input.includes('Review body') || !input.includes('review comment')) { process.stderr.write('missing deep PR metadata'); process.exit(1); }",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'deep found blocker', findings: [finding], checked: [evidence], residual_risks: [] }));",
      "    return;",
      "  }",
      "  if (input.includes('adversarial critic')) {",
      "    if (!input.includes(evidence)) { process.stderr.write('missing deep evidence'); process.exit(1); }",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'critic kept blocker', findings: [finding], checked: [evidence], residual_risks: [] }));",
      "    return;",
      "  }",
      "  process.stderr.write('unexpected prompt');",
      "  process.exit(1);",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "short",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: {
      number: 123,
      title: "PR title",
      body: "Review body",
      comments: ["review comment"],
      reviews: [],
      checks: [],
    },
    deep: true,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "changes_requested");
  assert.deepEqual(result.checked, [
    "EVIDENCE finding:Deep bug changed=src/app.ts:1 effect=bad path",
  ]);
});

test("review aborts deep fallback when a non-codex runner dirties the sandbox", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
  const previous = process.env.CLAUDE_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (input.includes('review-MAP pass')) {",
      "    process.stdout.write(JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'changed', files: ['src/app.ts'], why: 'changed file', risk: 'high', edges: [] }] }));",
      "    return;",
      "  }",
      "  if (input.includes('doing a DEEP review')) {",
      "    fs.writeFileSync('runner-wrote.txt', 'dirty');",
      "    process.stdout.write(JSON.stringify({ summary: 'deep', findings: [], checked: ['deep checked'], residual_risks: [] }));",
      "    return;",
      "  }",
      "  process.stderr.write('unexpected prompt');",
      "  process.exit(1);",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "short",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: true,
    focus: null,
  };

  await assert.rejects(
    () => review(bundle, { runner: "claude", timeoutMs: 1000 }),
    /claude runner changed the review sandbox worktree/
  );
});

test("review keeps deep failure residuals after critic pruning", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      "  if (input.includes('review-MAP pass')) {",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'changed', files: ['src/app.ts'], why: 'changed file', risk: 'high', edges: [] }] }));",
      "    return;",
      "  }",
      "  if (input.includes('doing a DEEP review')) {",
      "    fs.writeFileSync(out, 'not json');",
      "    return;",
      "  }",
      "  if (input.includes('adversarial critic')) {",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'critic pruned', findings: [], checked: ['critic checked'], residual_risks: [] }));",
      "    return;",
      "  }",
      "  process.stderr.write('unexpected prompt');",
      "  process.exit(1);",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";
  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "short",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: true,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "needs_human");
  assert.match(result.residualRisks[0]?.text ?? "", /deep review of "changed" failed/);
});

test("review re-asks once when the model emits malformed JSON", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const calls = path.join(tmp, "calls.log");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `  const calls = ${JSON.stringify(calls)};`,
      "  const review = { summary: 'clean', findings: [], checked: ['looked at diff'], residual_risks: [] };",
      "  if (input.includes('adversarial critic')) {",
      "    fs.appendFileSync(calls, 'critic\\n');",
      "    fs.writeFileSync(out, JSON.stringify(review));",
      "    return;",
      "  }",
      "  fs.appendFileSync(calls, 'review\\n');",
      "  const reviews = fs.readFileSync(calls, 'utf8').split('\\n').filter((line) => line === 'review').length;",
      "  fs.writeFileSync(out, reviews === 1 ? 'not json at all' : JSON.stringify(review));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "short",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "pass");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["review", "review", "critic"]);
  assert.deepEqual(result.stats?.map((s) => s.label), ["review", "review", "critic"]);
  assert.ok(result.stats?.every((s) => s.ok && s.attempts === 1 && s.durationMs > 0));
  assert.ok((result.totalDurationMs ?? 0) > 0);
});

test("review fails after a second malformed response", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const calls = path.join(tmp, "calls.log");
  const previous = process.env.CODEX_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `  fs.appendFileSync(${JSON.stringify(calls)}, 'review\\n');`,
      "  fs.writeFileSync(out, 'still not json');",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "short",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  await assert.rejects(() => review(bundle), /no JSON object found/);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["review", "review"]);
});

test("review does not re-ask after a runner safety error", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
  const calls = path.join(tmp, "calls.log");
  const previous = process.env.CLAUDE_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(calls)}, 'review\\n');`,
      "  fs.writeFileSync('runner-wrote.txt', 'dirty');",
      "  process.stdout.write(JSON.stringify({ summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "short",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  await assert.rejects(
    () => review(bundle, { runner: "claude", timeoutMs: 5000 }),
    /claude runner changed the review sandbox worktree/
  );
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["review"]);
});

test("review runs deep passes concurrently and keeps hotspot order", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
    concurrency: process.env.NEEDLEFISH_DEEP_CONCURRENCY,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    if (previous.concurrency === undefined) delete process.env.NEEDLEFISH_DEEP_CONCURRENCY;
    else process.env.NEEDLEFISH_DEEP_CONCURRENCY = previous.concurrency;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const tmp = ${JSON.stringify(tmp)};`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      "  if (input.includes('review-MAP pass')) {",
      "    const hotspot = (name, file) => ({ name, files: [file], why: 'changed', risk: 'high', edges: [] });",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [hotspot('h1', 'src/a.ts'), hotspot('h2', 'src/b.ts'), hotspot('h3', 'src/c.ts')] }));",
      "    return;",
      "  }",
      "  if (input.includes('doing a DEEP review')) {",
      "    const name = /\"name\": \"(h\\d)\"/.exec(input)[1];",
      "    const delays = { h1: 800, h2: 500, h3: 200 };",
      "    const start = Date.now();",
      "    setTimeout(() => {",
      "      fs.writeFileSync(path.join(tmp, `deep-${name}.json`), JSON.stringify({ start, end: Date.now() }));",
      "      fs.writeFileSync(out, JSON.stringify({ summary: `deep ${name}`, findings: [], checked: [`checked ${name}`], residual_risks: [] }));",
      "    }, delays[name]);",
      "    return;",
      "  }",
      "  if (input.includes('adversarial critic')) {",
      "    const candidate = input.slice(input.indexOf('# Candidate findings') + '# Candidate findings'.length, input.indexOf('# Diff stat'));",
      "    fs.writeFileSync(out, JSON.stringify(JSON.parse(candidate)));",
      "    return;",
      "  }",
      "  process.stderr.write('unexpected prompt');",
      "  process.exit(1);",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";
  process.env.NEEDLEFISH_DEEP_CONCURRENCY = "3";

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "short",
    patchStat: " src/a.ts | 1 +",
    changedFiles: [
      { path: "src/a.ts", surface: "source" },
      { path: "src/b.ts", surface: "source" },
      { path: "src/c.ts", surface: "source" },
    ],
    agentsMd: "(none)",
    prMeta: null,
    deep: true,
    focus: null,
  };

  const result = await review(bundle);

  assert.deepEqual(result.checked, [
    "[h1] deep h1",
    "checked h1",
    "[h2] deep h2",
    "checked h2",
    "[h3] deep h3",
    "checked h3",
  ]);
  const windows = ["h1", "h2", "h3"].map(
    (name) =>
      JSON.parse(readFileSync(path.join(tmp, `deep-${name}.json`), "utf8")) as {
        start: number;
        end: number;
      }
  );
  const overlaps = windows.some((a, i) =>
    windows.some((b, j) => i < j && a.start < b.end && b.start < a.end)
  );
  assert.ok(overlaps, "expected at least two deep passes to overlap in time");
  const labels = new Set(result.stats?.map((s) => s.label));
  for (const expected of ["map", "deep:h1", "deep:h2", "deep:h3", "critic"]) {
    assert.ok(labels.has(expected), `missing stat label ${expected}`);
  }
});

test("review feeds the diff as raw text, not escaped bundle JSON", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = process.env.CODEX_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      "  const review = { summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] };",
      "  if (input.includes('adversarial critic')) {",
      "    fs.writeFileSync(out, JSON.stringify(review));",
      "    return;",
      "  }",
      "  if (!input.includes('===== BEGIN DIFF (base..head) =====')) { process.stderr.write('missing diff sentinel'); process.exit(1); }",
      "  if (!input.includes('diff --git a/src/app.ts b/src/app.ts\\n+const answer = 42;')) { process.stderr.write('diff not raw text'); process.exit(1); }",
      "  if (input.includes('\"patch\"')) { process.stderr.write('patch leaked into bundle json'); process.exit(1); }",
      "  fs.writeFileSync(out, JSON.stringify(review));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "diff --git a/src/app.ts b/src/app.ts\n+const answer = 42;\n",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "pass");
});

test("review large thresholds are env-overridable", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = {
    bin: process.env.CODEX_BIN,
    chars: process.env.NEEDLEFISH_LARGE_PATCH_CHARS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.chars === undefined) delete process.env.NEEDLEFISH_LARGE_PATCH_CHARS;
    else process.env.NEEDLEFISH_LARGE_PATCH_CHARS = previous.chars;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      "  if (input.includes('review-MAP pass')) {",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'h1', files: ['src/app.ts'], why: 'changed', risk: 'high', edges: [] }] }));",
      "    return;",
      "  }",
      "  if (input.includes('doing a DEEP review')) {",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'deep h1', findings: [], checked: ['checked h1'], residual_risks: [] }));",
      "    return;",
      "  }",
      "  if (input.includes('adversarial critic')) {",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'critic done', findings: [], checked: ['critic checked'], residual_risks: [] }));",
      "    return;",
      "  }",
      "  process.stderr.write('unexpected prompt');",
      "  process.exit(1);",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.NEEDLEFISH_LARGE_PATCH_CHARS = "5";

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "longer than five characters",
    patchStat: " src/app.ts | 1 +",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  const labels = result.stats?.map((s) => s.label) ?? [];
  assert.ok(labels.includes("map"), "expected the large path (map pass) to run");
});

test("review runs a gating sweep before critic when the patch touches a predicate", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const calls = path.join(tmp, "calls.log");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `  const calls = ${JSON.stringify(calls)};`,
      "  const finding = { severity: 'P2', title: 'Keep draft save available', category: 'bug', file: 'src/app.ts', lineStart: 2, lineEnd: 2, confidence: 0.9, whyItBreaks: 'The tightened predicate rejects save-draft even though payment only governs submit.', suggestedFix: 'Split the draft action from the payment gate.', validation: 'pnpm test', consumerFile: 'src/app.ts', consumerLine: 8 };",
      "  if (input.includes('focused over-block gating sweep')) {",
      "    fs.appendFileSync(calls, 'sweep\\n');",
      "    fs.writeFileSync(out, JSON.stringify({ summary: 'sweep found over-block', findings: [finding], checked: ['EVIDENCE finding:Keep draft save available changed=src/app.ts:2 effect=save-draft blocked'], residual_risks: [] }));",
      "    return;",
      "  }",
      "  if (input.includes('adversarial critic')) {",
      "    fs.appendFileSync(calls, 'critic\\n');",
      "    const candidate = input.slice(input.indexOf('# Candidate findings') + '# Candidate findings'.length, input.indexOf('# Diff stat')).trim();",
      "    fs.writeFileSync(out, JSON.stringify({ ...JSON.parse(candidate), residual_risks: [] }));",
      "    return;",
      "  }",
      "  fs.appendFileSync(calls, 'review\\n');",
      "  fs.writeFileSync(out, JSON.stringify({ summary: 'main clean', findings: [], checked: ['main checked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "diff --git a/src/app.ts b/src/app.ts\n-export function canApprove(order: Order) { return true; }\n+export function canApprove(order: Order) { return order.paid; }\n",
    patchStat: " src/app.ts | 2 +-",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "changes_requested");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["review", "sweep", "critic"]);
  assert.equal(result.findings[0]?.title, "Keep draft save available");
  assert.deepEqual(result.stats?.map((s) => s.label), ["review", "sweep", "critic"]);
});

test("review skips gating sweep when the patch does not touch a predicate", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const calls = path.join(tmp, "calls.log");
  const previous = process.env.CODEX_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `  const calls = ${JSON.stringify(calls)};`,
      "  const review = { summary: 'clean', findings: [], checked: ['checked'], residual_risks: [] };",
      "  if (input.includes('focused over-block gating sweep')) { process.stderr.write('unexpected sweep'); process.exit(1); }",
      "  if (input.includes('adversarial critic')) { fs.appendFileSync(calls, 'critic\\n'); fs.writeFileSync(out, JSON.stringify(review)); return; }",
      "  fs.appendFileSync(calls, 'review\\n');",
      "  fs.writeFileSync(out, JSON.stringify(review));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "diff --git a/src/app.ts b/src/app.ts\n-const label = 'old';\n+const label = 'new';\n",
    patchStat: " src/app.ts | 2 +-",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "pass");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["review", "critic"]);
  assert.deepEqual(result.stats?.map((s) => s.label), ["review", "critic"]);
});

test("review records a non-blocking residual when gating sweep output is malformed twice", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const calls = path.join(tmp, "calls.log");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `  const calls = ${JSON.stringify(calls)};`,
      "  const review = { summary: 'main clean', findings: [], checked: ['main checked'], residual_risks: [] };",
      "  if (input.includes('focused over-block gating sweep')) { fs.appendFileSync(calls, 'sweep\\n'); fs.writeFileSync(out, 'not json'); return; }",
      "  if (input.includes('adversarial critic')) {",
      "    fs.appendFileSync(calls, 'critic\\n');",
      "    const candidate = input.slice(input.indexOf('# Candidate findings') + '# Candidate findings'.length, input.indexOf('# Diff stat')).trim();",
      "    fs.writeFileSync(out, JSON.stringify({ ...JSON.parse(candidate), residual_risks: [] }));",
      "    return;",
      "  }",
      "  fs.appendFileSync(calls, 'review\\n');",
      "  fs.writeFileSync(out, JSON.stringify(review));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "diff --git a/src/app.ts b/src/app.ts\n-export function canApprove(order: Order) { return true; }\n+export function canApprove(order: Order) { return order.paid; }\n",
    patchStat: " src/app.ts | 2 +-",
    changedFiles: [{ path: "src/app.ts", surface: "source" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "pass");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["review", "sweep", "sweep", "critic"]);
  assert.deepEqual(result.checked, ["main checked"]);
  assert.match(result.residualRisks[0]?.text ?? "", /gating sweep failed/);
  assert.equal(result.residualRisks[0]?.blocks, false);
});

test("patchTouchesGatingPredicate detects predicate-shaped diff lines", () => {
  assert.equal(patchTouchesGatingPredicate("+const allowed = canApprove(order);"), true);
  assert.equal(patchTouchesGatingPredicate("-if (!is_valid_state(order)) return false;"), true);
  assert.equal(patchTouchesGatingPredicate("+  return false;"), true);
  assert.equal(patchTouchesGatingPredicate("+Update README wording for the release notes."), false);
  assert.equal(patchTouchesGatingPredicate("+++ b/src/app.ts\n--- a/src/app.ts"), false);
  assert.equal(patchTouchesGatingPredicate("+const renamed = nextName;"), false);
  assert.equal(patchTouchesGatingPredicate("+can approve this doc sentence"), false);
});
