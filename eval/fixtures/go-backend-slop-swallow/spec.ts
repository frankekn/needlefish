import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "go-backend-slop-swallow",
  kind: "positive",
  tier: 2,
  defectClass: "ai-slop-error-swallow",
  description: "Agent adds a LoadOrDefault convenience wrapper that drops the error from Load with `v, _ :=`, silently masking missing keys for callers.",
  baseFiles: {
    "src/store.go": `package store

import "errors"

var ErrMissing = errors.New("missing key")

func Load(key string, m map[string]string) (string, error) {
	v, ok := m[key]
	if !ok {
		return "", ErrMissing
	}
	return v, nil
}
`,
  },
  headFiles: {
    "src/store.go": `package store

import "errors"

var ErrMissing = errors.New("missing key")

func Load(key string, m map[string]string) (string, error) {
	v, ok := m[key]
	if !ok {
		return "", ErrMissing
	}
	return v, nil
}

func LoadOrDefault(key string, m map[string]string) string {
	v, _ := Load(key, m)
	return v
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "swallow|silent|mask|, _|_ :=|ignor.{0,16}err|err.{0,24}(ignor|discard|dropp)|discard.{0,16}err" },
    ],
    anchorFile: "src/store.go",
    anchorLineRange: [15, 18],
  },
};

export default spec;
