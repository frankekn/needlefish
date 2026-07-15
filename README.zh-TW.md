<p align="center">
  <img src="assets/banner.png" alt="Needlefish" width="100%">
</p>

# needlefish（繁體中文）

[English](README.md) | 繁體中文

嚴格的本機 PR 審查工具。它會像資深工程師一樣檢查 diff，只回報真正的
缺陷：錯誤、回歸、安全性、資料遺失、遷移／升級風險、缺少驗證或重複行為，
不回報單純的風格問題。

預設為唯讀。小型 PR 會執行審查與對抗式 critic；大型 PR 會先執行 map／deep
階段，再交給相同的 critic。Codex 是 hosted action 的預設 runner；Kiro CLI
支援明確指定的本機與 self-hosted 執行，也支援 Claude Code、opencode、OpenAI
相容 HTTP、Grok、pi 與 ACP。Hosted composite action 不會安裝 Kiro。最終
verdict 由保留下來的 finding 確定性推導，不由模型自由決定。

## 安裝

在要審查的 git repo 中執行：

```bash
npx needlefish
```

需要 Node 20 以上，以及至少一個已登入且位於 `PATH` 的 runner CLI。
Needlefish 會依序自動偵測 `codex`、`claude`、`opencode`；要指定 runner，
請傳入 `--runner` 或設定 `NEEDLEFISH_RUNNER`。

## GitHub Action 快速開始

在目標 repo 新增 `.github/workflows/needlefish.yml`：

```yaml
name: needlefish
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: frankekn/needlefish@v0
        env:
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
```

設定一個 secret：已登入 Codex CLI 的 `~/.codex/auth.json` 內容
（`CODEX_AUTH_JSON`），或 `CODEX_API_KEY`，然後開啟 PR。finding 會以對應
diff 的 inline review comment 發布；後續 push 會更新同一份 review，標示
fresh／still-open／resolved，不會不斷堆疊新 review。

小型 PR 每次審查使用 2 次模型呼叫（預設 `medium` 約 48 秒）；大型 PR 使用
1 次 map、N 次 deep（預設並行數 3）及 1 次 critic。純文件 PR 與未變更的
head 會跳過模型。維護者可以在 PR 留言
`@needlefish recheck` 或 `@needlefish explain <finding>`。

## 開發環境安裝

需要：

- Node 20 以上
- Corepack（建議）或 `package.json` 指定的 pnpm
- 一個已登入的模型 CLI：Codex、Claude Code、Kiro CLI 或 opencode
- GitHub CLI（`gh`，供 `--pr`、`pr` 與 GitHub Action 模式使用）

```bash
git clone https://github.com/frankekn/needlefish
cd needlefish
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
corepack enable
corepack prepare "$PNPM_VERSION" --activate
pnpm install --frozen-lockfile
```

若沒有 Corepack：

```bash
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
npm exec --yes --package "$PNPM_VERSION" -- pnpm install --frozen-lockfile
```

### （選用）讓開發 shim 位於 PATH

repo 內含 `bin/needlefish` 開發 shim。可將它連結到 PATH 內的目錄：

```bash
ln -sf "$PWD/bin/needlefish" ~/.local/bin/needlefish
needlefish --version
```

shim 會解析 symlink，使用 repo 內的 `tsx` 執行 `src/cli.ts`，也適用於非
互動 shell。不做此步驟時，請使用完整路徑呼叫。

## 本機使用（唯讀，不會寫入 GitHub）

在有變更的目標 repo 中執行：

```bash
# 套件安裝／執行
cd /path/to/some-repo
npx needlefish

# 已建立開發 shim 時
needlefish

# 尚未建立 shim 時
/path/to/needlefish/node_modules/.bin/tsx /path/to/needlefish/src/cli.ts

# 審查未提交變更（dirty worktree 或尚無 commit 時預設也會如此）
needlefish --repo /path/to/some-repo --uncommitted
needlefish --repo /path/to/some-repo --branch

# 審查已提交的 diff
needlefish --repo /path/to/some-repo --focus security
needlefish --repo /path/to/some-repo --deep
needlefish --repo /path/to/some-repo --pr 123
needlefish --repo /path/to/some-repo --base develop

# 從任意 branch 審查 PR ref
needlefish pr 123 --repo /path/to/some-repo

# 指定 runner
needlefish --repo /path/to/some-repo --runner claude
needlefish --repo /path/to/some-repo --runner kiro --model gpt-5.6-luna --effort xhigh
needlefish --repo /path/to/some-repo --runner opencode --model zai-coding-plan/glm-5.2
NEEDLEFISH_ACP_BIN=/path/to/acp-agent needlefish --repo /path/to/some-repo --runner acp
```

Markdown 會輸出到 stdout；JSON 會儲存於
`~/.cache/needlefish/<repo>/last-review.json`。使用 `--json` 可輸出相同的
`ReviewResult`：

```bash
needlefish --repo . --json | jq .verdict
```

## 機器介面

