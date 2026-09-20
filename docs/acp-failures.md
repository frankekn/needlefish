# ACP failure handling

This change prepares structured failure handling for the multi-connection work
in #152. It does **not** add quota fallback, change accounts, grant interactive
permissions, or qualify arbitrary ACP agents for workspace isolation.

A successful one-shot ACP review requires `session/prompt` to return
`stopReason: "end_turn"`. `cancelled`, `refusal`, `max_tokens`, and
`max_turn_requests` are failed calls, even when the agent already emitted valid
review JSON. Missing or unknown stop reasons are protocol errors. Agents that
previously omitted this required ACP field must fix their response.

An interactive `session/request_permission` cancels the run. Needlefish responds
with the ACP `cancelled` outcome, sends `session/cancel`, and stops the process
group using the existing managed timeout/kill lifecycle. It never selects an
allow option. A later success response cannot clear this failure. Check the
agent launch configuration and organization ask/deny policy rather than retrying
the same unattended invocation.

`RunnerFailure` carries an adapter-owned kind and retryability. The shared
runner finds it through existing `RunnerOperationalError.cause` wrappers;
callers using that public error class keep working. Authentication-required,
permission-required, cancelled/refused/limited turns, and malformed protocol
failures are not retried. Unclassified/server errors keep the existing bounded
retry policy. Other adapters' behavior is unchanged.

Only standard ACP/JSON-RPC codes are interpreted: `-32000` means authentication
required, `-32800` means request cancelled, and `-32700`/`-32600`/`-32601`/`-32602`
identify protocol incompatibilities. Raw error messages/data, malformed stdout,
and tool titles are not copied into public errors. Raw streams still reach the
existing failed-attempt callbacks for diagnostics and canary scanning.

There is no portable ACP quota-exhausted code. Text saying "quota exceeded", a
custom error code `429`, or model output claiming authentication failure is not
sufficient evidence for subscription fallback. Provider-specific quota mapping,
per-connection credentials, whole-review outcomes (including deep-pass failure),
fixed snapshots and route-wide deadlines remain separate follow-ups. This does
not close #145, #146, #101 or #102.

## Maintenance map

| Change | Owner | Regression tests |
| --- | --- | --- |
| Runner names, model env keys, auth-file metadata | `src/shared/runner-definition.ts` | `runner-metadata.test.ts`, `runner-detection.test.ts` |
| ACP messages, completion and optional usage | `src/shared/acp.ts` | `acp.test.ts`, `acp-failure.test.ts` |
| Failure kind and cause traversal | `src/shared/runner-failure.ts` | `runner-failure.test.ts` |
| Retry, raw callbacks, HOME and clone lifecycle | `src/shared/codex.ts` and existing process/sandbox owners | `codex*.test.ts`, `runner-process.test.ts`, `runner-sandbox.test.ts` |

Keep completion validation before usage extraction. Invalid/missing usage does
not fail a completed turn; valid usage never legitimizes a failed turn. Usage
is not remaining quota or a billing total across failed attempts. Preserve raw
failure callbacks before stopping retries. Do not introduce a second runner
catalog, failure taxonomy or cleanup owner when integrating another branch.

Focused credential-free check, from the repository root with pinned dependencies:

```sh
node --test --test-concurrency=1 --import tsx src/shared/acp.test.ts src/shared/acp-failure.test.ts src/shared/runner-failure.test.ts
```

Then run `pnpm check`, `pnpm lint`, and `pnpm test`. Record the exact head and
base, changed files and evidence in the existing PR; one writer per branch.
These engineering checks do not replace provider qualification or deployment.

## 中文摘要

本批提供 ACP 結構化失敗與正確的停止處理，**尚未提供多帳號或自動備援**。
只有 `end_turn` 才算呼叫完成；取消、拒絕、輸出限制與缺少停止原因都不能
用已輸出的 JSON 假裝成功。互動權限請求會取消並停止程序，不授權、不重試；
晚到的成功訊息不能清除失敗。登入等已知錯誤依協定代碼分類，不從模型文字
猜額度。公開錯誤遮蔽原始內容，原始 transcript 仍保留給既有診斷／canary callback。
正常完成後才讀取可選用量；缺少或無效用量不改變完成結果，有用量也不能將
失敗改成成功。用量不是剩餘額度，也不是含失敗嘗試的完整帳務數字。

## Protocol references

- https://agentclientprotocol.com/protocol/v1/prompt-turn
- https://agentclientprotocol.com/protocol/v1/tool-calls
- https://agentclientprotocol.com/protocol/v1/schema#errorcode

Changing which ACP responses count as usable output requires Class R
qualification and a controlled live canary before release. Stub tests alone are
not provider qualification or evidence that workspace rules/hooks/skills/MCP
imports are disabled.
