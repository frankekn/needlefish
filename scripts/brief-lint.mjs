#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const JSON_FENCE = /^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
// Fixture specs are TypeScript object literals. This accepts bare or quoted
// property names and spacing or line breaks without trying to parse TypeScript.
const HOLDOUT_TRUE = /(?:\bholdout\b|"holdout"|'holdout')\s*:\s*true\b/;

function maskCharacter(characters, index) {
  if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
}

function sanitizeForHoldoutScan(source) {
  const sanitized = source.split("");
  let state = "code";
  let index = 0;

  while (index < source.length) {
    if (state === "code") {
      if (source[index] === "/" && source[index + 1] === "/") {
        state = "line-comment";
        continue;
      }
      if (source[index] === "/" && source[index + 1] === "*") {
        state = "block-comment";
        continue;
      }
      if (source[index] === "'" || source[index] === '"') {
        state = source[index] === "'" ? "single-string" : "double-string";
        continue;
      }
      if (source[index] === "`") {
        state = "template-literal";
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      maskCharacter(sanitized, index);
      if (source[index] === "\n" || source[index] === "\r") state = "code";
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      const closesComment = source[index] === "*" && source[index + 1] === "/";
      maskCharacter(sanitized, index);
      if (closesComment) {
        maskCharacter(sanitized, index + 1);
        index += 2;
        state = "code";
      } else {
        index += 1;
      }
      continue;
    }

    const quote = state === "single-string" ? "'" : state === "double-string" ? '"' : "`";
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index = Math.min(index + 2, source.length);
        continue;
      }
      if (source[index] === quote) {
        index += 1;
        break;
      }
      index += 1;
    }

    let lookahead = index;
    while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1;
    const isQuotedProperty = state !== "template-literal" && source[index - 1] === quote && source[lookahead] === ":";
    if (!isQuotedProperty) {
      for (let maskedIndex = start; maskedIndex < index; maskedIndex += 1) {
        maskCharacter(sanitized, maskedIndex);
      }
    }
    state = "code";
  }

  return sanitized.join("");
}

function output(pass, failures, exitCode) {
  process.stdout.write(`${JSON.stringify({ pass, failures })}\n`);
  process.exitCode = exitCode;
}

function failure(code, detail) {
  return { code, detail };
}

function parseArguments(argv) {
  if (argv.length === 0) {
    throw new Error("usage: node scripts/brief-lint.mjs <brief.md> [--repo path] [--emit-criteria path]");
  }

  const briefPath = argv[0];
  let repoPath = process.cwd();
  let emitCriteriaPath;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--repo" && argument !== "--emit-criteria") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${argument}`);
    }
    if (argument === "--repo") repoPath = value;
    if (argument === "--emit-criteria") emitCriteriaPath = value;
    index += 1;
  }

  return { briefPath, repoPath, emitCriteriaPath };
}

function parseCriteria(brief, failures) {
  const blocks = [...brief.matchAll(JSON_FENCE)];
  if (blocks.length !== 1) {
    failures.push(failure("json-block-count", `expected 1 json fenced block, found ${blocks.length}`));
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(blocks[0][1]);
  } catch {
    failures.push(failure("invalid-json", "json fenced block could not be parsed"));
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    failures.push(failure("invalid-gate-criteria", "json value must be an object containing gateCriteria"));
    return undefined;
  }

  const criteria = parsed.gateCriteria;
  if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria)) {
    failures.push(failure("invalid-gate-criteria", "gateCriteria must be an object"));
    return undefined;
  }

  if (
    !Array.isArray(criteria.fixtures) ||
    criteria.fixtures.length === 0 ||
    criteria.fixtures.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    failures.push(failure("invalid-fixtures", "fixtures must be a nonempty array of nonempty strings"));
  }
  if (![1, 2, 3, 4].includes(criteria.riskTier)) {
    failures.push(failure("invalid-risk-tier", "riskTier must be 1, 2, 3, or 4"));
  }
  if (typeof criteria.maxMeanNoisePerPositive !== "number" || !Number.isFinite(criteria.maxMeanNoisePerPositive)) {
    failures.push(
      failure("invalid-max-mean-noise-per-positive", "maxMeanNoisePerPositive must be a finite number"),
    );
  }
  if (!Object.is(criteria.tier1Misses, 0)) {
    failures.push(failure("invalid-tier1-misses", "tier1Misses must be numeric 0"));
  }

  return criteria;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function validateFixtures(criteria, repoPath, failures) {
  if (!Array.isArray(criteria.fixtures)) return;

  const roots = [join(repoPath, "eval", "fixtures"), join(repoPath, "eval", "fixtures-real")];
  for (const fixtureId of criteria.fixtures) {
    if (typeof fixtureId !== "string" || fixtureId.trim().length === 0) continue;
    const exists = await Promise.all(
      roots.map((root) => {
        const candidate = resolve(root, fixtureId);
        if (!candidate.startsWith(`${resolve(root)}${sep}`)) return false;
        return isDirectory(candidate);
      }),
    );
    if (!exists.some(Boolean)) {
      failures.push(failure("fixture-not-found", `fixture directory not found: ${fixtureId}`));
    }
  }
}

async function findHoldoutIds(repoPath) {
  const ids = [];
  for (const relativeRoot of [join("eval", "fixtures"), join("eval", "fixtures-real")]) {
    const root = join(repoPath, relativeRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`holdout-scan-error: ${error?.code ?? "unknown"}`);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const specPath = join(root, entry.name, "spec.ts");
      let source;
      try {
        source = await readFile(specPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw new Error(`holdout-scan-error: ${error?.code ?? "unknown"}`);
      }
      if (HOLDOUT_TRUE.test(sanitizeForHoldoutScan(source))) ids.push(basename(join(root, entry.name)));
    }
  }
  return ids;
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
    const brief = await readFile(resolve(args.briefPath), "utf8");
    const repoPath = resolve(args.repoPath);
    const failures = [];
    const criteria = parseCriteria(brief, failures);

    if (criteria !== undefined) await validateFixtures(criteria, repoPath, failures);
    const decodedCriteria = criteria === undefined ? undefined : JSON.stringify(criteria);

    for (const holdoutId of await findHoldoutIds(repoPath)) {
      const offset = brief.indexOf(holdoutId);
      if (offset !== -1) {
        failures.push(failure("holdout-leak", `holdout fixture reference at offset ${offset}`));
      } else if (decodedCriteria?.includes(holdoutId)) {
        failures.push(failure("holdout-leak", "holdout fixture reference in criteria"));
      }
    }

    if (failures.length > 0) {
      output(false, failures, 1);
      return;
    }

    if (args.emitCriteriaPath !== undefined) {
      await writeFile(resolve(args.emitCriteriaPath), `${JSON.stringify(criteria, null, 2)}\n`);
    }
    output(true, [], 0);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    output(false, [failure("internal-error", detail)], 2);
  }
}

await main();
