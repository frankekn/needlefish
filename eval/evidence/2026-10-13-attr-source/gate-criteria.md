# Pre-declared gate criteria — PR #234 (issue #213), CF-Qwen substitute lane (written before any model run)

Date: 2026-10-13. Owner-approved substitute lane: opencode, `cliproxyapi/CF-Qwen-3.8-flash`, effort high.
This is NOT the production lane (Codex gpt-5.6-terra high).

Baseline: /tmp/nf-eval-cfqwen/base-x1.json (origin/main a9bcc6c, full set, holdouts included, draws 1).
Candidate: PR #234 head b6376c7 (origin/main 82aa1da + #234), same lane, full set, holdouts included, draws 1.
Model-input identity: stub-captured prompts at the candidate head must equal the baseline (180/180) before the model run.

Then x3 on every fixture whose hit/FP/format differs between the two x1 runs, on BOTH sides (base side = detached origin/main 82aa1da).

Pass if all hold:
1. No tier-1 recall regression that survives the x3 confirm.
2. No fixture that base hits 3/3 in the confirm drops below 2/3 on candidate.
3. No candidate invalid-output draw that base did not also have, unless the failed output shows a runner/transport cause.
4. Pooled false positives across negative fixtures: candidate <= baseline + 2.
5. cheatDetectedCount = 0 on both sides.
6. runner_failed / timeouts are counted separately and rerun; they are not model misses.
