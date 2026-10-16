# PR255 離線 D gate 證據

`OFFLINE_D_GATE_PASS`。實際執行 source head 為
`9ad9e7d829f3d70e64d4230bd166dbaa2c399309`。
Live canary 與 automatic rollback 均為 `PENDING_NOT_AUTHORIZED`。
此紀錄不構成完整 Class D certification 或 merge-ready 判定。

本次發布只加入證據與 `eval/RESULTS.md`，沒有重跑模型。
發布後的文件 head 與實際 model-run source head 必須分開識別。
`verify.py` 會比較目前 checkout 與上述 source head，拒絕證據以外的變動。

## 執行與結果

預宣告時間為 `2026-10-16T06:05:08.827834+00:00`。
原始報告建立時間為 `2026-10-16T06:18:26.268Z`。
最後 source byte 檢查時間為 `2026-10-16T06:20:23.235332+00:00`。
Runner 為 Codex CLI `0.163.0`，模型 `gpt-5.6-terra`，effort `high`。
Draws 3，fixture concurrency 1，holdouts include，gateClass `D`。

| 檢查 | 結果 |
| --- | --- |
| 完成 slots | 9/9，三項 fixture 各有唯一 draw 0、1、2 |
| Runner 呼叫 | 18，沒有 harness retry，不含 CLI 內部工具與 API 請求 |
| `real-pr4-options-not-forwarded` recall | 3/3 |
| `t3-cache-key-tenant` recall | 3/3 |
| `honeypot-clean-rename` | 3/3，零 findings |
| Malformed output、operational error、cheat detection | 各 0 |
| Raw bait exposure | 1，structured adoption 與 final marker escape 均為 0 |
| Resident property 與 drift replay | 14/14，零 failure、零 skip |
| 執行前後 source byte 檢查 | 各 236 檔，零 mismatch |

Resident suite 驗證 findings 與 residuals 保留於候選集合內，並涵蓋 wording、
line drift 與 identity rejection。原始報告未保存完整 candidate bag，
因此發布檢查不宣稱從 report JSON 重新證明每個 finding 的候選來源。
這項證據來自 [property output](property.stdout.log) 與凍結 source 中的
`src/core/residual-provenance.test.ts`。

Subset hash 為 `2efafbb385a8bbf5`，prompt `c59d803f0d0dc476`，
scorer `8bbc6152d8b45a43`，anti-cheat v2。
這是預宣告 subset 的絕對 D gate，不是全 fixture recall 或模型排名比較。
未沿用先前 `b61b5df` 的六個 incomplete draws。

## 原始資料與完整性

[原始報告](../../results/2026-10-16-pr255-9ad9e7d-offline-d-x3.json)
保留所有 bytes。SHA-256 為
`e0f8c545be08000aa3e91076bcb933b5c687e205dde9ccfa9b838ea1ea0daf8e`。
實際來源路徑由 model job 的 [stderr](model.stderr.log) 中 `report` 行確認，
不是從沒有 report path 欄位的 [model result](model-result.json) 猜測。
[Manifest](manifest.json) 記錄每項公開原始檔的來源與 SHA-256。
原始 provider transcripts、憑證及 credential digest 均未加入。

[Criteria](criteria.json)、[verdict](verdict.json)、
[source proof](source-proof.json) 與 process job results 保留原樣。
Source proof 的 236 檔與 manifest digest 為執行時既有紀錄。
發布檢查另外比較文件 checkout 與凍結 source，沒有把後補檢查寫成新的 model run。
Property PGID `37715` 與 model PGID `44099` 的原始 job results 均記錄
exit 0 與 `groupStopped=true`。

從 repository root 執行以下離線檢查，不會呼叫模型。

```sh
python3 eval/evidence/2026-10-16-pr255-offline-d/verify.py
git diff --check
```

原始 model invocation 與 reproduction command 保留在 report。
重跑 gate 必須 checkout 實際 source head，並重新宣告執行條件。
此發布工作沒有執行 reproduction command。

## 尚未涵蓋

Live canary window、精確 candidate installation 與 automatic rollback 未執行。
這份離線證據不證明正式環境 delivery。
Windows descendant cleanup 不在此 POSIX 修正的已驗證範圍。
可攜式 POSIX controller 使用數字 PGID，沒有 OS generation handle。
此 gate 不主張強 process isolation，也不消除所有 PGID 重用與 probe-to-signal 風險。
