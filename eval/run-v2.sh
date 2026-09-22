#!/usr/bin/env bash
# code-review-v2 campaign: 2 lanes x 3 draws, full fixture set, holdouts included (Class R default).
# Sequential, incremental per-fixture writes, continues on failure.
cd "$(dirname "$0")/.." || exit 1
mkdir -p eval/results
STAMP=$(date +%F)
LOG="eval/results/run-v2-$STAMP.log"
: > "$LOG"

run_lane() {
  local name="$1"; shift
  echo "=== $(date -u +%FT%TZ) START $name ===" | tee -a "$LOG"
  if node --import tsx eval/run.ts --draws 3 --report "eval/results/$STAMP-$name-x3.json" "$@" >>"$LOG" 2>&1; then
    echo "=== $(date -u +%FT%TZ) DONE $name ===" | tee -a "$LOG"
  else
    local rc=$?
    echo "=== $(date -u +%FT%TZ) FAILED $name (exit $rc) ===" | tee -a "$LOG"
  fi
}

run_lane opencode-mimo-v26-flash \
  --runner opencode --model opencode/mimo-v2.6-flash-free \
  --provider Xiaomi --route "opencode Zen direct (free tier)" --runner-version "opencode v2.0.12"

run_lane grok-47-high \
  --runner grok --model grok-4.7 --effort high \
  --provider xAI --route "Grok CLI subscription (direct API)" --runner-version "grok 1.0.40"

echo "=== $(date -u +%FT%TZ) ALL DONE ===" | tee -a "$LOG"
