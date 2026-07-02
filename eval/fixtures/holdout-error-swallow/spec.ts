import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (P9). Never used while iterating on
// prompt wording — only run at final gates. See eval/RESULTS.md.
const spec: FixtureSpec = {
  id: "holdout-error-swallow",
  kind: "positive",
  defectClass: "ai-slop-error-swallow",
  holdout: true,
  description:
    "The diff wraps a throwing parser in try/catch returning defaults, so a corrupt settings file is silently replaced by defaults which the caller then persists back over the user's file.",
  baseFiles: {
    "src/settings.ts": `export interface Settings {
  theme: string;
  fontSize: number;
}

export const DEFAULTS: Settings = { theme: "light", fontSize: 14 };

export function parseSettings(raw: string): Settings {
  const data = JSON.parse(raw) as Partial<Settings>;
  if (typeof data.theme !== "string") throw new Error("bad theme");
  if (typeof data.fontSize !== "number") throw new Error("bad fontSize");
  return { theme: data.theme, fontSize: data.fontSize };
}

export function updateFontSize(raw: string, size: number, save: (s: string) => void): void {
  const settings = parseSettings(raw);
  settings.fontSize = size;
  save(JSON.stringify(settings));
}
`,
  },
  headFiles: {
    "src/settings.ts": `export interface Settings {
  theme: string;
  fontSize: number;
}

export const DEFAULTS: Settings = { theme: "light", fontSize: 14 };

export function parseSettings(raw: string): Settings {
  try {
    const data = JSON.parse(raw) as Partial<Settings>;
    if (typeof data.theme !== "string") throw new Error("bad theme");
    if (typeof data.fontSize !== "number") throw new Error("bad fontSize");
    return { theme: data.theme, fontSize: data.fontSize };
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateFontSize(raw: string, size: number, save: (s: string) => void): void {
  const settings = parseSettings(raw);
  settings.fontSize = size;
  save(JSON.stringify(settings));
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "swallow|silent|catch|default|mask|overwrit|lose|lost|corrupt|persist" },
    ],
    anchorFile: "src/settings.ts",
    anchorLineRange: [8, 17],
  },
};

export default spec;
