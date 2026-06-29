import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha } from "./codex-runner-test-fixtures";
import { ensurePrCommits, prDiffFromShas, type PrRefInfo } from "./repo";

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
