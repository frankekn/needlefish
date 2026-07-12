import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review } from "./review";
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
      "  fs.writeFileSync(out, 'still not json CANARY-TOKEN-XYZ');",
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

  const rejection = await review(bundle).then(
    () => null,
    (err: unknown) => err
  );
  assert.ok(rejection instanceof Error, "second malformed response must reject");
  assert.match(rejection.message, /no JSON object found/);
  // The raw model output rides along on the error so the eval canary scan
  // can inspect failed attempts — invalid output is not an escape hatch.
  assert.ok(
    (rejection as Error & { rawOutput?: string }).rawOutput?.includes(
      "CANARY-TOKEN-XYZ"
    ),
    "rejection must carry the raw model output"
  );
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

test("review docs-only fast path skips all model calls", async (t) => {
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
      `fs.appendFileSync(${JSON.stringify(calls)}, 'called\\n');`,
      "process.exit(1);",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "diff --git a/README.md b/README.md\n+docs\n",
    patchStat: " README.md | 1 +",
    changedFiles: [
      { path: "README.md", surface: "docs" },
      { path: "docs/guide.md", surface: "docs" },
    ],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.residualRisks, []);
  assert.match(result.summary, /Docs-only change \(2 file\(s\)\); model review skipped\./);
  assert.deepEqual(result.checked, ["FAST_PATH docs-only files=[README.md, docs/guide.md]"]);
  assert.equal(result.stats, undefined, "no stats when model is not called");
  assert.ok((result.totalDurationMs ?? -1) >= 0, "totalDurationMs must be set");
  assert.equal(result.baseSha, "base");
  assert.ok(!existsSync(calls), "runner must not be invoked for docs-only bundle");
});

test("review mixed docs+source bundle still invokes the model", async (t) => {
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
      "  const review = { summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] };",
      "  fs.appendFileSync(" + JSON.stringify(calls) + ", 'x\\n');",
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
    patch: "diff --git a/README.md b/README.md\n+docs\n",
    patchStat: " README.md | 1 +",
    changedFiles: [
      { path: "README.md", surface: "docs" },
      { path: "src/app.ts", surface: "source" },
    ],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "pass");
  assert.ok(existsSync(calls), "runner must be invoked for mixed docs+source bundle");
});

test("review NEEDLEFISH_NO_FAST_PATH disables docs-only fast path", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const calls = path.join(tmp, "calls.log");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
    noFastPath: process.env.NEEDLEFISH_NO_FAST_PATH,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    if (previous.noFastPath === undefined) delete process.env.NEEDLEFISH_NO_FAST_PATH;
    else process.env.NEEDLEFISH_NO_FAST_PATH = previous.noFastPath;
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
      "  fs.appendFileSync(" + JSON.stringify(calls) + ", 'x\\n');",
      "  fs.writeFileSync(out, JSON.stringify(review));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";
  process.env.NEEDLEFISH_NO_FAST_PATH = "1";

  const bundle: Bundle = {
    repoPath: repo,
    baseSha: "base",
    headSha: headSha(repo),
    patch: "diff --git a/README.md b/README.md\n+docs\n",
    patchStat: " README.md | 1 +",
    changedFiles: [{ path: "README.md", surface: "docs" }],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  };

  const result = await review(bundle);

  assert.equal(result.verdict, "pass");
  assert.ok(existsSync(calls), "runner must be invoked when NEEDLEFISH_NO_FAST_PATH is set");
  assert.doesNotMatch(result.summary, /Docs-only change/);
});

// Small-path echo critic: the runner answers both review and critic prompts
// with the same finding. Under NEEDLEFISH_EVAL_TRACE the result must expose
// the pre-critic candidate findings; without it, the field stays absent.
function evalTraceEchoBundle(repo: string): Bundle {
  return {
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
}

function writeEchoCriticBin(bin: string): void {
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
      "  const finding = { severity: 'P2', title: 'Echo bug', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' };",
      "  fs.writeFileSync(out, JSON.stringify({ summary: 'clean', findings: [finding], checked: ['looked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
}

test("review records candidateFindings when NEEDLEFISH_EVAL_TRACE is set (small path)", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
    trace: process.env.NEEDLEFISH_EVAL_TRACE,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
    else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeEchoCriticBin(bin);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";
  process.env.NEEDLEFISH_EVAL_TRACE = "1";

  const result = await review(evalTraceEchoBundle(repo));

  assert.ok(result.candidateFindings, "candidateFindings must be present under NEEDLEFISH_EVAL_TRACE");
  assert.equal(result.candidateFindings!.length, 1);
  assert.equal(result.candidateFindings![0].title, "Echo bug");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, "Echo bug");
});

test("review omits candidateFindings when NEEDLEFISH_EVAL_TRACE is unset (small path)", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
    trace: process.env.NEEDLEFISH_EVAL_TRACE,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
    else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeEchoCriticBin(bin);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";
  delete process.env.NEEDLEFISH_EVAL_TRACE;

  const result = await review(evalTraceEchoBundle(repo));

  assert.equal(result.candidateFindings, undefined, "candidateFindings must be absent without NEEDLEFISH_EVAL_TRACE");
  assert.equal(result.findings.length, 1);
});
