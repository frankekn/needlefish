import { readFileSync } from "node:fs";
import { parse } from "yaml";

export function readWorkflow(path) {
  const source = readFileSync(path, "utf8");
  return { source, workflow: parse(source) };
}

export function workflowStepScript(source, stepName) {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const step = source.match(
    new RegExp(`      - name: ${escapedName}\\n([\\s\\S]*?)(?=\\n      - name:|$)`),
  );
  if (!step) throw new Error(`${stepName} step must exist`);
  const runBlock = step[1].match(/        run: \|\n([\s\S]*)/);
  if (!runBlock) throw new Error(`${stepName} must have a run block`);
  const scriptLines = [];
  for (const line of runBlock[1].split("\n")) {
    if (line.length > 0 && !line.startsWith("          ")) break;
    scriptLines.push(line);
  }
  return scriptLines
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
}
