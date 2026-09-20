# Named connections

Choose one existing CLI adapter or trusted ACP executable by name:

```sh
needlefish --connection my-cli
needlefish pr 7 --connection my-agent
needlefish --connection my-agent --dry-run
```

This increment selects **one** connection. It does not implement automatic
fallback, OAuth account stores, login, installation or provider presets.
Without `auth`, two names still use the existing adapter credentials, not independent
accounts. ACP supports the explicit environment bindings below. Unsupported
`authRef`, arbitrary env, presets and fallback fields are rejected.

## User-owned configuration

Create `connections.json` under `$XDG_CONFIG_HOME/needlefish`, or
`~/.config/needlefish` when XDG_CONFIG_HOME is unset. An explicit absolute
`NEEDLEFISH_CONNECTIONS_FILE` may select another user/operator-owned file.
The file must be outside the reviewed repository, including symlink targets.
Do not copy an untrusted project's configuration into this trusted location.
The reader accepts only regular files and limits the actual read to 64 KiB.

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

Native CLI connections require a model. Authentication, endpoint/proxy policy,
reasoning settings and native executable selection keep the existing adapter's
configuration. Explicit Codex proxy requirements are not bypassed. ACP identities
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
`_API_KEY`/`_TOKEN`. GitHub/Git orchestration variables cannot be sources or
targets; process, HOME, executable and routing overrides are not auth bindings.

Selection snapshots only the chosen sources. Missing, empty or invalid values
stop before launch: no default account, login probe or automatic fallback.
Retries and all review passes retain the snapshot without changing `process.env`.
The bound values are private and absent from serialized options, result and cache.
Raw agent transcripts remain sensitive; an agent can itself echo credentials.

Explicit auth always gets a new empty disposable HOME/USERPROFILE and XDG
config/data/cache/state roots, even when `NEEDLEFISH_EPHEMERAL_HOME` is off.
No ambient ACP auth files or user config are copied. Existing Git-config blocking,
empty GitHub config, shared deadline, process-group termination and cleanup apply.
HTTP(S) proxy variables from the existing base allowlist are retained. Nonempty
`NEEDLEFISH_RUNNER_ENV_PASSTHROUGH` is rejected, not silently dropped: reconcile
any required endpoint/CA/routing settings before using this mode. Arbitrary
per-connection environment and file-based routing are outside this increment.

This isolates **default credential discovery**, not processes or provider identities.
A same-UID executable can still seek host files; project hooks/skills/MCP are not
made safe by an empty HOME. Use a trusted agent. This is not an OAuth/Keychain
integration, token vault, refresh manager or proof that two sources are different
accounts. Native CLI bindings and the nontechnical login UI remain separate work.

## One selection, one runtime

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
retry; transient session/new errors may use its bounded second attempt. Neither
an error code nor quota prose activates another connection in this increment.

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
額度備援與安裝精靈仍未交付。這也不是作業系統隔離或供應商帳號驗證。

設定只能來自專案外的使用者檔案，請勿放密鑰。選定的 command／argv／模型
在重試與各審查階段保持固定，並沿用同一套握手、完成性、用量及清理流程。
取消、拒絕或權限失敗不能靠合法 JSON／用量變成成功；預覽不登入、不送程式碼。
工程測試通過仍不代表正式模型資格評估或受控 canary 已完成。
