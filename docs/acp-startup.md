# ACP startup failures (#157)

Needlefish now gives ACP `initialize` its own 30-second deadline. No extra
configuration is needed. The optional, operator-owned
`NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS` accepts 1–2147483647 milliseconds; empty
means the default. The remaining runner/review budget always wins.

Only a matching JSON-RPC 2.0 initialize result with `protocolVersion: 1` completes
the handshake. Stderr, notifications and partial JSON do not reset its timer.
A silent launcher, incompatible response or startup exit fails without a second
runner attempt. A late response after cancellation cannot revive the run.

`session/new` retains the existing remaining call budget, but failures name that
stage. `session/prompt` retains the normal review timeout and bounded retry
policy; this change does not impose a 30-second model-review limit.

Public errors report stage, cause category, elapsed milliseconds, exit/signal
and stream byte counts. They never publish raw stderr, even before the prompt:
startup logs can contain credentials. Unknown causes remain unknown. Full raw
streams still reach the existing failed-attempt/diagnostic callbacks; this does
not add an automatically uploaded log or a durable credential-bearing artifact.
Run a trusted launcher's diagnostic command in its service account/environment
to investigate startup configuration. Keep stderr separate from ACP stdout.

In large reviews a startup failure stops NEW deep work and prevents critic
execution. Already-running siblings drain under their existing budgets so their
transcripts and cleanup are not lost. The handshake limit is not a promise that
the whole parallel review exits within 30 seconds; normal kill grace also applies.
Post-startup deep failures keep the existing blocking residual behavior.

No provider switching, account changes, permission grants, prompt changes,
result-schema changes or new services are included. This is not the #145
completion-check fix or a resolution of arbitrary agents' workspace imports.

## 中文

AI 工具沒啟動成功時，現在會指出卡在握手、建立工作階段，或實際審查，
不再讓握手空等兩次 10 分鐘。正常使用不需新增設定；預設握手期限為 30 秒。
請先檢查工具安裝、登入與啟動設定，不要把這種失敗當成程式有 bug，或改用
其他帳號掩蓋設定問題。原始錯誤串流不會直接貼入 PR，以免洩漏憑證。

## Qualification

Depends on #156. CI/fake-agent tests are not live provider qualification.
Conservatively Class R pending: initialize validation rejects previously
accepted incompatible responses, and the underlying #156 changes usable-output
semantics. No deployed lane is changed until the project gates and controlled
canary have passed.
