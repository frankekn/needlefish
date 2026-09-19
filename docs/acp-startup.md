# ACP startup failures (#157)

Needlefish now gives ACP `initialize` its own 30-second deadline. No extra
configuration is needed. The optional, operator-owned
`NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS` accepts 1–2147483647 milliseconds; empty
means the default. The remaining runner/review budget always wins.

Only a matching JSON-RPC 2.0 initialize result with `protocolVersion: 1` completes
the handshake. Stderr, notifications and partial JSON do not reset its timer.
A silent launcher, incompatible response or startup exit fails without a second
runner attempt. A late response after cancellation cannot revive the run.

`session/new` retains the existing remaining call budget, failure kind and
retryability. A transient server error can recover on the existing second
attempt; authentication/protocol failures stay non-retryable. Its diagnostics
name that stage without turning every session error into a handshake failure.
`session/prompt` retains the normal review timeout and bounded retry policy;
this change does not impose a 30-second model-review limit.

Failures while waiting for `initialize` or `session/new` report the stage, a
safe reason, elapsed milliseconds, exit/signal and stream byte counts. Pre-launch
configuration errors instead identify the missing or invalid setting; no process
has started to measure. After `session/prompt` is sent, timeout errors name that
stage. Other review-stage errors retain the existing structured failure messages;
this change does not add the startup diagnostic summary to them.

Public errors never publish raw stderr, even before the prompt: startup logs
can contain credentials. Unknown causes remain unknown. Full raw streams still
reach the existing failed-attempt/diagnostic callbacks; this does not add an
automatically uploaded log or a durable credential-bearing artifact.
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

握手或建立工作階段失敗時，公開診斷會提供階段、耗時、退出狀態與串流大小；
啟動前的設定錯誤則指出缺少或無效的設定。實際審查逾時會標示 `session/prompt`，
其他審查階段錯誤沿用既有結構化訊息，不承諾相同的啟動診斷摘要。
不再讓握手空等兩次 10 分鐘。正常使用不需新增設定；預設握手期限為 30 秒。
請先檢查工具安裝、登入與啟動設定，不要把這種失敗當成程式有 bug，或改用
其他帳號掩蓋設定問題。原始錯誤串流不會直接貼入 PR，以免洩漏憑證。

## Qualification

Depends on #156. CI/fake-agent tests are not live provider qualification.
Conservatively Class R pending: initialize validation rejects previously
accepted incompatible responses, and the underlying #156 changes usable-output
semantics. No deployed lane is changed until the project gates and controlled
canary have passed.
