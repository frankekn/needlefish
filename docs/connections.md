# Named connections

Source preview. Choose existing CLI adapters or trusted ACP executables by name:

```sh
needlefish --connection my-cli
needlefish pr 7 --connection my-agent
needlefish --connection my-agent --dry-run
```

Repeat `--connection` to set the order for whole-review quota fallback.
A single selection retains its existing behavior. OAuth account stores, login,
installation and provider presets remain separate work.
Without `auth`, two names still use the existing adapter credentials, not independent
accounts. ACP and Codex support the explicit environment bindings below. Unsupported
`authRef`, arbitrary env, presets and fallback fields are rejected.

## User-owned configuration

Create `connections.json` under `$XDG_CONFIG_HOME/needlefish`, or
`~/.config/needlefish` when XDG_CONFIG_HOME is unset. An explicit absolute
`NEEDLEFISH_CONNECTIONS_FILE` may select another user/operator-owned file.
An explicitly empty value is rejected as a non-absolute path.
The file must be outside the reviewed repository, including symlink targets.
Do not copy an untrusted project's configuration into this trusted location.
The reader accepts only regular files and limits the actual read to 64 KiB.
The path check is conservative. A concurrent change to a parent directory between
path resolution and opening the file can still redirect the read.

```json
{
  "version": 1,
  "connections": [
    {"id": "my-cli", "adapter": "claude", "model": "your-selected-model"},
    {
      "id": "my-agent",
      "adapter": "acp",
      "model": "your-agent-model",
      "launch": {
        "command": "/absolute/path/to/your-agent",
        "args": ["acp", "--model", "{model}"]
      }
    }
  ]
}
```

Model IDs and ACP argv above are examples to replace, not a claim that all agents
implement `acp --model`. Use the exact argv documented by your agent. `{model}`
must occupy exactly one whole argument when `model` is set. For an agent-selected
model, omit both model and placeholder; stats then omit the requested model
rather than borrowing `NEEDLEFISH_MODEL`. There is no variable, tilde, shell or
command-substitution expansion. An executable path containing spaces is one path.

Native CLI connections require a model. Without explicit auth, authentication and
endpoint/proxy policy keep the existing adapter configuration. Reasoning settings
and native executable selection also keep the existing configuration. Explicit
Codex proxy requirements are not bypassed. ACP identities
are open-ended; adding one does not add a `RunnerName`. `stats.runner` remains the
adapter. A requested model name is not evidence of the delivered model.

Do not put tokens, passwords or secrets in this file or in argv. Without `auth`,
existing generic ACP credential staging/passthrough rules still apply.

## Separate ACP environment credentials

An ACP agent that accepts a credential from an environment variable can bind
that variable to a different user-owned source for each connection:

```json
{
  "version": 1,
  "connections": [
    {
      "id": "account-a", "adapter": "acp",
      "launch": {"command": "/absolute/path/to/agent", "args": ["acp"]},
      "auth": {"env": {"AGENT_API_KEY": "ACCOUNT_A_KEY"}}
    },
    {
      "id": "account-b", "adapter": "acp",
      "launch": {"command": "/absolute/path/to/agent", "args": ["acp"]},
      "auth": {"env": {"AGENT_API_KEY": "ACCOUNT_B_KEY"}}
    }
  ]
}
```

These names are examples, not universal agent flags or credential conventions.
Use your agent's documented credential variable. Supply each source through a
trusted launch environment or secret manager; do not paste credentials into the
configuration or command arguments. Targets must be `API_KEY`/`TOKEN` or end in
`_API_KEY`/`_TOKEN`. Targets beginning with `GH_`, `GITHUB_`, `GIT_` or
`NEEDLEFISH_` are reserved.

Source names must be environment identifiers. Validation rejects these source
prefixes without regard to case: `GH_`, `GITHUB_`, `GIT_`, `NEEDLEFISH_`, `XDG_`,
`NODE_`, `LD_` and `DYLD_`. It also rejects `HOME`, `USERPROFILE`, `HOMEDRIVE`,
`HOMEPATH`, `PATH`, `PATHEXT`, `SHELL`, `COMSPEC`, `BASH_ENV`, `ENV`, `HTTP_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`. This denylist is not a general secret or
capability classifier. Other explicit source mappings, including values that name
host resources, are the trusted operator's responsibility. An unrestricted agent
may still access any host resource available to its user.

