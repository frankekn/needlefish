import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha } from "./codex-runner-test-fixtures";
import { changedFiles, ensurePrCommits, git, makeBundle, prDiffFromShas, type PrRefInfo } from "./repo";

test("ensurePrCommits fetches enough history for a shallow PR graph", () => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-repo-"));
  try {
    const work = join(tmp, "work");
    const remote = join(tmp, "remote.git");
    gitText(["init", "-q", work], tmp);
    gitText(["config", "user.email", "test@example.com"], work);
    gitText(["config", "user.name", "Test"], work);
    writeFileSync(join(work, "root.txt"), "root\n");
    commitAll(work, "root");
    gitText(["branch", "-M", "main"], work);
    gitText(["checkout", "-b", "feature"], work);
    writeFileSync(join(work, "feature.txt"), "feature\n");
    commitAll(work, "feature");
    const targetHeadSha = headSha(work);
    gitText(["checkout", "main"], work);
    writeFileSync(join(work, "base.txt"), "base\n");
    commitAll(work, "base");
    const baseSha = headSha(work);
    gitText(["clone", "--quiet", "--bare", work, remote], tmp);

    const repo = join(tmp, "local");
    gitText(["init", "-q", repo], tmp);
    gitText(["remote", "add", "origin", remote], repo);
    gitText(["fetch", "--quiet", "--depth=1", "origin", baseSha], repo);
    gitText(["fetch", "--quiet", "--depth=1", "origin", targetHeadSha], repo);

    const pr: PrRefInfo = {
      baseSha,
      headSha: targetHeadSha,
      baseRefName: "main",
      headRefName: "feature",
      prMeta: { number: 1, title: "", body: null, comments: [], reviews: [], checks: [] },
    };

    assert.throws(() => prDiffFromShas(repo, baseSha, targetHeadSha));
    ensurePrCommits(repo, pr);
    assert.equal(prDiffFromShas(repo, baseSha, targetHeadSha).headSha, targetHeadSha);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensurePrCommits deepens ready shallow PR graph for sandbox fetch", () => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-repo-"));
  try {
    const work = join(tmp, "work");
    const remote = join(tmp, "remote.git");
    gitText(["init", "-q", work], tmp);
    writeFileSync(join(work, "base.txt"), "base\n");
    commitAll(work, "base");
    gitText(["branch", "-M", "main"], work);
    const baseSha = headSha(work);
    gitText(["checkout", "-b", "feature"], work);
    writeFileSync(join(work, "feature.txt"), "feature\n");
    commitAll(work, "feature");
    const targetHeadSha = headSha(work);
    gitText(["clone", "--quiet", "--bare", work, remote], tmp);

    const repo = join(tmp, "local");
    gitText(["init", "-q", repo], tmp);
    gitText(["remote", "add", "origin", remote], repo);
    gitText(["fetch", "--quiet", "--depth=1", "origin", baseSha], repo);
    gitText(["fetch", "--quiet", "--depth=2", "origin", targetHeadSha], repo);
    assert.equal(gitText(["rev-parse", "--is-shallow-repository"], repo), "true");
    assert.equal(gitText(["merge-base", baseSha, targetHeadSha], repo), baseSha);

    const pr: PrRefInfo = {
      baseSha,
      headSha: targetHeadSha,
      baseRefName: "main",
      headRefName: "feature",
      prMeta: { number: 1, title: "", body: null, comments: [], reviews: [], checks: [] },
    };

    ensurePrCommits(repo, pr);
    const sandbox = join(tmp, "sandbox");
    gitText(["clone", "--quiet", "--no-hardlinks", "--no-checkout", repo, sandbox], tmp);
    gitText(["fetch", "--quiet", repo, targetHeadSha], sandbox);
    gitText(["checkout", "--quiet", "--detach", "FETCH_HEAD"], sandbox);
    assert.equal(headSha(sandbox), targetHeadSha);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prDiffFromShas preserves a diff whose last hunk is a blank context line", () => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-repo-blank-context-"));
  try {
    const work = join(tmp, "work");
    gitText(["init", "-q", work], tmp);
    gitText(["config", "user.email", "test@example.com"], work);
    gitText(["config", "user.name", "Test"], work);
    writeFileSync(join(work, "notes.txt"), "alpha\nbravo\ncharlie\n\n");
    commitAll(work, "trailing blank line");
    const baseSha = headSha(work);
    writeFileSync(join(work, "notes.txt"), "alpha\nBravo\ncharlie\n\n");
    commitAll(work, "change middle line");
    const targetHeadSha = headSha(work);

    const raw = spawnSync("git", ["diff", baseSha, targetHeadSha], {
      cwd: work,
      encoding: "utf8",
    });
    assert.equal(raw.status, 0, raw.stderr);
    assert.ok((raw.stdout ?? "").endsWith(" \n"));

    const diff = prDiffFromShas(work, baseSha, targetHeadSha);
    assert.equal(diff.patch, raw.stdout);
    assert.notEqual(diff.patch, git(["diff", baseSha, targetHeadSha], work));
    assert.equal(git(["merge-base", baseSha, targetHeadSha], work), baseSha);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("makeBundle preserves review target disclosure", () => {
  const bundle = makeBundle({
    repoPath: process.cwd(),
    baseSha: "base",
    headSha: "head",
    patch: "diff",
    patchStat: "stat",
    changedFiles: [],
    reviewTarget: "Review target: local base..head\nPR context: #24 metadata only",
    prMeta: null,
    deep: false,
    focus: null,
  });

  assert.equal(
    bundle.reviewTarget,
    "Review target: local base..head\nPR context: #24 metadata only"
  );
});

// `git diff --name-only` applies rename detection and reports only the
// destination of a rename. A workflow, policy, or source file moved into a
// docs path then looked docs-only to classification, so the fast path passed
// the removal without a model call.
test("changedFiles reports both sides of a rename", () => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-repo-rename-"));
  try {
    const work = join(tmp, "work");
    gitText(["init", "-q", work], tmp);
    mkdirSync(join(work, ".github", "workflows"), { recursive: true });
    writeFileSync(join(work, ".github", "workflows", "ci.yml"), "name: ci\non: push\njobs: {}\n");
    writeFileSync(join(work, "AGENTS.md"), "# policy\nnever run tests\n");
    commitAll(work, "base");
    const baseSha = headSha(work);
    mkdirSync(join(work, "docs"));
    gitText(["mv", ".github/workflows/ci.yml", "docs/ci-notes.md"], work);
    gitText(["mv", "AGENTS.md", "docs/guide.md"], work);
    commitAll(work, "rename into docs");
    const targetHeadSha = headSha(work);

    const paths = changedFiles(work, baseSha, targetHeadSha).map((file) => `${file.surface}:${file.path}`).sort();
    assert.deepEqual(paths, [
      "docs:AGENTS.md",
      "docs:docs/ci-notes.md",
      "docs:docs/guide.md",
      "workflow:.github/workflows/ci.yml",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Newline-delimited pathname output is C-quoted for non-ASCII and control
// bytes; those strings are not paths and misclassify.
test("changedFiles preserves committed pathnames Git would C-quote", () => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-repo-quoted-"));
  try {
    const work = join(tmp, "work");
    gitText(["init", "-q", work], tmp);
    writeFileSync(join(work, "README.md"), "base\n");
    commitAll(work, "base");
    const baseSha = headSha(work);
    const names = ["新功能.ts", " padded .ts", 'quo"te.ts', "back\\slash.ts", "new\nline.ts"];
    for (const name of names) writeFileSync(join(work, name), "export const v = 1;\n");
    commitAll(work, "odd names");
    const targetHeadSha = headSha(work);

    const paths = changedFiles(work, baseSha, targetHeadSha).map((file) => file.path).sort();
    assert.deepEqual(paths, [...names].sort());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
