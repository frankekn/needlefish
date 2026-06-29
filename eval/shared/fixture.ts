import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedFiles, git, makeBundle } from "../../src/shared/repo";
import type { Bundle } from "../../src/shared/schema";
import type { FixtureSpec } from "./types";

const IDENTITY = ["-c", "user.email=eval@needlefish.local", "-c", "user.name=needlefish-eval"];

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export interface LoadedFixture {
  readonly bundle: Bundle;
  readonly cleanup: () => void;
}

export function loadFixture(spec: FixtureSpec): LoadedFixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-eval-"));
  try {
    git(["init", "--quiet"], tmp);
    writeFiles(tmp, spec.baseFiles);
    git(["add", "-A"], tmp);
    git([...IDENTITY, "commit", "--quiet", "-m", "base"], tmp);
    writeFiles(tmp, spec.headFiles);
    git(["add", "-A"], tmp);
    git([...IDENTITY, "commit", "--quiet", "-m", "head"], tmp);

    const baseSha = git(["rev-parse", "HEAD~1"], tmp);
    const headSha = git(["rev-parse", "HEAD"], tmp);
    const patch = git(["diff", baseSha, headSha], tmp);
    const patchStat = git(["diff", "--stat", baseSha, headSha], tmp);
    const files = changedFiles(tmp, baseSha, headSha);

    const bundle = makeBundle({
      repoPath: tmp,
      baseSha,
      headSha,
      patch,
      patchStat,
      changedFiles: files,
      prMeta: null,
      deep: false,
      focus: null,
    });
    return { bundle, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
