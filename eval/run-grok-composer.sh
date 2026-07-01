#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
mkdir -p eval/results
echo "=== $(date -u +%FT%TZ) START grok-composer-2.5-fast (grok runner) ===" > eval/results/run-grok-composer.log
node --import tsx eval/run.ts --runner grok --model grok-composer-2.5-fast --draws 3 --report eval/results/grok-composer-2.5-fast.json >> eval/results/run-grok-composer.log 2>&1
echo "=== $(date -u +%FT%TZ) DONE ===" >> eval/results/run-grok-composer.log
