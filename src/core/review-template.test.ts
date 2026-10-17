import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initRepo, headSha } from "../shared/codex-runner-test-fixtures.js";
import type { Bundle } from "../shared/schema.js";
import { explainFinding } from "./explain.js";
import { loadPrompt } from "./prompts.js";
import { review } from "./review.js";

const hostile = "literal {{PATCH}} {{BASE}} {{HEAD}} {{FINDINGS}} {{BUNDLE}} {{AGENTS}} {{PR_META}} {{HOTSPOT}} {{FOCUS}} $& $` $' 雪🐟";

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing section ${start}`);
  const until = text.indexOf(end, from + start.length);
  assert.notEqual(until, -1, `missing section ${end}`);
  return text.slice(from + start.length, until);
}

for (const mode of ["small", "large", "explain"] as const) {
  for (const attack of ["ordinary", "context", "candidate"] as const) {
    if (mode === "explain" && attack === "candidate") continue;
    test(`${mode} runner receives ${attack === "ordinary" ? "byte-identical ordinary prompts" : `literal hostile ${attack} data`}`, async (t) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-template-"));
      const repo = initRepo(tmp);
      const bin = path.join(tmp, "fake.cjs");
      const text = attack === "context" ? hostile : "ordinary payload";
      const candidateText = attack === "ordinary" ? "ordinary payload" : hostile;
      const candidate = {
        summary: candidateText,
        findings: [{ severity: "P2", category: "bug", file: "README.md", title: "Preserve input", whyItBreaks: candidateText, suggestedFix: candidateText, lineStart: 1, lineEnd: 1, confidence: 0.9, validation: candidateText }],
        checked: [`EVIDENCE finding:Preserve input changed=README.md:1 effect=${candidateText}`],
        residual_risks: [{ text: candidateText, blocks: false }],
      };
      const hotspot = { name: "one surface", files: ["README.md"], why: text, risk: "high", edges: [] };
      const map = { summary: text, hotspots: [hotspot] };
      const previous = { ...process.env };
      t.after(() => {
        for (const key of ["CODEX_BIN", "CODEX_RETRY_MS", "NEEDLEFISH_RUNNER", "NEEDLEFISH_MODEL"]) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
        rmSync(tmp, { recursive: true, force: true });
      });
      writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const kind = input.includes('adversarial critic') ? 'critic' : input.includes('review-MAP pass') ? 'map' : input.includes('doing a DEEP review') ? 'deep' : ${JSON.stringify(mode === "explain" ? "explain" : "review")};
  fs.writeFileSync(${JSON.stringify(tmp)} + '/' + kind + '.txt', input);
  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];
  fs.writeFileSync(out, kind === 'map' ? ${JSON.stringify(JSON.stringify(map))} : kind === 'explain' ? 'Explanation preserved.' : ${JSON.stringify(JSON.stringify(candidate))});
});
`);
      chmodSync(bin, 0o755);
      process.env.CODEX_BIN = bin;
      process.env.CODEX_RETRY_MS = "1";
      process.env.NEEDLEFISH_RUNNER = "codex";
      process.env.NEEDLEFISH_MODEL = "gpt-5.6-terra";
      const bundle: Bundle = {
        repoPath: repo,
        baseSha: "base-ref",
        headSha: headSha(repo),
        patch: `diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-fixture\n+${text}\n`,
        patchStat: ` README.md | 1 +\n ${text}\n 1 file changed`,
        changedFiles: [{ path: "README.md", surface: "source" }],
        agentsMd: text,
        prMeta: { number: 1, title: text, body: text, comments: [text], reviews: [], checks: [] },
        focus: text,
        deep: mode === "large",
      };
      const captured = (kind: string) => {
        const input = readFileSync(path.join(tmp, `${kind}.txt`), "utf8");
        const clone: unknown = JSON.parse(input.match(/^The repository to inspect is ("[^\n]+?")\./)?.[1] ?? "null");
        assert.equal(typeof clone, "string");
        assert.notEqual(clone, repo);
        return input.slice(input.indexOf("You are")).replaceAll(JSON.stringify(clone), JSON.stringify(repo));
      };
      const { patch, ...meta } = bundle;
      if (mode === "explain") {
        assert.equal(await explainFinding(bundle, "README.md:1", { runner: "codex" }), "Explanation preserved.");
        const prompt = captured("explain");
        assert.deepEqual(JSON.parse(between(prompt, "# Context bundle\n", "\n# Diff")), meta);
        assert.equal(between(prompt, "===== BEGIN DIFF (base..head) =====\n", "\n===== END DIFF ====="), patch);
        if (attack === "ordinary") assert.equal(prompt, loadPrompt("explain.md").replace("{{FINDING_KEY}}", "README.md:1").replace("{{BUNDLE}}", () => JSON.stringify(meta, null, 2)).replace("{{PATCH}}", () => patch));
        return;
      }
      const result = await review(bundle, { runner: "codex" });
      assert.equal(result.verdict, "changes_requested");
      assert.equal(result.findings[0]?.whyItBreaks, candidateText);
      if (mode === "small") {
        const prompt = captured("review");
        assert.deepEqual(JSON.parse(between(prompt, "# Context bundle\n", "\n# Diff")), meta);
        assert.equal(between(prompt, "===== BEGIN DIFF (base..head) =====\n", "\n===== END DIFF ====="), patch);
        if (attack === "ordinary") assert.equal(prompt, loadPrompt("review.md").replace("{{BUNDLE}}", () => JSON.stringify(meta, null, 2)).replace("{{PATCH}}", () => patch));
      } else {
        const mapBundle = { baseSha: bundle.baseSha, headSha: bundle.headSha, patchStat: bundle.patchStat, changedFiles: bundle.changedFiles, untrackedSkipped: bundle.untrackedSkipped, agentsMd: bundle.agentsMd, prMeta: bundle.prMeta, focus: bundle.focus, deep: bundle.deep };
        const mapPrompt = captured("map");
        assert.deepEqual(JSON.parse(mapPrompt.split("# Context bundle\n")[1] ?? ""), JSON.parse(JSON.stringify(mapBundle)));
        const prompt = captured("deep");
        assert.deepEqual(JSON.parse(between(prompt, "# PR metadata\n", "\n# AGENTS.md")), bundle.prMeta);
        assert.equal(between(prompt, "# AGENTS.md\n", "\n# Hotspot"), `${text}\n`);
        assert.deepEqual(JSON.parse(between(prompt, "# Hotspot (this surface)\n", "\n# Refs")), hotspot);
        assert.equal(prompt.slice(prompt.indexOf("# Refs\n")), `# Refs\nBASE: ${bundle.baseSha}\nHEAD: ${bundle.headSha}\nFocus: ${text} (if not "(none)", prioritize findings in that area)\n`);
        if (attack === "ordinary") {
          assert.equal(mapPrompt, loadPrompt("map.md").replace("{{BUNDLE}}", () => JSON.stringify(mapBundle, null, 2)));
          assert.equal(prompt, loadPrompt("deep.md").replace("{{AGENTS}}", () => text).replace("{{PR_META}}", () => JSON.stringify(bundle.prMeta, null, 2)).replace("{{HOTSPOT}}", () => JSON.stringify(hotspot, null, 2)).replace("{{FOCUS}}", text).replace("{{BASE}}", bundle.baseSha).replace("{{HEAD}}", bundle.headSha));
        }
      }
      const criticCandidate = mode === "large"
        ? { ...candidate, summary: text, checked: [`[one surface] ${text}`, ...candidate.checked] }
        : candidate;
      const critic = captured("critic");
      assert.deepEqual(JSON.parse(between(critic, "# Candidate findings\n", "\n# Diff stat")), criticCandidate);
      const criticPatch = mode === "small" ? patch : bundle.patchStat;
      assert.equal(between(critic, "# Diff stat (repo at HEAD — use git diff to read hunks on demand)\n", "\n# Refs"), `${criticPatch}\n`);
      assert.equal(critic.slice(critic.indexOf("# Refs\n")), `# Refs\nBASE: ${bundle.baseSha}\nHEAD: ${bundle.headSha}\n`);
      if (attack === "ordinary") assert.equal(critic, loadPrompt("critic.md").replace("{{FINDINGS}}", () => JSON.stringify(criticCandidate, null, 2)).replace("{{PATCH}}", () => criticPatch).replace("{{BASE}}", bundle.baseSha).replace("{{HEAD}}", bundle.headSha));
    });
  }
}