Selection snapshots all explicitly chosen sources. Missing, empty, invalid or
whitespace-wrapped values stop before launch: no default account, login probe or
automatic fallback.
Retries and all review passes retain the snapshot without changing `process.env`.
The bound values are private and absent from serialized options, result and cache.
Runner output is screened against the selected snapshot before admission, including
decoded JSON in Markdown fences. A complete selected credential value, including
its JSON-escaped form, stops the review with a safe diagnostic. Screening also
checks one decoding of standard JSON string escapes in plain text. Partial values,
other encodings and transformations are not covered. With explicit auth, raw
transcripts are excluded from public result and cache fields even when eval
tracing is enabled. Controlled trace callbacks remain
sensitive and can contain credentials. Without a private trace observer, an
authenticated traced review marks trace delivery incomplete. Matching uses
case-insensitive complete-value substrings. Short or common credential values may match ordinary protocol or
review text and stop a run even without an echo. This conservative check does not
impose a cross-agent minimum length or entropy rule.
`--dry-run` and docs-only zero-model reviews validate the configuration schema
and source names but do not require or bind credentials. They do not validate
compatibility with unused runtime environment passthrough. Other reviews bind
once after collecting the bundle, before any model starts.

Explicit auth always gets a new empty disposable HOME/USERPROFILE and XDG
config/data/cache/state roots, even when `NEEDLEFISH_EPHEMERAL_HOME` is off.
No ambient ACP auth files or user config are copied. Existing Git-config blocking,
empty GitHub config, shared deadline, process-group termination and cleanup apply.
HTTP(S) proxy variables from the existing base allowlist are retained. Before an
authenticated model run, nonempty `NEEDLEFISH_RUNNER_ENV_PASSTHROUGH` is rejected,
not silently dropped: reconcile
any required endpoint/CA/routing settings before using this mode. Arbitrary
per-connection environment overrides and file-based routing are outside this increment.

This isolates **default credential discovery**, not processes or provider identities.
A same-UID executable can still seek host files; project hooks/skills/MCP are not
made safe by an empty HOME. Use a trusted agent. This is not an OAuth/Keychain
integration, token vault, refresh manager or proof that two sources are different
accounts. Other native CLI bindings and the nontechnical login UI remain separate work.

## Shared runtime

Without `--connection`, no connection file is read. Legacy `--runner acp` still
uses `NEEDLEFISH_ACP_BIN` with empty argv. `--connection` conflicts with explicit
`--runner` and `--model`; change the profile instead. The CLI resolves and freezes
selection once. Neither retries nor review/critic passes reread it, even when
an earlier attempt changes the file. This freezes values, not executable bytes.

Named ACP launch goes through the same client as legacy launch:

- [Startup](acp-startup.md): bounded, validated initialize; session/new retains
  its existing failure kind and retryability.
- [Completion and failures](acp-failures.md): only end_turn completes a prompt;
  permission cancellation is sticky. Valid JSON or usage cannot revive a failure.
- Valid optional usage reaches the existing RunStat/parser/render path. Missing
  or invalid usage does not invalidate an otherwise completed turn.

No second retry loop, process manager, telemetry schema or routing framework is
introduced. Raw callbacks, review deadline, clone/HOME cleanup and integrity
checks stay in the shared lifecycle. Structured authentication failures do not
retry; transient session/new errors may use its bounded second attempt. ACP has no portable quota signal and cannot activate another connection.
Authentication failures, timeouts, refusal, cancellation and ordinary 429 errors
also stop without switching.

## Preview and qualification

Dry-run validates configuration without launching the agent or probing login.
Bundle output contains no connection metadata. It does not certify credentials,
workspace-setting isolation or model quality. The client supplies no filesystem/
terminal capabilities and never grants an interactive permission request.

The disposable clone and mutation checks are not an OS security sandbox. Arbitrary
agents' project hooks, skills and MCP remain outside this feature's isolation
claim. Existing review-completion, snapshot and capability issues remain open.
No installation, deployment, permissions or operator credentials are changed.

