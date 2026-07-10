import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedFilesFromPaths, git, makeBundle } from "../../src/shared/repo";
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
    const deletedFiles = spec.deletedFiles ?? [];
    const renamedFiles = spec.renamedFiles ?? [];
    const seenDeletedFiles = new Set<string>();
    for (const rel of deletedFiles) {
      if (seenDeletedFiles.has(rel)) throw new Error(`duplicate deletedFiles path: ${rel}`);
      seenDeletedFiles.add(rel);
    }
    const seenRenameFrom = new Set<string>();
    const seenRenameTo = new Set<string>();
    const seenRenameEndpoints = new Set<string>();
    for (const rename of renamedFiles) {
      if (seenRenameFrom.has(rename.from)) throw new Error(`duplicate renamedFiles from path: ${rename.from}`);
      if (seenRenameTo.has(rename.to)) throw new Error(`duplicate renamedFiles to path: ${rename.to}`);
      if (seenRenameEndpoints.has(rename.from)) throw new Error(`duplicate renamedFiles endpoint path: ${rename.from}`);
      if (seenRenameEndpoints.has(rename.to) || rename.to === rename.from) throw new Error(`duplicate renamedFiles endpoint path: ${rename.to}`);
      seenRenameFrom.add(rename.from);
      seenRenameTo.add(rename.to);
      seenRenameEndpoints.add(rename.from);
      seenRenameEndpoints.add(rename.to);
    }
    for (const rename of renamedFiles) {
      if (!seenDeletedFiles.has(rename.from)) throw new Error(`renamedFiles from path is not deleted: ${rename.from}`);
      if (!Object.hasOwn(spec.baseFiles, rename.from)) throw new Error(`renamedFiles from path is absent from baseFiles: ${rename.from}`);
      if (Object.hasOwn(spec.headFiles, rename.from)) throw new Error(`renamedFiles from path still exists in headFiles: ${rename.from}`);
      if (Object.hasOwn(spec.baseFiles, rename.to)) throw new Error(`renamedFiles to path already exists in baseFiles: ${rename.to}`);
      if (!Object.hasOwn(spec.headFiles, rename.to)) throw new Error(`renamedFiles to path is absent from headFiles: ${rename.to}`);
    }

    git(["init", "--quiet"], tmp);
    writeFiles(tmp, spec.baseFiles);
    git(["add", "-A"], tmp);
    git([...IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "base"], tmp);
    for (const rel of deletedFiles) {
      rmSync(path.join(tmp, rel));
    }
    writeFiles(tmp, spec.headFiles);
    git(["add", "-A"], tmp);
    git([...IDENTITY, "commit", "--quiet", "-m", "head"], tmp);

    const baseSha = git(["rev-parse", "HEAD~1"], tmp);
    const headSha = git(["rev-parse", "HEAD"], tmp);
    const explicitRenamePaths = renamedFiles.flatMap((rename) => [rename.from, rename.to]);
    const renderOrdinarySegment = (formatArgs: readonly string[]): string => {
      const ordinaryPathspecs = explicitRenamePaths.map((rel) => `:(exclude)${rel}`);
      return git(["diff", "--no-renames", ...formatArgs, baseSha, headSha, "--", ".", ...ordinaryPathspecs], tmp);
    };
    const renderRenameSegment = (rename: { readonly from: string; readonly to: string }, formatArgs: readonly string[]): string =>
      git(["diff", "-M1%", ...formatArgs, baseSha, headSha, "--", rename.from, rename.to], tmp);
    const renamePatchSegments = renamedFiles.map((rename) => {
      const segment = renderRenameSegment(rename, []);
      if (!/^rename from /m.test(segment) || !/^rename to /m.test(segment)) {
        throw new Error(`explicit rename did not render as a rename: ${rename.from} -> ${rename.to}`);
      }
      return segment;
    });
    const patch = [renderOrdinarySegment([]), ...renamePatchSegments].filter(Boolean).join("\n");
    const patchStat = [renderOrdinarySegment(["--stat"]), ...renamedFiles.map((rename) => renderRenameSegment(rename, ["--stat"]))].filter(Boolean).join("\n");
    const changedPaths = [renderOrdinarySegment(["--name-only"]), ...renamedFiles.map((rename) => renderRenameSegment(rename, ["--name-only"]))]
      .filter(Boolean)
      .flatMap((segment) => segment.split("\n"));
    const files = changedFilesFromPaths([...new Set(changedPaths)]);

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
