#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
mkdir -p eval/results
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_API_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.local/share/opencode/auth.json','utf8')).openrouter.key)")
echo "=== $(date -u +%FT%TZ) START grok-build-0.1 direct (openai runner, single-shot) ===" > eval/results/run-grok-direct.log
node --import tsx eval/run.ts --runner openai --model x-ai/grok-build-0.1 --draws 3 --report eval/results/grok-build-0.1-direct.json >> eval/results/run-grok-direct.log 2>&1
echo "=== $(date -u +%FT%TZ) DONE ===" >> eval/results/run-grok-direct.log