This candidate depends on #156 and #160. Class R qualification and a controlled
live canary are required before merge/deployment; fake-agent CI is not a substitute.

## Maintenance map

| Change | Owner and regression tests |
| --- | --- |
| Config shape, IDs and adapter selection | `connections.ts`: `parseConnections`; `connections.test.ts` |
| ACP launch shape and literal argv | Same file: private `parseAcpLaunch`; no filesystem or environment access |
| File trust, byte limit and frozen selection | Same file: `readConnections` / `resolveConnectionOptions`; `connections.test.ts` |
| CLI value syntax and conflicts | `src/cli/args.ts` uses `optionValue`; `connection-args.test.ts` |
| Adapter identities/metadata | Existing `runner-definition.ts`; no connection-specific catalog |
| ACP command/argv, startup/completion/usage | `acp.ts`; existing `acp*.test.ts` and named-launch integration below |
| ACP credential references and private snapshot | `connection-auth.ts`; `connection-auth.test.ts` |
| Codex credential references, explicit route, and metadata-only doctor | `connection-auth.ts`, `connections.ts`, `codex.ts`, `doctor.ts`; `codex-connection-auth.test.ts` |
| Child credential/HOME isolation | Existing `codex.ts`; `connection-auth-integration.test.ts` |
| Cross-pass launch/model plumbing | `src/cli.ts`, `codex.ts`; `connections-integration.test.ts` |

```sh
node --test --test-concurrency=1 --import tsx src/cli/connection-args.test.ts src/shared/connections.test.ts src/shared/connections-integration.test.ts src/shared/acp*.test.ts src/shared/connection-auth*.test.ts
pnpm check && pnpm lint && pnpm test
```

Parser regressions pin validation order, caller-owned input preservation, literal
argv, 65535/65536/65537-byte UTF-8 files, worktree-style `.git` files and external
symlinks. The private launch parser does not own credentials or process execution.

Keep one writer per shared-runtime branch. Record base/head, files, test evidence
and remaining gates in the PR before handing off; recheck head before pushing.

## 繁體中文

用 `--connection 名稱` 明確選定一個工具與模型，或信任的 ACP 啟動程式。
舊指令不讀新設定、不自動切換服務；指定連線後不能再搭配 `--runner`／`--model`。
未設定 `auth` 時仍沿用工具原本的登入資訊，不同名稱不是獨立帳號。
ACP 現可用 `auth.env` 將工具的密鑰變數綁到不同來源；設定檔只存變數名。
缺少認證就停止，重試不換帳號；強制使用空白暫存 HOME/XDG，不複製預設帳號。
此模式拒絕舊的任意 passthrough，避免暗中丟掉必要路由；OAuth、原生 CLI 多帳號、
安裝精靈仍未交付。這也不是作業系統隔離或供應商帳號驗證。

設定只能來自專案外的使用者檔案，請勿放密鑰。選定的 command／argv／模型
在重試與各審查階段保持固定，並沿用同一套握手、完成性、用量及清理流程。
取消、拒絕或權限失敗不能靠合法 JSON／用量變成成功；預覽不登入、不送程式碼。
工程測試通過仍不代表正式模型資格評估或受控 canary 已完成。


## Select a Codex API credential and route

This source-preview increment binds one environment credential reference to a
Codex route. It does not select or verify an OAuth account. Two references do not
prove two provider accounts. Formal Class R qualification remains required.

```json
{
  "version": 1,
  "connections": [
    {
      "id": "codex-direct",
      "adapter": "codex",
      "model": "your-selected-model",
      "auth": {
        "env": {"CODEX_API_KEY": "ACCOUNT_A_KEY"},
        "route": {"kind": "openai"}
      }
    },
    {
      "id": "codex-proxy",
      "adapter": "codex",
      "model": "your-selected-model",
      "auth": {
        "env": {"CODEX_PROXY_API_KEY": "ACCOUNT_B_KEY"},
        "route": {"kind": "cliproxyapi", "baseUrl": "http://127.0.0.1:8317/v1"}
      }
    }
  ]
}
```

