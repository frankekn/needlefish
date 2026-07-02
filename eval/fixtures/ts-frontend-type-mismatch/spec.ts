import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "ts-frontend-type-mismatch",
  kind: "positive",
  defectClass: "type-error-generalized-prop",
  description: "Agent generalizes a React Field prop from string to string|number, but the render still reads value.length, which is invalid for number and yields undefined.",
  baseFiles: {
    "src/components/Field.tsx": `export interface FieldProps {
  value: string;
}

export function Field({ value }: FieldProps) {
  return <input defaultValue={value} />;
}
`,
  },
  headFiles: {
    "src/components/Field.tsx": `export interface FieldProps {
  value: string | number;
}

export function Field({ value }: FieldProps) {
  const label = \`len=\${value.length}\`;
  return <input defaultValue={label} />;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "\\.length|number.*length|length.*number|type.*mismatch|narrow|guard|undefined" },
    ],
    anchorFile: "src/components/Field.tsx",
    anchorLineRange: [5, 7],
  },
};

export default spec;
