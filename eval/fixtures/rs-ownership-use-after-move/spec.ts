import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "rs-ownership-use-after-move",
  kind: "positive",
  tier: 2,
  defectClass: "use-after-move",
  description: "Agent adds a dbg! print of items with a semicolon, which moves and drops the Vec; the subsequent items.len() then uses a moved value.",
  baseFiles: {
    "src/store.rs": `pub fn process(items: Vec<String>) -> usize {
    let total = items.len();
    total
}
`,
  },
  headFiles: {
    "src/store.rs": `pub fn process(items: Vec<String>) -> usize {
    dbg!(items);
    let total = items.len();
    total
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "move|borrow|ownership|use.*after|dbg|len|moved|drop" },
    ],
    anchorFile: "src/store.rs",
    anchorLineRange: [1, 4],
  },
};

export default spec;
