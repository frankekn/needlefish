import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "ts-frontend-style-refactor",
  kind: "negative",
  defectClass: "safe-const-rename",
  description: "A styling constant is renamed. No behavior or contract change.",
  baseFiles: {
    "src/components/Button.tsx": `const SIZE = 10;

export function Button({ label }: { label: string }) {
  return <button style={{ padding: SIZE }}>{label}</button>;
}
`,
  },
  headFiles: {
    "src/components/Button.tsx": `const PADDING = 10;

export function Button({ label }: { label: string }) {
  return <button style={{ padding: PADDING }}>{label}</button>;
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
