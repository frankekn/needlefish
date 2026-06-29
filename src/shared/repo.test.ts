import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha } from "./codex-runner-test-fixtures";
import { ensurePrCommits, makeBundle, prDiffFromShas, type PrRefInfo } from "./repo";

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