Each route accepts exactly the target variable shown above. The source is an
environment variable name, never the key value. Supply the source through your
trusted launch environment. The proxy URL must use HTTP or HTTPS and must not
contain credentials, userinfo, a query, or a fragment. Do not put secrets in its
path or hostname. Selected credentials in raw or percent-decoded URLs are rejected
before launch. Malformed percent encoding is also rejected.

Direct mode rejects an ambient `CODEX_PROXY_BASE_URL`, `CODEX_PROXY_API_KEY`, or
`NEEDLEFISH_CODEX_PROXY_REQUIRED=1`. Remove those settings or select an explicit
proxy connection. Explicit auth also rejects legacy
`NEEDLEFISH_RUNNER_ENV_PASSTHROUGH`. Proxy mode uses only its selected URL and key.
Calls without explicit connection auth retain legacy routing.

Selection fixes the model, key, and route for retries and all review passes.
Changing the source environment affects only the next explicit selection. Each
invocation uses a new empty `HOME`, `USERPROFILE`, and `CODEX_HOME` with file
credential storage. It does not copy ambient auth, configuration, skills, or
history. The selected credential uses the same output guards as ACP auth.
Normal transport proxy environment variables retain their existing behavior.

```sh
needlefish --connection codex-direct
needlefish --connection codex-proxy
needlefish doctor --connection codex-direct --json
```

Doctor accepts named Codex connections. It checks local source selection and
executable availability without invoking the CLI. The auth result is `unknown`
and states that provider account identity is unknown. It does not publish login
status text, credential fragments, profile paths, or credential digests.
Missing or invalid selected credentials stop before any CLI probe or review.
OAuth login, refresh persistence, provider identity verification and other native
adapter auth variants remain outside this preview. Ordered quota fallback is
described below.


Codex 的 source preview 亦可用 `auth.env` 選定 API key 來源，並必須明確指定
`auth.route.kind` 為 `openai` 或 `cliproxyapi`。設定檔只存變數名稱與非秘密 URL。
重試與各 pass 共用同一份私有 snapshot。`doctor --connection 名稱` 只確認
Codex 來源已選定，provider 帳號身分仍為 `unknown`，不執行登入狀態查詢。
這不包含 OAuth 多帳號、refresh 或正式 Class R 資格。

## Ordered whole-review quota fallback

This source preview accepts an ordered list through repeated `--connection`.
Set the existing review budget before selecting multiple connections:

```sh
NEEDLEFISH_REVIEW_TIMEOUT_MS=600000 needlefish --connection primary --connection spare
```

IDs must be known, nonempty and distinct. Do not combine them with `--runner`
or `--model`. Configuration and all selected credential sources bind once.
Only the selected route's credentials reach its child process. All selected
credentials protect public output, including output from a different route.

Only verified native Codex terminal JSONL with a nonzero exit and recognized
exhaustion semantics can advance the list. The supported native 0.163 proof uses
controlled Responses-provider exhaustion, not real provider account verification.
An explicit CLIProxyAPI route remains a proxy route. It does not establish
ChatGPT subscription exhaustion. Other adapters' prose and generic 429 responses
cannot activate fallback.

Each route restarts the complete review, including map, deep and critic passes.
They share one captured source and one monotonic deadline. Each model pass
retains its independent throwaway clone. A concurrent sandbox, cancellation,
authentication or other failure prevents a quota event from hiding that failure.
Existing ordinary deep failures remain blocking residuals when no quota occurs.

Any complete verdict ends the list. `pass`, `needs_human` and
`changes_requested` never trigger another model. Exhausting every route is an
operational error. Local mode writes only the final complete cache. GitHub mode
claims once and delivers only the final complete review, after checking its head.
Failed-route transcripts remain in the private trace and evaluation canary flow.
Candidate findings and stats from failed routes do not enter the final result.

`doctor` and `explain` accept one connection only. `--dry-run` reports each
selected route's capability without binding credentials or calling models.
Docs-only reviews do not bind credentials, capture source or consume the budget.
Multiple model routes require `NEEDLEFISH_REVIEW_TIMEOUT_MS`; no new total-budget
default is implied by the per-pass timeout.

Class R qualification, sealed holdouts and the dependency PR gates remain pending.
This preview does not qualify any provider, credential store or production install.