`needlefish --repo <path> --json` 與 `needlefish pr <number> --json` 會輸出
帶版本的 `ReviewResult` JSON。`schemaVersion` 內只新增欄位，不修改或移除
既有欄位；破壞性變更需要新的 `schemaVersion` 與 changelog。

主要欄位：

| 欄位 | 說明 |
| --- | --- |
| `schemaVersion` | 固定為 `1`。 |
| `verdict` | `pass`、`needs_human` 或 `changes_requested`。 |
| `reviewTarget` | 選用的審查目標字串。 |
| `findings[]` | 含嚴重度、標題、分類、檔案、行號、信心度、原因、修正與驗證。 |
| `residualRisks[]` | 含 `text` 與 `blocks` 的殘餘風險。 |
| `checked[]` | 審查過的證據字串。 |
| `stats` | 選用的 runner 呼叫時間與嘗試次數。 |
| `totalDurationMs` | 選用的總審查時間（毫秒）。 |

base 預設依序為 `--base`、`origin/HEAD`、`main`；可用
`--base <ref>` 覆寫。

## GitHub Action 模式（self-hosted runner）

`needlefish --github --pr N` 會透過 `gh api` 取得 PR，執行相同的核心流程，
並發布非 sticky 的 `COMMENT` review 與權威的 `Needlefish` check-run：

| verdict | review event | check |
| --- | --- | --- |
| pass | COMMENT | success |
| changes_requested | COMMENT | failure |
| needs_human | COMMENT | neutral |
| run failed | 無 | failure |

所有 verdict review 都是 `COMMENT`，不是 approval 或 blocking-review event。
check-run 才是 merge gate。有效且精確的 replacement 會轉成原生 GitHub
suggestion；驗證失敗時會退回一般 comment。

Reusable workflow 會在 self-hosted job 啟動前跳過 closed 或 forked PR；發布
結果前也會重新讀取 PR，若 head SHA 改變或 PR 已關閉，就不輸出結果。

### Runner 設定（一次性）

目標 repo 透過 reusable workflow 呼叫本 repo：

```yaml
jobs:
  review:
    uses: frankekn/needlefish/.github/workflows/review.yml@main
    with:
      pr_number: ${{ github.event.inputs.pr_number || github.event.pull_request.number }}
      # 可選；self-hosted 預設 kiro + gpt-5.6-luna + xhigh
      # runner: codex
      # model: gpt-5.6-sol
      # effort: medium
      # codex_reasoning_effort: medium # 舊 Codex 相容輸入
      # timeout_ms: "600000"
    secrets: inherit
```

預設 Kiro lane 若有 intended Pro／Pro+／Pro Max／Power account 的 repository
或 organization Actions secret `KIRO_API_KEY` 就優先使用；否則使用 runner
service account 的 sanitized `~/.config/needlefish/kiro-auth.sqlite3`。Adapter
會把它複製到 disposable HOME，缺少時 fail closed。`secrets: inherit` 會傳入
optional API key。

要使用 Grok 4.5，將 runner 與 model 設為 `grok` 與 `grok-4.5`。runner
必須已有登入的 `grok` CLI 且位於 `PATH`；workflow 不會安裝或登入該 CLI。

一次性手動審查：

```bash
PR_NUMBER=123 # 替換為 PR 編號
gh workflow run review.yml -R frankekn/needlefish --ref main \
  -f pr_number="$PR_NUMBER" -f runner=grok -f model=grok-4.5
```

Grok 4.5 lane 會刻意停用 Grok 的 process-level plan mode，才能輸出有效
JSON。workflow 只在明確選擇 `runner=grok` 時設定
`NEEDLEFISH_ALLOW_GROK_UNSANDBOXED=1`，因此只能在你控制的 runner 上使用。

1. 在目標 repo 註冊 self-hosted runner，並限制在自己控制的機器。
2. 在 runner 部署 Needlefish；`main` 的 push 會觸發 `needlefish-deploy`：
   ```bash
   ssh termtek@ubuntu 'sh -s' < scripts/deploy-ubuntu.sh
   ```
3. 確認 `gh` 與選定的模型 CLI 位於 `PATH`。
4. 設定所選 CLI 的認證。預設 Kiro lane 優先使用 intended account 的非空
   `KIRO_API_KEY` repository／organization Actions secret。若 secret 不存在，
   self-hosted workflow 使用 `~/.config/needlefish/kiro-auth.sqlite3` 的
   sanitized auth DB；guarded 執行會以 mode 0600 複製到 disposable
   `HOME/.local/share/kiro-cli/data.sqlite3`。只保留 auth state，不可包含
   conversation/history rows。Needlefish 不會安裝 Kiro CLI；請使用 operator
   支援的 Kiro 發行方式安裝。Codex 例如：
   ```bash
   printf '%s' "$CODEX_API_KEY" | codex login --with-api-key -c 'service_tier="fast"'
   ```
   Grok 則依 provider 完成 CLI 登入或 key 設定，並確認 `grok` 可執行。
5. 若 Needlefish 是 private repo，caller repo 必須被允許呼叫 reusable workflow。
6. 模型 CLI 可能讀取 runner home 的 global instructions。若要避免外部指令
   混入，請保持 runner home 沒有不相關的 instruction 檔案。

