import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review } from "./review";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import type { Bundle } from "../shared/schema";

test("review preserves deep evidence through tail coverage", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
    repoPath: tmp,
    baseSha: "base",
    headSha: "head",
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
