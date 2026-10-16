interface NumstatRow {
  readonly additions: string;
  readonly deletions: string;
  readonly path: string;
}

function parseNumstatRow(row: string): NumstatRow | null {
  const firstTab = row.indexOf("\t");
  if (firstTab === -1) return null;
  const secondTab = row.indexOf("\t", firstTab + 1);
  if (secondTab === -1) return null;
  return {
    additions: row.slice(0, firstTab),
    deletions: row.slice(firstTab + 1, secondTab),
    path: row.slice(secondTab + 1),
  };
}

export function binaryPathsFromNumstat(numstat: string): string[] {
  const fields = numstat ? numstat.split("\0") : [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const addPath = (filePath: string): void => {
    if (!filePath || seen.has(filePath)) return;
    seen.add(filePath);
    paths.push(filePath);
  };

  let index = 0;
  while (index < fields.length) {
    const row = parseNumstatRow(fields[index] ?? "");
    index += 1;
    if (!row) continue;

    const isBinaryRow = row.additions === "-" && row.deletions === "-";
    if (row.path === "") {
      const oldPath = fields[index] ?? "";
      const newPath = fields[index + 1] ?? "";
      index += 2;
      if (isBinaryRow) {
        addPath(oldPath);
        addPath(newPath);
      }
      continue;
    }

    if (isBinaryRow) addPath(row.path);
  }

  return paths;
}
