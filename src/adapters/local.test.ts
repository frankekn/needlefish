import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocal } from "./local";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures";

test("runLocal fails loudly when explicit PR metadata cannot be fetched", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const gh = path.join(fakeBin, "gh");
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "README.md"), "feature\n");
  commitAll(repo, "feature");

  mkdirSync(fakeBin);
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env node",
      "process.stderr.write('gh auth required');",
      "process.exit(1);",
    ].join("\n")
  );
  chmodSync(gh, 0o755);
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

  await assert.rejects(
    () => runLocal(repo, { pr: 24 }),
    /--pr 24 requested, but PR metadata could not be fetched: gh pr view 24/
  );
});
