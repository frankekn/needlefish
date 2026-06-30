#!/usr/bin/env bash
# qwen + grok with short timeout + no retry (opencode @ max otherwise times out)
cd "$(dirname "$0")/.." || exit 1
mkdir -p eval/results
LOG=eval/results/run-qwen-grok.log
: > "$LOG"
export NEEDLEFISH_TIMEOUT_MS=240000
export NEEDLEFISH_NO_RETRY=1

run_model() {
  local name="$1" runner="$2" model="$3" effort="$4"
  echo "=== $(date -u +%FT%TZ) START $name ($runner $model @$effort) timeout=${NEEDLEFISH_TIMEOUT_MS}ms no-retry ===" | tee -a "$LOG"
  if node --import tsx eval/run.ts --runner "$runner" --model "$model" --effort "$effort" --draws 3 --report "eval/results/$name.json" >>"$LOG" 2>&1; then
    echo "=== $(date -u +%FT%TZ) DONE $name ===" | tee -a "$LOG"
  else
    echo "=== $(date -u +%FT%TZ) FAILED $name (exit $?) ===" | tee -a "$LOG"
  fi
}

run_model opencode-qwen opencode opencode-go/qwen3.7-max max
run_model opencode-grok opencode opencode/grok-build-0.1 max
echo "=== $(date -u +%FT%TZ) ALL DONE ===" | tee -a "$LOG"