> Self-hosted runner 會在你的機器上執行 PR code。若接受外部 contributor，
> 請改用 ephemeral container 隔離持久化主機。

## GitHub Action（hosted，任何 repo）

此 repo 也提供在 GitHub-hosted `ubuntu-latest` 執行的 composite action：

```yaml
name: needlefish
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: frankekn/needlefish@v0
        env:
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
```

Hosted action 只會安裝 `action.yml` 列出的 runner；Kiro 與 Grok CLI 都不在
其中。要使用 Kiro Luna 或 Grok 4.5，請使用上方的 self-hosted reusable
workflow。

runner 認證方式：

| runner | secret／認證 |
| --- | --- |
| codex | `CODEX_AUTH_JSON` 或 `CODEX_API_KEY` |
| kiro | `KIRO_API_KEY` 或 sanitized guarded auth DB（僅 self-hosted；hosted 不支援） |
| claude | `ANTHROPIC_API_KEY` |
| opencode | 所選模型的 provider key，例如 `OPENAI_API_KEY` |
| grok | Grok CLI auth 或 provider key（self-hosted lane） |
| pi | `PI_AUTH_JSON` |
| acp | agent-specific auth 與 runner 上的 `NEEDLEFISH_ACP_BIN` |

Fork PR 預設不會收到 secrets，workflow 會跳過它們；不要在不了解風險前使用
`pull_request_target`，因為它會把 secrets 交給由 fork code 觸發的 workflow。

## Model runner 執行方式

可使用 `--runner`、`--model`、`--effort`、`--timeout-ms`，或相同的環境變數：

| 選項 | 環境變數 | 預設 |
| --- | --- | --- |
| runner | `NEEDLEFISH_RUNNER` | 自動偵測 codex → claude → opencode |
| model | `NEEDLEFISH_MODEL` | runner 預設值 |
| effort | — | runner 預設值；self-hosted Kiro 預設 `xhigh` |
| Codex 相容 effort | `CODEX_REASONING_EFFORT` | `medium` |
| timeout | `NEEDLEFISH_TIMEOUT_MS` | `600000` |

Codex 使用 `--ignore-user-config` 與唯讀 sandbox；Claude 使用 plan mode；
Kiro 使用隨機 custom agent，只提供並自動允許 `read`、`grep`；完整 prompt
透過 mode-0600 file URI 載入，不放在 argv/stdin。每次呼叫使用 disposable
`KIRO_HOME` 並停用 inherited resources 與 auto-update；guarded 模式另使用
disposable `KIRO_DATA_DIR`。非空 `KIRO_API_KEY` 可使用空 data dir；manual/local
執行才可用 `NEEDLEFISH_KIRO_AUTH_DB` 指定可讀的一般 auth DB，以 mode 0600
複製到 disposable `HOME/.local/share/kiro-cli/data.sqlite3`，且 parent-only
path 不會傳給 child。Production review/eval workflow 優先使用
`KIRO_API_KEY`，否則使用 guarded auth-DB fallback。Grok 預設使用 `--permission-mode plan`，但 self-hosted Grok 4.5 lane 會
明確停用它以取得有效 JSON。opencode 與 pi 的 headless 唯讀能力未完全驗證，
因此必須分別設定 `NEEDLEFISH_ALLOW_OPENCODE_RUNNER=1` 或
`NEEDLEFISH_ALLOW_PI_RUNNER=1`。ACP 透過 `NEEDLEFISH_ACP_BIN` 使用 JSON-RPC
2.0 stdio process，timeout 時會先送 `session/cancel` 再終止 process group。

非 Codex runner 會在 review head 的 throwaway clean clone 中執行；每次成功
呼叫後都會確認 sandbox 沒有未提交變更且 `HEAD` 沒有移動。

### Runner subprocess 環境

Runner 只會收到 allowlist 環境，不會繼承完整的 parent `process.env`。若要
額外傳遞變數，設定：

```bash
NEEDLEFISH_RUNNER_ENV_PASSTHROUGH=VAR1,VAR2
```

ACP 認證還需要宣告 `NEEDLEFISH_ACP_AUTH_ENV_VARS`，並把相同名稱放入
`NEEDLEFISH_RUNNER_ENV_PASSTHROUGH`；或者以
`NEEDLEFISH_ACP_AUTH_FILES` 指定要複製到 disposable HOME 的 HOME-relative
credential files。

## Verdict 推導（確定性）

- 任何 P0／P1／P2 finding → `changes_requested`
- 沒有上述 finding，但有 blocking residual risk → `needs_human`
- 其他情況 → `pass`

只有 P3 的 finding 會被報告，但不會阻擋 merge，check 仍為綠燈。

## 狀態

v0.3.4。唯讀。已提供 inline review comment、sticky re-review
（fresh／open／resolved）、`@needlefish recheck`／`@needlefish explain`、
純文件 fast path（不呼叫模型）、same-head dedupe、以及 hosted runner 的
repo inspection（best-effort AppArmor sysctl）。`--fix` 仍刻意未實作。
