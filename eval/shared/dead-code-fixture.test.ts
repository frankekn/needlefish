import assert from "node:assert/strict";
import test from "node:test";
import spec, { applicationContract } from "../fixtures/neg-hard-dead-code-delete/spec";
import { git } from "../../src/shared/repo";
import { loadFixture } from "./fixture";

test("dead-code fixture bundles the unchanged application contract from both commits", () => {
  const loaded = loadFixture(spec, "policy-contract-canary");
  try {
    const { bundle } = loaded;
    assert.match(bundle.agentsMd ?? "", /closed application/);
    assert.equal(bundle.agentsMd, applicationContract.trim());
    for (const ref of [bundle.baseSha, bundle.headSha]) {
      assert.equal(git(["show", `${ref}:AGENTS.md`], bundle.repoPath), applicationContract.trim());
    }
    assert.deepEqual(bundle.changedFiles.map((file) => file.path), [
      "ids/format.go",
      "ids/format_test.go",
    ]);
    assert.match(bundle.patch, /-func FormatLegacyID\(n int64\) string/);
    assert.doesNotMatch(bundle.patch, /AGENTS\.md|policy-contract-canary/);
    assert.deepEqual(spec.expected, { verdict: "pass", noBlockingFindings: true });
  } finally {
    loaded.cleanup();
  }
});
