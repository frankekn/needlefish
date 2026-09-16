# Runner capability preflight (#146)

## What users see / 使用者會看到什麼

Reviews now check that the selected connection can read project files **before
any model call**. An unsupported connection fails with an explanation, no review
result, and a nonzero exit. It never changes providers, truncates the diff, skips
the critic, or invents a passing result.

目前 AI 連線若只能處理傳入文字，不能讀取專案完成檢查，審查會在呼叫模型前
停止，說明原因與下一步。請使用已安裝並登入的 `codex`、`claude` 或 `opencode`；
一般使用者不需要填能力 JSON，也不需要新的開關。這次沒有新增安裝精靈。

| Runner | Repository access | Actual review |
| --- | --- | --- |
| codex, claude, opencode, grok, pi | Provided by the CLI adapter | Existing pipeline |
| openai (direct HTTP) | Supplied text only | Rejected before any HTTP request |
| acp | Unknown by default | Requires an operator declaration for a tested launcher |

This restriction covers **small reviews too**: their critic must re-open
producer/consumer code. Changing the HTTP model or setting `--deep` cannot add
tools to a prompt-only adapter. The low-level HTTP and ACP transports are not
removed; they are not automatically eligible for the full review pipeline.

Docs-only policy skips still make zero model calls and explicitly say the model
review was skipped. They require no runner capability or authentication.

## Preview and automation

`--dry-run` and `pr <number> --dry-run` use the same `reviewPlan` as a real review.
The redacted JSON summary adds `runnerPreflight`, with `status` equal to `ready`,
`unsupported`, or `not_required`. Unsupported previews **exit 1** and put the same
human-readable diagnostic on stderr. `--print-bundle` still emits only the
original bundle; the nonzero exit/diagnostic apply there too. Neither preview
writes a cache, executes a launcher, or probes credentials.

`ready` means capability-compatible, **not** authenticated, online, or guaranteed
to succeed. Normal runner errors and sandbox checks still apply. No preflight
metadata is added to model prompts or `ReviewResult`; its schema stays at 1.

For GitHub reviews, unsupported capability takes the existing operational-error
path: complete the owned pending check as failure, post an explanatory error
comment, and exit nonzero, without posting findings. Existing stale/closed and
same-head skip behavior is unchanged; upgrading does not rewrite old reviews.
Use a full `--recheck` after updating the actual executable for an existing head.

## Advanced: operator-tested ACP launchers

ACP `initialize` negotiates protocol features, not proof that an arbitrary agent
can independently read this repo or run the required Git/search commands. The
current client does not provide a generic file/terminal tool runtime. There is
no built-in list of verified ACP launchers in this change.

An operator who has tested the launcher's own repository tools can set
`NEEDLEFISH_ACP_BIN` to its **absolute executable path** and
`NEEDLEFISH_ACP_REPOSITORY_READ_SHA256` to the reviewed launcher's SHA-256 digest.
Preflight reads but never executes it. Missing/invalid/mismatched declarations,
non-files, non-executables, and launchers larger than 16 MiB stay `unknown`.

The preview labels accepted declarations `capabilitySource: operator_declared`,
never verified. This is an explicit operator assertion, not a security sandbox
or a probe of model/tool behavior. Pin any downstream executable and configuration
too: hashing a wrapper does not verify what it later launches. Retest when those
change. Do not automatically hash whatever is on disk and trust it at startup;
store the digest only after reviewing and testing that exact installation.

未知 ACP 啟動器不會因名稱或連線成功就被當成具備工具能力。進階宣告只供已經
驗證其專案讀取功能的管理者使用；預覽會標為「管理者宣告」，不是自動驗證。

## Upgrade and scope

From 0.4.6, direct-HTTP reviews and undeclared ACP reviews intentionally fail
rather than claiming full coverage. Unsupported dry runs now fail too while
retaining their diagnostic output. No automatic provider fallback is introduced.
Recommended CLI runners need no new configuration. Credentials, permission
boundaries, prompts, critic matching, and severity/verdict derivation are unchanged.

No plugin registry, new agent loop, database, UI, or dependency is added. This
preflight is reusable by future setup/doctor/UI work, which is outside this issue.
Live qualification and release canaries remain required by the project's eval
policy; fake-runner tests are not a claim that those gates have run.

Protocol reference: https://agentclientprotocol.com/protocol/v1/initialization
