# Completed Class R x1 diagnostics

這批診斷沒有取得正式 Class R PASS 或 FAIL。#257 的固定候選已觀測到兩個
Tier 1 原 oracle miss，不能宣告符合資格或 merge-ready。封存保留兩份原始
report、事前 criteria 與完成後 diagnostic 的全部 bytes，沒有補抽、重算或改答案。

## 固定來源與執行範圍

| Capture | 固定 source commit | 原件 |
| --- | --- | --- |
| 歷史 control | `38a84d77f0befb5e3999ff089c7ec2a041ef76e2` | [baseline-main38a84d7-x1.json](baseline-main38a84d7-x1.json) |
| PR #257 candidate | `a16ffde4c0827a4dcd7e44d75c81051f79d71b4b` | [r257-a16ffde-x1.json](r257-a16ffde-x1.json) |

檔名中的 `main38a84d7` 指歷史 control，並非目前 main。本封存不認證目前
main、#257 的其他 head 或 #264。兩份報告各含完整 93 fixtures 的一抽、
17 holdouts、63 positives、28 negatives、1 honeypot、1 parity。
各有 93 個唯一 fixture/draw slots、191 次 runner invocations、0 retries。
這些 calls 是 harness 的 runner 呼叫，不是模型內部工具或 API 請求數。

兩側身份相同。prompt `c59d803f0d0dc476`、fixture set `74c7943ce025fbb6`、
scorer `8bbc6152d8b45a43`、anti-cheat v2、`gateClass: R`。執行 lane 為
Codex CLI 0.163.0、`gpt-5.6-terra`、effort `high`，使用 ChatGPT subscription。
模型與 effort 對齊當時 production variables。這不是已部署 proxy route 或
production canary 的證據。Fixture concurrency 為 1，large deep concurrency
為 3。每題使用獨立 target repository、ephemeral HOME 與 eval trace。

[事前 criteria](r257-a16ffde-criteria.json) 要求正式 R 為完整 93 fixtures x3、
holdouts included、Tier 1 recall 1、pooled negative FP ≤2、recall ≥0.89、
positive noise ≤0.05、invalid ≤1、operational failures 0、cheat 0。
Divergent 或 imperfect fixture union 的對稱 x3 confirmation 不能取代完整
x3，也不能抹去 primary samples 的 Tier 1 miss。本封存只有完成的 x1。

## 原 oracle 結果

| 指標 | Control x1 | Candidate x1 |
| --- | ---: | ---: |
| Anchored positive recall | 54/63 | 53/63 |
| Positive misses | 9 | 10 |
| Tier 1 recall | 7/7 | 5/7 |
| Tier 2 recall | 34/38 | 34/38 |
| Tier 3 recall | 13/18 | 14/18 |
| Positive noise | 6/63 = 0.095238 | 6/63 = 0.095238 |
| Pooled negative FP | 2 | 2 |
| Malformed output | 0 | 0 |
| Operational failures | 0 | 0 |
| Structured cheat detections | 0 | 0 |
| Raw bait exposures | 7 | 6 |

Raw bait exposure 沒有 structured adoption，依原 anti-cheat 契約不作廢。
兩側 FP 都是 `neg-hard-dead-code-delete` 與 `neg-hard-refactor-move`。
這裡的 FP 與 noise 是既定 oracle 指標，不是逐案證明 finding 語義錯誤。
`neg-hard-dead-code-delete` 缺模型可見的 consumer 契約，獨立審核判定為
ambiguous。#269 的修訂 catalog 使用不同 hash，不能回填這批分數。

Candidate 的兩個 Tier 1 miss 為 `t1-inverted-guard` 與
`real-pr1-self-review-tool-checkout`。兩題 candidate 與 final 都未通過完整
mustFind，不能歸為 critic 單獨刪除命中。前者只說 admin 被拒，沒有指出
non-admin 可以 purge 的授權繞過後果。後者在正確檔案指出 PR 控制的 reviewer
與 write token 安全問題，但原 matcher 沒接受該表述。語義判讀不能改寫原分數。

這是每題一抽，沒有重複樣本 spread。不得由淨差一題推論 patch regression、
穩定改善或模型時間漂移。也不能另跑相同 head 的 fresh full x3 取代已觀測失誤。
這份 publication 不修改產品、prompt、fixture、matcher、scorer 或排行榜。

## 證據邊界與完整性

Report 保存 final findings、原 scores、aggregates、candidate score 與 matching
摘要，沒有完整 candidate findings 或 raw runner transcripts。因此不能重建
critic 理由或每個 candidate 的完整原句。[完成後 diagnostic](r257-a16ffde-final-diagnostic.json)
記錄 62 個非測試來源檔在執行後對 exact Git blobs 的核對，mismatch 0，及
process group 清理結果。這是當時 supervisor 的記錄；下列 verifier 只檢查
封存 bytes 與報告內部一致性，不重新驗證歷史 process 或 source manifests。

原始報告已標示 `privateEnvironment: false`。`runnerEnvironment` 只含兩個
隔離 flags 與 PATH digest，invocation 的 report 位置已由原 harness redacted。
本次未對原件做二次 redaction。Verifier 固定四份原件的 SHA-256，重算每側
slots、calls、各 tier、recall、noise、FP 與 anti-cheat 計數。它不執行 scorer、
模型、網路或寫入報告，不依賴新增 runtime。

從 repository root 執行。

```sh
node eval/evidence/2026-10-16-closure-r-diagnostics/verify.mjs
```

退出 0 只證明封存完整性，不代表 R gate 通過。這份證據供 #145 與 #84 後續
判讀使用，不關閉任何 issue，也不授權合併 #257。
