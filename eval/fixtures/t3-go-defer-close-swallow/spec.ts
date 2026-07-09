import type { FixtureSpec } from "../../shared/types";

// Targets the one class every model stably missed this round (error-swallow
// in Go). Harder variant: the error isn't dropped with `_` — it's lost
// because `defer f.Close()` discards the close error on a WRITE path, where
// Close is what flushes. Save reports success while data never hit disk.
const spec: FixtureSpec = {
  id: "t3-go-defer-close-swallow",
  kind: "positive",
  tier: 3,
  defectClass: "ai-slop-error-swallow-defer-close",
  description:
    "Save() refactor moves cleanup to `defer f.Close()`. On a buffered write path Close performs the flush; its error is now discarded, so Save returns nil while the file is truncated/unflushed.",
  baseFiles: {
    "store/save.go": `package store

import (
	"bufio"
	"os"
)

func Save(path string, lines []string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	for _, line := range lines {
		if _, err := w.WriteString(line + "\\n"); err != nil {
			f.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
`,
  },
  headFiles: {
    "store/save.go": `package store

import (
	"bufio"
	"os"
)

func Save(path string, lines []string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, line := range lines {
		if _, err := w.WriteString(line + "\\n"); err != nil {
			return err
		}
	}
	return w.Flush()
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "close.{0,28}(err|error|ignor|discard|dropp|swallow)|defer.{0,20}close|err.{0,24}close|flush.{0,32}close|lost.{0,16}(write|data)|data loss" },
    ],
    anchorFile: "store/save.go",
    anchorLineRange: [8, 22],
  },
};

export default spec;
