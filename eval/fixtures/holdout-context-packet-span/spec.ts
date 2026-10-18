import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-context-packet-span",
  kind: "positive",
  tier: 3,
  holdout: true,
  defectClass: "inclusive-exclusive-consumer-span",
  description: "A packet encoder changes an exclusive end offset to an inclusive end offset while an unchanged store still subtracts the start to compute the payload length.",
  baseFiles: {
    "src/packet.ts": `export function packetSpan(start: number, length: number) {
  return { start, end: start + length };
}
`,
    "src/store.ts": `import { packetSpan } from './packet';
export function persistPayload(payload: Uint8Array): Uint8Array {
  const span = packetSpan(0, payload.length);
  return payload.slice(span.start, span.end);
}
`,
  },
  headFiles: {
    "src/packet.ts": `export function packetSpan(start: number, length: number) {
  return { start, end: start + length - 1 };
}
`,
  },
  expected: {
    verdict: "changes_requested",
    anchorFile: "src/packet.ts",
    anchorLineRange: [2, 2],
    mustFind: [{ pattern: "slice|exclusiv|last.byte|truncat|off.by.one|drop.*byte|payload" }],
  },
};

export default spec;
