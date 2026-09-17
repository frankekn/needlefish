# Named connections: first increment

Choose an existing CLI adapter or your own ACP executable by name:

```sh
needlefish --connection my-cli
needlefish pr 7 --connection my-agent
needlefish --connection my-agent --dry-run
```

This increment selects **one** connection. It does not implement automatic
fallback, separate account stores, login, installation or provider presets.
Two names that use the same CLI still use its existing credentials. They are
not independent accounts. Account isolation and quota fallback are subsequent
increments, not hidden behavior in this release.

## User-owned configuration

Create `connections.json` under `$XDG_CONFIG_HOME/needlefish`, or
`~/.config/needlefish` when XDG_CONFIG_HOME is unset. An explicit absolute
`NEEDLEFISH_CONNECTIONS_FILE` may select another user/operator-owned file.
The file must be outside the reviewed repository, including symlink targets.
Do not copy an untrusted project's configuration into this trusted location.

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

The model IDs and ACP command above are examples to replace, not a claim that
all agents implement `acp --model`. Use the exact argv documented by your agent.
`{model}` must occupy exactly one whole argument when `model` is set. If the
agent chooses its own model, omit `model` and the placeholder; Needlefish then
omits the requested model from stats rather than borrowing NEEDLEFISH_MODEL.
No variable, tilde, shell or command-substitution expansion is performed.
An executable path containing spaces is one path, not a shell command.

Native CLI connections require a model to avoid inheriting another lane's
ambient model selection. Authentication, endpoint/proxy policy, reasoning
settings and native executable selection still use the existing adapter's
configuration. An explicit Codex proxy requirement is not changed or bypassed.
ACP names are open-ended; adding an agent does not require a new RunnerName.
The persisted `stats.runner` remains the adapter (`acp`, for example).
A requested model name is not evidence of the provider's delivered model.

Do not put tokens, passwords, authentication stores or secrets in this file or
in argv. `authRef`, arbitrary env overrides, presets and fallback configuration
are rejected rather than silently ignored in this increment. Existing generic
ACP credential staging/passthrough rules still apply; this is not a new vault.

## Compatibility and limits

Without `--connection`, no connection file is read and legacy behavior stays
unchanged. `--connection` conflicts with explicit `--runner` and `--model`;
change the selected profile instead. Selection is resolved once, before the
review: changing the file mid-run does not switch models or ACP launch args.
This freezes configuration values, not the executable's bytes.

Dry-run validates the selected configuration but neither launches the agent nor
probes credentials. Its existing bundle output stays free of connection data.
It does not certify repository tools, login, workspace-setting isolation or
model quality. Existing HTTP/repository capability limitations (#146), snapshot
work (#101) and review-completion policy (#145) are not fixed by this feature.

The external ACP executable must already be trusted and able to work with the
existing client: Needlefish supplies no filesystem/terminal client capabilities
and does not add permission approval or model-selection RPCs here. It preserves
the current ACP protocol behavior. Devin/Copilot-specific login and settings
isolation have not been qualified by this change. A successful stub test is not
proof that an arbitrary agent disables project hooks, skills or MCP.

Use trusted projects and the existing runner threat model. The disposable clone
and mutation checks are not an OS security sandbox. This change does not install
software, widen permissions, start background services or switch providers.

## 繁體中文

這是多連線計畫的第一批：先能用 `--connection 名稱` 選定一個工具與模型，
或使用自己信任的 ACP 啟動程式。舊指令不讀新設定，也不會自動切換服務。
指定連線後不能再搭配 `--runner`／`--model`，請在該連線內選模型。

目前仍使用工具原本的登入資訊；不同連線名稱不代表不同帳號。獨立帳號、
額度不足自動備援、圖形安裝精靈及各家工具的安全範本尚未交付，相關欄位
會明確拒絕，不會假裝設定成功。請勿把密鑰放入設定檔或啟動參數。

設定只從個人目錄或明確指定的絕對路徑讀取，不接受待審專案內的設定檔。
預覽只驗證設定，不登入、不送程式碼，也不證明該工具已通過完整審查評估。
