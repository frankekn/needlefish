import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Match the test-only files excluded by tsconfig.build.json. Test files may
// cross layers to exercise real integrations; shipping code may not import them.
const testFiles = ["src/**/*.test.ts", "src/**/*test-fixtures.ts"];
const developmentImports = {
  regex: "(?:^|/)(?:eval|scripts)(?:/|$)|(?:\\.test|test-fixtures)(?:\\.[cm]?[jt]s)?$|^node:test(?:/|$)",
  message: "Shipping code must not depend on eval, scripts, or test-only modules.",
  caseSensitive: true,
};

function dependencyBoundary(files, forbiddenLayers = []) {
  const patterns = [developmentImports];
  if (forbiddenLayers.length > 0) {
    patterns.push({
      regex: `^\\.{1,2}/(?:.*/)?(?:${forbiddenLayers.join("|")})(?:/|(?:\\.[cm]?[jt]s)?$)`,
      message: "Keep dependencies downward: CLI -> adapters -> core -> shared.",
      caseSensitive: true,
    });
  }
  return {
    files,
    ignores: testFiles,
    rules: {
      "no-restricted-imports": ["error", { patterns }],
      // The import rule handles static imports/re-exports, including types.
      // Cover literal dynamic imports and inline import types with the same policy.
      "no-restricted-syntax": ["error", ...patterns.map(({ regex, message }) => ({
        selector: `:matches(ImportExpression, TSImportType)[source.value=/${regex.replaceAll("/", "\\u002F")}/]`,
        message,
      }))],
    },
  };
}

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "artifacts/**", ".needlefish/**", "eval/reports/**", ".omo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  dependencyBoundary(["src/**/*.ts"]),
  dependencyBoundary(["src/adapters/**/*.ts"], ["cli"]),
  dependencyBoundary(["src/core/**/*.ts"], ["cli", "adapters"]),
  dependencyBoundary(["src/shared/**/*.ts"], ["cli", "adapters", "core"]),
);