重複 `--connection` 可指定整次審查的額度備援順序，多條連線須明確設定
`NEEDLEFISH_REVIEW_TIMEOUT_MS`。只有已驗證的 Codex native 終局額度訊號能前進。
每條連線從頭重跑，所有連線共用同一份來源與總期限。完整 verdict 立即結束。
認證、取消、timeout、隔離故障、一般 429 與 ACP 錯誤文字都不會觸發備援。
所有選定密鑰共同保護公開輸出，每個子程序只收到自己那條連線的密鑰。
全部額度耗盡就失敗，不寫部分 cache、不貼部分 review。正式 Class R 尚未完成。

## Machine editor

`needlefish connections <operation> --json [--repo <path>]` manages the same
operator configuration. The commands never run a model, login command, or
version probe. They do not bind credentials. Authentication and account identity
remain `unknown`, and qualification remains `unqualified`.

| Operation | Input through stdin | Success fields |
| --- | --- | --- |
| `list` | None | `revision`, `connections` descriptors |
| `edit` | None | `baseRevision`, validated raw `document` |
| `validate` | `{"document": <version-1 document>}` | `connections` descriptors |
| `apply` | `{"expectedRevision": "missing or sha256:…", "document": <version-1 document>}` | `revision`, `connections` descriptors |
| `inspect` | `{"ids": ["first", "second"]}` | `revision`, ordered descriptors with local executable availability |

Every response includes `schemaVersion: 1` and `ok`. Errors exit with code 1 and
return a fixed `code`. Invalid documents can include `issues` with fixed `field`
and `code` values. Parser messages, input fragments, executable paths, endpoint
URLs, and credential references do not appear in errors or catalog descriptors.
`edit` returns the local raw document, including paths and credential reference
names. Keep this response out of logs, exports, and review prompts. Arbitrary
text entered into profile fields is not certified safe to publish.

Reading request JSON from stdin has a five-second timeout and a 128 KiB limit.
Documents must fit the existing 64 KiB configuration limit. `validate` writes
nothing. Add, edit, and delete profiles by changing the complete `document` from
`edit`, then use one `apply`. Preserve ACP `{model}` arguments and raw `auth.env`
and `auth.route` fields. Parsed execution objects contain internal `auth.kind`
and substituted arguments, so they are not an editable document.

A missing file has revision `missing`. The configuration parent directory must
already exist and belong to the current user. A missing parent returns
`configuration_unavailable` and writes nothing. Existing invalid configurations are errors and
cannot be overwritten by an apply. Files must be regular, user-owned, outside the
reviewed repository, and have no extra hard links. Configuration directories and
files must not permit writes by other users. Canonical ancestors must belong to
the current user or root. Writable ancestors require sticky-directory protection.
The editor rejects a symlink file
or configuration parent. These editor restrictions do not change the existing
read-only `--connection` resolver.

Apply locks the canonical configuration path with an exclusive `.lock` file.
It compares the exact original byte revision, writes a same-directory exclusive
0600 temporary file, syncs the file, checks the revision again, renames it, and
syncs the directory. It then removes its lock and syncs that directory again
before reporting success. `revision_conflict`
requires a reload and an explicit draft
reapply. `config_busy` never removes an existing lock, even if it appears stale.
A failure before rename preserves the original file. `save_state_unknown` means
rename completed but durability or cleanup failed. Reload before any retry.
Cancellation before rename discards the temporary file. Cancellation after a
successful rename reports the saved result or `save_state_unknown`.

The lock coordinates writers using these commands. External editors do not
honor the lock. The final revision check detects some external changes, but it
cannot provide an atomic filesystem compare-and-swap against external writers.

`inspect` checks executable availability without executing it. HTTP runners with
no repository capability remain blocked. This check does not verify credentials,
provider identity, delivered model, independent accounts, or release gates.
Ordered IDs affect only this request. No fallback or account fields are added to
the stored version-1 document. Session credentials, review ingress, and the
advanced desktop interface are separate work.

The fixed error codes are `invalid_request`, `input_too_large`, `input_timeout`,
`invalid_configuration`, `unsafe_configuration`, `configuration_unavailable`,
`revision_conflict`, `config_busy`, `save_failed`, `save_state_unknown`, and
`cancelled`.
