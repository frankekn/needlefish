import AppKit
import SwiftUI

struct GithubSetupFailure: Decodable, Error, LocalizedError {
    let schemaVersion: Int
    let phase: String
    let message: String
    var errorDescription: String? { message }
}

struct GithubRepository: Decodable, Identifiable, Sendable {
    let name: String
    var id: String { name }
}
struct GithubRepositories: Decodable, Sendable {
    let schemaVersion: Int
    let repositories: [GithubRepository]
}
struct GithubSetupStatus: Decodable, Sendable {
    enum Phase: String, Decodable, Sendable {
        case preview, prCreated = "pr_created", merged, conflict
        var title: String {
            switch self {
            case .preview: "可預覽，尚未建立設定 PR / Preview; no setup PR yet"
            case .prCreated: "設定 PR 已建立，請在瀏覽器檢查 / Setup PR created; inspect in your browser"
            case .merged: "設定已在預設分支，尚未驗證 AI 認證 / Configuration on default branch; AI authentication unverified"
            case .conflict: "既有設定需要人工確認，未修改 / Existing configuration needs inspection; unchanged"
            }
        }
    }
    let schemaVersion: Int
    let repository: String
    let admin: Bool
    let actions: Bool
    let actionsReason: String?
    let phase: Phase
    let conflict: String?
    let secret: String
    let authentication: String
    let firstReview: String
    let prUrl: String?
    let workflow: String
    let currentWorkflow: String?
    let disclosure: String
    let settingsUrl: String
    let removal: String
    func validated() throws -> Self {
        guard schemaVersion == 1, authentication == "unknown", firstReview == "not_verified",
              ["present", "missing", "unknown"].contains(secret),
              repository.range(of: "^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$", options: .regularExpression) != nil,
              settingsUrl == "https://github.com/\(repository)/settings/actions" else { throw DesktopError.invalidOutput }
        if let prUrl {
            guard prUrl.hasPrefix("https://github.com/\(repository)/pull/"),
                  Int(prUrl.components(separatedBy: "/").last ?? "") != nil else { throw DesktopError.invalidOutput }
        }
        return self
    }
}

extension DesktopCLI {
    func githubCall(_ args: [String], command: Command, input: Data? = nil,
                    timeout: TimeInterval = 120, progress: @escaping @Sendable (String) async -> Void = { _ in }) async throws -> CommandOutput {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("needlefish-github-" + UUID().uuidString)
        var environment = runtime.environment(temporary: temporary)
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin")
        return try await command.run(runtime.command(["setup", "github"] + args), environment: environment,
                                     temporary: temporary, timeout: timeout, input: input, progress: progress)
    }
    func githubStatus(_ repository: String, action: String = "status", replace: Bool = false,
                      input: Data? = nil, command: Command) async throws -> GithubSetupStatus {
        var args = [action, "--repository", repository, "--json"]
        if action != "status" { args.append("--confirm") }
        if replace { args.append("--replace-secret") }
        let output = try await githubCall(args, command: command, input: input)
        if output.status != 0 {
            let failure = try JSONDecoder().decode(GithubSetupFailure.self, from: output.stdout)
            guard failure.schemaVersion == 1, failure.phase == "error" else { throw DesktopError.invalidOutput }
            throw failure
        }
        return try JSONDecoder().decode(GithubSetupStatus.self, from: output.stdout).validated()
    }
}

@MainActor
final class GithubSetup: ObservableObject {
    enum State { case start, busy(String), repositories([GithubRepository]), status(GithubSetupStatus), error(String) }
    @Published var state: State = .start
    @Published var selection = ""
    @Published var credential = ""
    @Published var consent = false
    @Published var replace = false
    @Published var code: String?
    private var command: Command?
    private var task: Task<Void, Never>?
    let runtime: Runtime?
    var busy: Bool { command != nil }
    init(runtime: Runtime?) { self.runtime = runtime }

