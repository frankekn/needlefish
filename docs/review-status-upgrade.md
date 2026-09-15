# Review completion and exit status / 審查完成狀態與升級說明

## What changed

Actual local, local-PR, and GitHub reviews now share one delivery policy:

| Result | Meaning | CLI exit | GitHub check |
| --- | --- | ---: | --- |
| `pass` | No blocking findings or blocking residuals under the existing policy | 0 | `success` |
| `changes_requested` | A P0, P1, or P2 finding remains | 1 | `failure` |
| `needs_human` | Review is incomplete or material evidence still requires human confirmation | 1 | `failure` |
| Operational error | Review failed to run or could not produce a usable result | nonzero | `failure` when a check can be delivered |

A failed check is not necessarily a code defect. Read its title and summary.
For `needs_human`, retry the review or ask a developer to verify the unresolved
items before merging. Coverage and blocking residuals remain visible.

This is a delivery-policy change, not a new severity threshold. The three
verdict values, JSON schema, model prompts, critic behavior, and `deriveVerdict`
are unchanged. P3-only findings and nonblocking residuals still permit `pass`.
Docs-only changes still skip the model by policy and say so explicitly.

## Upgrade from 0.4.6

Previously, a GitHub `needs_human` check was `neutral`, and local review commands
could exit successfully even when their result did not pass. Automation must
now handle exit 1 while still reading any completed review from stdout.
`--json` prints the same `ReviewResult` structure before exiting; an operational
error may produce no result JSON. Do not use `findings.length === 0` as a pass
check: blocking residuals can require human confirmation without a finding.

For Bash scripts, preserve Needlefish's exit status rather than replacing it
with a downstream formatter's status:

```bash
status=0
needlefish --repo . --json > review.json || status=$?
if [ -s review.json ]; then
  jq .verdict review.json
fi
exit "$status"
```

The read-only diagnostic commands `render` and `verdict`, help/version, and
`--dry-run` keep their existing exit semantics. In particular, `verdict` checks
stored-versus-derived consistency; it is not a replacement for a fresh review
or a merge gate. Skip notices for closed, stale, and already-reviewed heads do
not constitute a new passing review. Superseded checks retain their separate
`neutral` terminal state on the old head.

Existing check results are not rewritten during installation. After updating
the actual executable/action used by a consumer, run a full review of the
current head with `--recheck`, or review a new commit. Merely rerunning the old
job or changing a workflow reference does not update an operator-managed
binary. The same-head dedupe and partial-delivery recovery tracked in #102 are
not redesigned by this change.

Use the existing **Needlefish** check as a required check to enforce this policy
for merges. Needlefish does not change branch protection, remove other checks,
merge PRs, or request extra permissions. For advisory use, leave this check
non-required rather than hiding an incomplete result behind `neutral`.

## 給使用者的說明

**審查未完成不等於程式有錯，也不等於可以放心合併。**

- 「通過」：依本次審查範圍，沒有阻擋問題或必須確認的剩餘風險。
- 「需要修改」：找到 P0／P1／P2 問題，請開發者查看修正建議。
- 「需要人工確認」：部分審查未完成或關鍵證據不足。請重試，或請開發者
  確認列出的項目；不能只因問題清單是空的就認為通過。
- 「執行失敗」：工具未能完成工作，請依錯誤原因處理認證、網路或其他問題。

本次不增加安裝參數，也不需要啟用 `--strict`。已完成的本機與 GitHub
審查只有 `pass` 以成功狀態結束；`needs_human` 和 `changes_requested`
都回傳失敗狀態，但報告仍會保留。純文件依政策略過模型時，畫面會明說。

升級不會自動改寫以前的 GitHub 檢查結果。請先確認實際使用的工具已更新，
再對目前版本做一次完整重審；相同 GitHub head 使用 `--recheck`。
需要強制檢查的專案沿用 `Needlefish` required check 即可，不用新增另一套
設定，也不會自動更改既有分支保護或合併 PR。
