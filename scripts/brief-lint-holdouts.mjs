#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

function literalPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function resolveExportedObjects(sourceFile) {
  const declarations = new Map();
  const exported = [];

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          const existing = declarations.get(declaration.name.text) ?? [];
          existing.push(declaration.initializer);
          declarations.set(declaration.name.text, existing);
          if (
            declaration.name.text === "spec" &&
            hasModifier(statement, ts.SyntaxKind.ExportKeyword)
          ) {
            exported.push(declaration.initializer);
          }
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isObjectLiteralExpression(statement.expression)) {
        exported.push(statement.expression);
      } else if (ts.isIdentifier(statement.expression)) {
        const matches = declarations.get(statement.expression.text);
        if (matches === undefined || matches.length !== 1) throw new Error("ambiguous spec export");
        exported.push(matches[0]);
      } else {
        throw new Error("invalid spec export");
      }
    }
  }

  const objects = [...new Set(exported)];
  if (objects.length === 0 || objects.some((node) => !ts.isObjectLiteralExpression(node))) {
    throw new Error("invalid spec export");
  }
  return objects;
}

function classifySpec(object) {
  const ids = [];
  let holdout = false;
  let ambiguous = false;

  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member) || member.name === undefined) {
      ambiguous = true;
      continue;
    }
    const name = literalPropertyName(member.name);
    if (name === undefined) {
      ambiguous = true;
      continue;
    }
    if (!ts.isPropertyAssignment(member)) {
      if (name === "id" || name === "holdout") ambiguous = true;
      continue;
    }
    if (name === "id") {
      if (!ts.isStringLiteral(member.initializer) || member.initializer.text.trim().length === 0) {
        throw new Error("invalid spec id");
      }
      ids.push(member.initializer.text);
    }
    if (name === "holdout" && member.initializer.kind !== ts.SyntaxKind.FalseKeyword) holdout = true;
  }

  if (ids.length !== 1) throw new Error("ambiguous spec id");
  return { id: ids[0], holdout: ambiguous || holdout };
}

function parseSpec(path, source) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics.length > 0) throw new Error("invalid spec syntax");
  const classifications = resolveExportedObjects(sourceFile).map(classifySpec);
  const ids = new Set(classifications.map(({ id }) => id));
  if (ids.size !== 1) throw new Error("ambiguous spec export");
  return {
    id: classifications[0].id,
    holdout: classifications.some(({ holdout }) => holdout),
  };
}

async function collect(repoPath) {
  const holdouts = [];
  for (const relativeRoot of [join("eval", "fixtures"), join("eval", "fixtures-real")]) {
    const root = join(repoPath, relativeRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const specPath = join(root, entry.name, "spec.ts");
      if (!(await stat(specPath)).isFile()) throw new Error("invalid spec path");
      const spec = parseSpec(specPath, await readFile(specPath, "utf8"));
      if (spec.holdout) holdouts.push(spec.id);
    }
  }
  return holdouts;
}

try {
  process.stdout.write(`${JSON.stringify(await collect(process.argv[2]))}\n`);
} catch {
  // Classification uncertainty must fail closed so the parent reports its redacted internal-error exit 2.
  process.exitCode = 1;
}
