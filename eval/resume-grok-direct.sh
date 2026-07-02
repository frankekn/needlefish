#!/usr/bin/env bash
cd "$(dirname "$0")/.." || exit 1
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_API_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.local/share/opencode/auth.json','utf8')).openrouter.key)")
echo "=== $(date -u +%FT%TZ) RESUME grok-direct ===" > eval/results/resume-grok-direct.log
node --import tsx eval/run.ts --runner openai --model x-ai/grok-build-0.1 --draws 3 \
  --resume eval/results/grok-build-0.1-direct.json \
  --report eval/results/grok-build-0.1-direct.json >> eval/results/resume-grok-direct.log 2>&1
echo "=== $(date -u +%FT%TZ) RESUME DONE ===" >> eval/results/resume-grok-direct.log
