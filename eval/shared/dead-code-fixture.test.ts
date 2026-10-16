import assert from "node:assert/strict";
import test from "node:test";
import spec from "../fixtures/neg-hard-dead-code-delete/spec";
import { git } from "../../src/shared/repo";
import { loadFixture } from "./fixture";

test("dead-code fixture bundles the unchanged application contract from both commits", () => {
  const loaded = loadFixture(spec, "policy-contract-canary");
  try {
    const policy = `# Application contract

This repository contains a closed application. All packages are used only by this application.
There are no package consumers outside this repository.
Exported Go identifiers carry no public API or compatibility promise.
`;
    const { bundle } = loaded;
    assert.equal(bundle.agentsMd, policy.trim());
    for (const ref of [bundle.baseSha, bundle.headSha]) {
      assert.equal(git(["show", `${ref}:AGENTS.md`], bundle.repoPath), policy.trim());
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