    private func run(_ label: String, operation: @escaping @MainActor (DesktopCLI, Command) async throws -> State) {
        guard !busy else { return }
        guard let runtime else { state = .error(DesktopError.runtime.localizedDescription); return }
        let command = Command()
        self.command = command
        state = .busy(label)
        code = nil
        task = Task {
            do { state = try await operation(DesktopCLI(runtime: runtime), command) }
            catch DesktopError.cancelled { state = .error(DesktopError.cancelled.localizedDescription) }
            catch DesktopError.timeout { state = .error(DesktopError.timeout.localizedDescription) }
            catch DesktopError.outputLimit { state = .error(DesktopError.outputLimit.localizedDescription) }
            catch DesktopError.cleanup { state = .error(DesktopError.cleanup.localizedDescription) }
            catch let error as GithubSetupFailure { state = .error(error.localizedDescription) }
            catch { state = .error("未完成。請確認已安裝官方 GitHub CLI、登入 github.com、具備 repo admin 權限、組織允許 Actions，以及網路可用，再重試。帳戶額度與 AI 認證尚未驗證。 / Incomplete. Check official gh installation, sign-in, repository admin access, Actions policy and network, then retry. AI authentication and quota are unverified.") }
            self.command = nil
            task = nil
            code = nil
        }
    }
    func login() {
        run("等待 GitHub 官方瀏覽器登入。授權由 gh 保存，可取消。 / Waiting for official GitHub browser login.") { cli, command in
            let output = try await cli.githubCall(["login", "--confirm"], command: command, timeout: 16 * 60) { code in
                await MainActor.run { self.code = code }
            }
            guard output.status == 0 else { throw DesktopError.auth }
            return try await self.repositories(cli, command)
        }
    }
    private func repositories(_ cli: DesktopCLI, _ command: Command) async throws -> State {
        let output = try await cli.githubCall(["repositories", "--json"], command: command)
        guard output.status == 0 else { throw DesktopError.auth }
        let list = try JSONDecoder().decode(GithubRepositories.self, from: output.stdout)
        guard list.schemaVersion == 1 else { throw DesktopError.invalidOutput }
        return .repositories(list.repositories)
    }
    func load() { run("列出可管理的專案。沒有模型呼叫。 / Loading administered repositories. No model call.", operation: repositories) }
    func inspect() {
        let selected = selection
        consent = false
        replace = false
        credential = ""
        run("檢查權限、Actions 與既有 workflow。沒有模型呼叫。 / Checking repository setup. No model call.") { cli, command in
            .status(try await cli.githubStatus(selected, command: command))
        }
    }
    func create(_ status: GithubSetupStatus) {
        guard consent else { return }
        run("建立設定 PR，不會合併。 / Creating a setup PR. It will not be merged.") { cli, command in
            .status(try await cli.githubStatus(status.repository, action: "create-pr", command: command))
        }
    }
    func secret(_ status: GithubSetupStatus) {
        guard consent, !credential.isEmpty, replace else { return }
        let input = Data(credential.utf8)
        credential = ""
        let replaceExisting = replace
        replace = false
        run("只將此 credential 經 stdin 設為選定 repo 的 Actions secret。 / Setting only the selected repository secret through stdin.") { cli, command in
            .status(try await cli.githubStatus(status.repository, action: "set-secret", replace: replaceExisting, input: input, command: command))
        }
    }
    func cancel() { command?.cancel(); credential = ""; code = nil }
}

