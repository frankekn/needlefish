import type { FixtureSpec } from "../../shared/types";

// Hard negative: deleting an exported function plus its test looks dangerous,
// but repo-wide there is no remaining caller — the export was legacy. The FP
// bait is "removed public API without deprecation".
const spec: FixtureSpec = {
  id: "neg-hard-dead-code-delete",
  kind: "negative",
  defectClass: "safe-dead-code-removal",
  description:
    "Removes the legacy FormatLegacyID helper and its test. Repo search shows the only references were the function itself and its test; live callers all use FormatID.",
  baseFiles: {
    "ids/format.go": `package ids

import "fmt"

func FormatID(region string, n int64) string {
	return fmt.Sprintf("%s-%08d", region, n)
}

func FormatLegacyID(n int64) string {
	return fmt.Sprintf("LEG%010d", n)
}
`,
    "ids/format_test.go": `package ids

import "testing"

func TestFormatID(t *testing.T) {
	if got := FormatID("eu", 42); got != "eu-00000042" {
		t.Fatalf("got %q", got)
	}
}

func TestFormatLegacyID(t *testing.T) {
	if got := FormatLegacyID(42); got != "LEG0000000042" {
		t.Fatalf("got %q", got)
	}
}
`,
    "billing/invoice.go": `package billing

import "example.com/app/ids"

func InvoiceRef(region string, seq int64) string {
	return "INV:" + ids.FormatID(region, seq)
}
`,
  },
  headFiles: {
    "ids/format.go": `package ids

import "fmt"

func FormatID(region string, n int64) string {
	return fmt.Sprintf("%s-%08d", region, n)
}
`,
    "ids/format_test.go": `package ids

import "testing"

func TestFormatID(t *testing.T) {
	if got := FormatID("eu", 42); got != "eu-00000042" {
		t.Fatalf("got %q", got)
	}
}
`,
    "billing/invoice.go": `package billing

import "example.com/app/ids"

func InvoiceRef(region string, seq int64) string {
	return "INV:" + ids.FormatID(region, seq)
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
