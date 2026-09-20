# Named connections

Choose one existing CLI adapter or trusted ACP executable by name:

```sh
needlefish --connection my-cli
needlefish pr 7 --connection my-agent
needlefish --connection my-agent --dry-run
```

This increment selects **one** connection. It does not implement automatic
fallback, separate account stores, login, installation or provider presets.
Two names using the same CLI still use its existing credentials, not independent
accounts. Unsupported `authRef`, env, presets and fallback fields are rejected.

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

Do not put tokens, passwords or secrets in this file or in argv. Existing generic
ACP credential staging/passthrough rules still apply; this is not a new vault.

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
| Config shape, trust boundary, freezing | `src/shared/connections.ts`, `connections.test.ts` |
| CLI value syntax and conflicts | `src/cli/args.ts` uses `optionValue`; `connection-args.test.ts` |
| Adapter identities/metadata | Existing `runner-definition.ts`; no connection-specific catalog |
| ACP command/argv, startup/completion/usage | `acp.ts`; existing `acp*.test.ts` and named-launch integration below |
| Cross-pass launch/model plumbing | `src/cli.ts`, `codex.ts`; `connections-integration.test.ts` |

```sh
node --test --test-concurrency=1 --import tsx src/cli/connection-args.test.ts src/shared/connections.test.ts src/shared/connections-integration.test.ts src/shared/acp*.test.ts
pnpm check && pnpm lint && pnpm test
```

Keep one writer per shared-runtime branch. Record base/head, files, test evidence
and remaining gates in the PR before handing off; recheck head before pushing.

## 繁體中文

用 `--connection 名稱` 明確選定一個工具與模型，或信任的 ACP 啟動程式。
舊指令不讀新設定、不自動切換服務；指定連線後不能再搭配 `--runner`／`--model`。
目前沿用工具原本的登入資訊，不同名稱不是獨立帳號，也未交付額度備援或安裝精靈。

設定只能來自專案外的使用者檔案，請勿放密鑰。選定的 command／argv／模型
在重試與各審查階段保持固定，並沿用同一套握手、完成性、用量及清理流程。
取消、拒絕或權限失敗不能靠合法 JSON／用量變成成功；預覽不登入、不送程式碼。
工程測試通過仍不代表正式模型資格評估或受控 canary 已完成。