struct GithubSetupView: View {
    @ObservedObject var model: GithubSetup
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("啟用 GitHub PR 審查 / Enable GitHub PR review").font(.title2)
            Text("使用既有 public action 與 GitHub-hosted runner。需 repo admin、官方 gh CLI 與 OpenAI API 帳戶。 / Requires repository admin, official gh CLI and an OpenAI API account.")
            switch model.state {
            case .start:
                Text("GitHub 官方 gh 登入會要求 repository 與 workflow 授權，由 gh 保存授權與 host protocol；系統 credential store 不可用時，gh 可能使用自有設定檔。登入、建立設定 PR、設定 secret 是獨立操作。此介面不改 branch protection。 / Official gh login requests repository and workflow authorization and stores authorization and host protocol in gh. If the system credential store is unavailable, gh may use its own configuration file. Login, setup PR creation and secret provisioning are separate actions. Branch protection is unchanged.")
            case .busy(let message):
                ProgressView(message)
                if let code = model.code {
                    Text(code).monospaced().textSelection(.enabled)
                    Link("開啟 GitHub 官方登入 / Open GitHub login", destination: URL(string: "https://github.com/login/device")!)
                }
                Button("取消 / Cancel", action: model.cancel)
            case .repositories(let repositories):
                if repositories.isEmpty { Text("沒有可管理的專案。請專案擁有者提供 admin 權限。 / No administered repositories. Ask the owner for admin access.") }
                Picker("專案 / Repository", selection: $model.selection) {
                    Text("請選擇 / Choose").tag("")
                    ForEach(repositories) { Text($0.name).tag($0.name) }
                }
                Button("預覽設定 / Preview setup", action: model.inspect).disabled(model.selection.isEmpty)
            case .status(let status):
                Text(status.repository).bold().textSelection(.enabled)
                Text(status.phase.title)
                Text("管理權限 / Admin: \(status.admin ? "yes" : "no"); Actions: \(status.actions ? "enabled" : "unavailable")")
                if let reason = status.actionsReason { Text(reason).foregroundStyle(status.actions ? Color.primary : Color.orange) }
                Text("Secret metadata: \(status.secret)。AI 認證未知；第一份 review 尚未確認完成。 / AI authentication unknown; first review not confirmed complete.")
                Text(status.disclosure).textSelection(.enabled)
                if let conflict = status.conflict { Text(conflict).foregroundStyle(.orange) }
                DisclosureGroup("即將建立的 workflow / Proposed workflow") { Text(status.workflow).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                if let current = status.currentWorkflow {
                    DisclosureGroup("目前 workflow / Current workflow") { Text(current).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }
                Toggle("我同意此專案傳送程式碼與可能費用。 / I accept code disclosure and possible charges for this repository.", isOn: $model.consent)
                Button("建立或開啟設定 PR / Create or reuse setup PR") { model.create(status) }
                    .disabled(!model.consent || !status.admin || !status.actions || status.phase == .conflict || status.phase == .merged)
                if let url = status.prUrl.flatMap(URL.init(string:)) { Link("在瀏覽器檢查並合併設定 PR / Inspect and merge setup PR", destination: url) }
                SecureField("OpenAI API key，只用於此 repo secret / This repository secret only", text: $model.credential)
                Toggle("我確認為此 repo 建立或覆蓋 NEEDLEFISH_CODEX_API_KEY，已確認其他使用者。 / I explicitly confirm creating or replacing this repository secret, including concurrent changes.", isOn: $model.replace)
                Button("設定此 repo 的 secret / Set this repository secret") { model.secret(status) }
                    .disabled(!model.consent || model.credential.isEmpty || !status.admin || !status.actions || status.secret == "unknown" || !model.replace)
                Button("重新檢查，不呼叫模型 / Refresh without a model call", action: model.inspect)
                Link("Actions 設定 / Actions settings", destination: URL(string: status.settingsUrl)!)
                Link("查看 workflow 執行與第一份結果 / View workflow runs and first result", destination: URL(string: "https://github.com/\(status.repository)/actions/workflows/needlefish.yml")!)
                Text("合併設定後，請在瀏覽器選擇一個受信任的同 repo PR，確認費用後手動重新執行 Needlefish workflow（需既有 run），或更新測試 PR 觸發首次執行。Fork、bot 或不受信任來源尚未審查。沒有終局 Needlefish check 就不算完成。額度、認證或投稿失敗請開啟 run log 修正後重試；不會自動換付費帳戶。 / After merging setup, choose a trusted same-repository PR in your browser. With separate cost consent, rerun its existing workflow or update a test PR to trigger the first run. Fork/bot/untrusted PRs are not reviewed. A missing terminal Needlefish check is incomplete. Inspect run logs for quota, authentication or posting failure; no automatic paid fallback.")
                DisclosureGroup("停用、移除與要求通過 / Disable, remove and require passing review") {
                    Text(status.removal)
                    Text("在 Repository Settings 的 Rules / Branch protection 檢查支援與權限，先完成一次真實 review，再由管理員選擇要求 Needlefish 通過。保留所有其他 required checks。此介面不自動套用。 / After a real review, an administrator can require Needlefish under repository Rules / Branch protection. Preserve all existing required checks. This screen does not apply that change.")
                }
            case .error(let message): Text(message).foregroundStyle(.orange)
            }
            HStack {
                Button("GitHub 官方登入 / Sign in to GitHub", action: model.login).disabled(model.busy)
                Button("列出可管理專案 / List repositories", action: model.load).disabled(model.busy)
                Link("官方 gh 安裝說明 / Official gh installation", destination: URL(string: "https://cli.github.com/")!)
                Link("OpenAI API 額度 / API billing", destination: URL(string: "https://platform.openai.com/settings/organization/billing/overview")!)
            }
        }
    }
}

func githubDeviceCode(_ output: String) -> String? {
    guard output.contains("one-time code"), let range = output.range(of: "[A-Z0-9]{4}-[A-Z0-9]{4}", options: .regularExpression) else { return nil }
    return String(output[range])
}
