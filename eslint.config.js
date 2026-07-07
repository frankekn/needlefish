import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "artifacts/**", ".needlefish/**", "eval/reports/**", ".omo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "eval/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      // Start unopinionated -- this is the first lint pass on this codebase.
      // Tighten rules in a follow-up once the baseline violation count is known.
    },
  }
);
