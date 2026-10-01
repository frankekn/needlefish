#!/usr/bin/env bash
# Class R gate for the critic contract-drift "affects" clarification
# (docs/plans/critic-contract-drift-affects.md). Same lane and route as the
# 2026-09-30 pre-change DeepSeek V4.1 Flash baseline. Key is read at runtime,
# never stored in the repo. The proxy key makes the report privateEnvironment,
# which eval/run.ts refuses to resume: an interrupted run starts over.
cd "$(dirname "$0")/.." || exit 1
mkdir -p eval/results
STAMP=2026-09-30
REPORT="eval/results/$STAMP-codex-deepseek-v41-flash-high-critic-r1-full-x3.json"
LOG="eval/results/run-critic-r1-full-gate-$STAMP.log"
: >> "$LOG"

export CODEX_PROXY_BASE_URL="http://100.104.118.1:8317/v1"
export CODEX_PROXY_API_KEY=$(cat "$HOME/.cli-proxy-api/secrets/client-primary.key")

echo "=== $(date -u +%FT%TZ) START deepseek-v4.1-flash high x3 (codex) ===" | tee -a "$LOG"
if node --import tsx eval/run.ts \
  --runner codex --model deepseek/deepseek-v4.1-flash --effort high \
  --provider 'DeepSeek' \
  --route 'codex over CLIProxyAPI (DGX Spark, Tailscale)' \
  --runner-version 'codex-cli 0.159.1' \
  --env NEEDLEFISH_CODEX_PROXY_REQUIRED=1 --env NEEDLEFISH_EPHEMERAL_HOME=1 --env NEEDLEFISH_EVAL_TRACE=1 \
  --draws 3 --concurrency 3 --holdout include --gate-class R \
  --report "$REPORT" >>"$LOG" 2>&1; then
  echo "=== $(date -u +%FT%TZ) DONE ===" | tee -a "$LOG"
else
  rc=$?
  echo "=== $(date -u +%FT%TZ) FAILED (exit $rc) ===" | tee -a "$LOG"
  exit "$rc"
fi
