import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "t1-swallowed-error",
  kind: "positive",
  tier: 1,
  defectClass: "error-swallow-payment-path",
  description:
    "The diff stops propagating the charge error: Charge now returns nil unconditionally, so callers treat failed payments as successful. Blatant.",
  baseFiles: {
    "pay/charge.go": `package pay

import "fmt"

type Gateway interface {
	Submit(cents int64, token string) error
}

func Charge(gw Gateway, cents int64, token string) error {
	if cents <= 0 {
		return fmt.Errorf("invalid amount: %d", cents)
	}
	if err := gw.Submit(cents, token); err != nil {
		return fmt.Errorf("charge failed: %w", err)
	}
	return nil
}
`,
  },
  headFiles: {
    "pay/charge.go": `package pay

import (
	"fmt"
	"log"
)

type Gateway interface {
	Submit(cents int64, token string) error
}

func Charge(gw Gateway, cents int64, token string) error {
	if cents <= 0 {
		return fmt.Errorf("invalid amount: %d", cents)
	}
	if err := gw.Submit(cents, token); err != nil {
		log.Printf("charge failed: %v", err)
	}
	return nil
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "swallow|silent|nil.{0,24}(err|fail)|return.{0,8}nil|success.{0,32}fail|treated as success|only log|log.{0,24}(instead|but|swallow)|propagat" },
    ],
    anchorFile: "pay/charge.go",
    anchorLineRange: [12, 21],
  },
};

export default spec;
