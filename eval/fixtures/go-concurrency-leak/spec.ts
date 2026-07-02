import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "go-concurrency-leak",
  kind: "positive",
  defectClass: "goroutine-leak-no-sync",
  description: "Agent makes Process concurrent by spawning a goroutine per job, but ignores ctx (no cancellation) and uses no WaitGroup, so callers cannot know when work is done and may close results while goroutines still write.",
  baseFiles: {
    "src/worker.go": `package worker

import "context"

func Run(ctx context.Context, jobs []int, results chan<- int) {
	for _, j := range jobs {
		results <- j * 2
	}
}
`,
  },
  headFiles: {
    "src/worker.go": `package worker

import "context"

func Run(ctx context.Context, jobs []int, results chan<- int) {
	for _, j := range jobs {
		go func(j int) {
			results <- j * 2
		}(j)
	}
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "goroutine|leak|context|ctx|cancel|wait|sync|waitgroup|race|closed|panic" },
    ],
    anchorFile: "src/worker.go",
    anchorLineRange: [5, 10],
  },
};

export default spec;
