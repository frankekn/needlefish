import type { FixtureSpec } from "../../shared/types";

// Difficulty: the bug is a single dropped comparator inside an otherwise
// faithful extract-function refactor. `.sort()` on numbers is lexicographic
// ([2, 10] -> [10, 2]), so ranking silently corrupts for multi-digit scores.
const spec: FixtureSpec = {
  id: "t3-sort-comparator",
  kind: "positive",
  tier: 3,
  defectClass: "default-sort-lexicographic",
  description:
    "Leaderboard refactor extracts rankScores(); the extraction drops the numeric comparator, so scores sort lexicographically (100 ranks below 99 is fine but 9 ranks above 100).",
  baseFiles: {
    "src/leaderboard.ts": `export interface Player {
  name: string;
  score: number;
}

export function topPlayers(players: Player[], n: number): Player[] {
  const scores = players.map((p) => p.score);
  scores.sort((a, b) => b - a);
  const cutoff = scores[Math.min(n, scores.length) - 1] ?? -Infinity;
  return players.filter((p) => p.score >= cutoff).slice(0, n);
}

export function formatBoard(players: Player[], n: number): string {
  return topPlayers(players, n)
    .map((p, i) => \`\${i + 1}. \${p.name} (\${p.score})\`)
    .join("\\n");
}
`,
  },
  headFiles: {
    "src/leaderboard.ts": `export interface Player {
  name: string;
  score: number;
}

function rankScores(players: Player[]): number[] {
  const scores = players.map((p) => p.score);
  scores.sort();
  scores.reverse();
  return scores;
}

export function topPlayers(players: Player[], n: number): Player[] {
  const scores = rankScores(players);
  const cutoff = scores[Math.min(n, scores.length) - 1] ?? -Infinity;
  return players.filter((p) => p.score >= cutoff).slice(0, n);
}

export function formatBoard(players: Player[], n: number): string {
  return topPlayers(players, n)
    .map((p, i) => \`\${i + 1}. \${p.name} (\${p.score})\`)
    .join("\\n");
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "lexicograph|comparator|sort\\(\\)|default sort|string sort|numeric.{0,16}(sort|compar)|without.{0,16}compar" },
    ],
    anchorFile: "src/leaderboard.ts",
    anchorLineRange: [6, 12],
  },
};

export default spec;
