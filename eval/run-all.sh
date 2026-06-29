#!/usr/bin/env bash
# 8-model x 3-draw eval. Sequential, incremental per-fixture writes, continues on failure.
cd "$(dirname "$0")/.." || exit 1
mkdir -p eval/results
LOG=eval/results/run-all.log
: > "$LOG"

run_model() {
  local name="$1" runner="$2" model="$3" effort="$4" baseline="$5"
  local args=(--runner "$runner" --draws 3 --report "eval/results/$name.json")
  [[ -n "$model" ]] && args+=(--model "$model")
  [[ -n "$effort" ]] && args+=(--effort "$effort")
  [[ "$baseline" == "1" ]] && args+=(--baseline)
  echo "=== $(date -u +%FT%TZ) START $name ($runner ${model:-default} ${effort:+@$effort}) ===" | tee -a "$LOG"
  if node --import tsx eval/run.ts "${args[@]}" >>"$LOG" 2>&1; then
    echo "=== $(date -u +%FT%TZ) DONE $name ===" | tee -a "$LOG"
  else
    local rc=$?
    echo "=== $(date -u +%FT%TZ) FAILED $name (exit $rc) ===" | tee -a "$LOG"
  fi
}

run_model codex-gpt55       codex    ""                          xhigh 1
run_model claude-opus-48    claude   claude-opus-4-8             xhigh 0
run_model claude-opus-47    claude   claude-opus-4-7             xhigh 0
run_model opencode-glm52    opencode zai-coding-plan/glm-5.2     max   0
run_model opencode-deepseek opencode opencode-go/deepseek-v4-pro max   0
run_model opencode-kimi     opencode kimi-for-coding/k2p7       max   0
run_model opencode-qwen     opencode opencode-go/qwen3.7-max    max   0
run_model opencode-grok     opencode opencode/grok-build-0.1    max   0

echo "=== $(date -u +%FT%TZ) ALL DONE ===" | tee -a "$LOG"
