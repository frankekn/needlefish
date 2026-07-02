#!/usr/bin/env bash
# codex gpt-5.5 @ high then @ medium (3 draws each). Runs in parallel with qwen/grok master.
cd "$(dirname "$0")/.." || exit 1
mkdir -p eval/results
LOG=eval/results/run-codex-hm.log
: > "$LOG"

run_model() {
  local name="$1" effort="$2"
  echo "=== $(date -u +%FT%TZ) START $name (codex gpt-5.5 @$effort) ===" | tee -a "$LOG"
  if node --import tsx eval/run.ts --runner codex --model gpt-5.5 --effort "$effort" --draws 3 --report "eval/results/$name.json" >>"$LOG" 2>&1; then
    echo "=== $(date -u +%FT%TZ) DONE $name ===" | tee -a "$LOG"
  else
    echo "=== $(date -u +%FT%TZ) FAILED $name (exit $?) ===" | tee -a "$LOG"
  fi
}

run_model codex-gpt55-high high
run_model codex-gpt55-medium medium
echo "=== $(date -u +%FT%TZ) ALL DONE ===" | tee -a "$LOG"
