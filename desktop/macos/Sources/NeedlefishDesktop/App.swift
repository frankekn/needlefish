import AppKit
import SwiftUI

@MainActor
final class Onboarding: ObservableObject {
    enum State {
        case welcome, busy(String), diagnosis(Doctor), consent(Scope), result(Result, demo: Bool), message(String)
    }
    @Published var state: State = .welcome
    @Published var repo: URL?
    @Published var code: String?
    @Published var trusted = false
    @Published var accepted = false
    private(set) var runtime: Runtime?
    @Published private(set) var diagnosis: Doctor?
    @Published var consentUsesConnections = false
    let connections = AdvancedConnections()
    var canReview: Bool { trusted && accepted && (consentUsesConnections ? connections.ready && diagnosis?.repositoryScopeReady == true && !knownMissingAmbientCodexAuth : diagnosis?.ready == true) }
    var knownMissingAmbientCodexAuth: Bool {
        guard consentUsesConnections, connections.credentialMode == "existing",
              diagnosis?.checks.first(where: { $0.name == "auth" })?.status == .fail else { return false }
        return connections.selection.contains { id in
            connections.document.connections.contains { $0.id == id && $0.adapter == "codex" && $0.auth == nil }
        }
    }
    lazy var githubSetup = GithubSetup(runtime: runtime)
    private var operation: Command?
    private var task: Task<Void, Never>?
    var canCancel: Bool { operation != nil || githubSetup.busy }
    var localBusy: Bool { if case .busy = state { true } else { false } }
    var busy: Bool { localBusy || githubSetup.busy }

    init(runtime: Runtime? = try? Runtime.bundled()) { self.runtime = runtime }

    func manageInstallation(rollback: Bool = false) {
        guard !busy else { return }
        guard let team = Bundle.main.object(forInfoDictionaryKey: "NeedlefishTeamIdentifier") as? String,
              runtime?.development == false else {
            state = .message("開發預覽不能安裝或回復正式版本。 / Installation and rollback require a signed release.")
            return
        }
        let source: URL?
        if rollback {
            source = nil
        } else {
            let panel = NSOpenPanel()
            panel.message = "選擇官方安裝包中的 Needlefish.app。會驗證簽章，再保留上一版。 / Choose the official app. Signature is verified and the previous version is retained."
            panel.canChooseDirectories = false
            panel.treatsFilePackagesAsDirectories = false
            guard panel.runModal() == .OK, let selected = panel.url else { return }
            let alert = NSAlert()
            alert.messageText = "安裝此版本？ / Install this version?"
            alert.informativeText = "將複製至 Needlefish 自有目錄並開啟。保留目前帳戶，不下載其他元件。 / Copies to Needlefish storage and opens it. Keeps the current account. No additional downloads."
            alert.addButton(withTitle: "安裝 / Install")
            alert.addButton(withTitle: "取消 / Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            source = selected
        }
        startInstallation(source: source, verify: { try InstallationStore.verify($0, team: team) }) { url in
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.createsNewApplicationInstance = true
                configuration.allowsRunningApplicationSubstitution = false
                NSWorkspace.shared.openApplication(at: url, configuration: configuration) { application, error in
                    if let error { continuation.resume(throwing: error) }
                    else if application != nil { continuation.resume() }
                    else { continuation.resume(throwing: DesktopError.command) }
                }
            }
        }
    }

    func startInstallation(source: URL?, store: InstallationStore = InstallationStore(),
                           verify: @escaping (URL) throws -> Void, launch: @escaping (URL) async throws -> Void) {
        guard !busy else { return }
        state = .busy("正在驗證與開啟安裝版本。 / Verifying and opening the installed version.")
        task = Task {
            do {
                if let source {
                    _ = try await store.install(source, verify: verify, launch: launch)
                } else {
                    _ = try await store.rollback(verify: verify, launch: launch)
                }
                state = .message("已開啟安裝版本。 / Installed version opened.")
            } catch DesktopError.installationBusy {
                state = .message(DesktopError.installationBusy.localizedDescription)
            } catch {
                state = .message("安裝或回復失敗。上一個可用版本仍保留。請取得官方簽章安裝包。失敗副本僅盡力清理；若仍存在，請在 Application Support 的 Desktop 資料夾確認後移至垃圾桶。 / Install or rollback failed. The last usable version is retained. Get the official signed package. Failed-copy cleanup is best effort; inspect the Desktop folder in Application Support and move the failed copy to Trash if it remains.")
            }
            task = nil
        }
    }

    func uninstall() {
        guard !busy else { return }
        let alert = NSAlert()
        alert.messageText = "移除 Needlefish 自有安裝資料？ / Remove Needlefish managed installations?"
        alert.informativeText = "移除由此介面安裝的版本與安裝紀錄。保留 Git、OpenAI 登入資料、CLI review cache 與專案。下載的 App 可移至垃圾桶。 / Removes managed app versions and receipt. Preserves Git, OpenAI login, CLI review cache and projects. Move downloaded apps to Trash separately."
        alert.addButton(withTitle: "移除 / Remove")
        alert.addButton(withTitle: "取消 / Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try InstallationStore().uninstall()
            state = .message("已移除 Needlefish 自有安裝資料。 / Managed installations removed.")
        } catch DesktopError.installationBusy {
            state = .message(DesktopError.installationBusy.localizedDescription)
        } catch { state = .message("無法移除安裝資料。未修改 Git 或登入設定。 / Could not remove installation data.") }
    }

    func selectFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "選擇你信任且擁有的專案。只檢查此資料夾的本機變更。 / Choose one trusted project."
        if panel.runModal() == .OK, let url = panel.url {
            repo = url
            diagnose()
        }
    }

    private func start(_ label: String, usesConnections: Bool = false, work: @escaping @MainActor (DesktopCLI, Command) async throws -> State) {
        guard !busy else { return }
        guard let runtime else { state = .message(DesktopError.runtime.localizedDescription); return }
        let command = Command()
        operation = command
        state = .busy(label)
        code = nil
        task = Task {
            do { state = try await work(DesktopCLI(runtime: runtime), command) }
            catch {
                if usesConnections {
                    self.connections.failed(error)
                    state = .message(self.connections.message ?? DesktopError.command.localizedDescription)
                } else {
                    state = .message((error as? ConnectionsFailure)?.localizedDescription ?? (error as? DesktopError)?.localizedDescription ?? DesktopError.command.localizedDescription)
                }
            }
            operation = nil
            code = nil
            task = nil
        }
    }

    func diagnose() {
        guard let repo else { return }
        connections.reset()
        consentUsesConnections = false
        trusted = false
        accepted = false
        diagnosis = nil
        start("正在診斷。沒有模型呼叫。 / Checking environment. No model call.") { cli, command in
            let report = try await cli.doctor(repo: repo, command: command)
            self.diagnosis = report
            if report.repoAvailable, let root = report.repoRoot { self.repo = URL(fileURLWithPath: root) }
            return .diagnosis(report)
        }
    }

    func prepare() {
        guard let repo else { return }
        consentUsesConnections = false
        trusted = false
        accepted = false
        start("正在讀取變更範圍。沒有模型呼叫。 / Reading change scope. No model call.") { cli, command in
            let scope = try await cli.scope(repo: repo, command: command)
            if scope.changedFiles.isEmpty {
                return .message("沒有可檢查的變更。這不代表整個專案已驗證安全。 / No changes to review. Your project has not been verified safe.")
            }
            return .consent(scope)
        }
    }

    func login() {
        start("等待 OpenAI 登入。可以取消。 / Waiting for OpenAI sign-in. You can cancel.") { cli, command in
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("needlefish-desktop-login-" + UUID().uuidString)
            let output = try await command.run([cli.runtime.codex, "login", "--device-auth"],
                environment: cli.runtime.environment(temporary: temporary), temporary: temporary, timeout: 16 * 60, progress: { code in
                    await MainActor.run { self.code = code }
                })
            guard output.status == 0 else {
                return .message("登入未完成。請確認網路與帳戶是否允許 Codex 裝置登入，再重試。 / Sign-in incomplete. Check connection and device login availability.")
            }
            guard let repo = self.repo else { return .welcome }
            let report = try await cli.doctor(repo: repo, command: command)
            self.diagnosis = report
            if report.repoAvailable, let root = report.repoRoot { self.repo = URL(fileURLWithPath: root) }
            return .diagnosis(report)
        }
    }

    func invalidateConnectionConsent() {
        connections.invalidate()
        if consentUsesConnections {
            trusted = false; accepted = false
            if case .consent = state { state = .message("連線、順序或預算已改變。請重新檢查範圍。 / Selection changed. Inspect scope again.") }
        }
    }

    func connectionOperation(_ operation: String) {
        guard !busy, let repo else { return }
        invalidateConnectionConsent()
        start("正在處理連線設定，沒有模型呼叫。 / Managing connections. No model call.", usesConnections: true) { cli, command in
            let input = operation == "edit" ? nil : try self.connections.request(operation)
            let response = try await cli.connections(operation, repo: repo, command: command, input: input)
            if operation == "edit" { try self.connections.load(response) }
            else { try self.connections.saved(response) }
            return .message("連線設定已載入或保存。 / Connections loaded or saved.")
        }
    }

    func prepareConnections() {
        guard !busy, let repo, !connections.dirty, connections.validSelection,
              connections.budgetMs != nil, connections.draftState == .editing else { return }
        trusted = false; accepted = false; consentUsesConnections = true
        start("正在檢查連線與本機範圍，沒有模型呼叫。 / Inspecting connections and scope. No model call.", usesConnections: true) { cli, command in
            let report = try await cli.doctor(repo: repo, command: command)
            self.diagnosis = report
            guard report.repositoryScopeReady else { throw DesktopError.scopeCollection }
            let response = try await cli.connections("inspect", repo: repo, command: command, input: self.connections.request("inspect"))
            try self.connections.inspected(response)
            let unavailable = (self.connections.inspection ?? []).filter { $0.readiness != "local-available" }
            if !unavailable.isEmpty {
                let rows = unavailable.map { $0.id + " (" + $0.adapter + "): " + $0.readiness }.joined(separator: "; ")
                let message = "連線尚不能在本機執行。請確認執行檔可用且支援讀取專案，再重新檢查。 / Connections are not locally ready. Check executable availability and repository-read capability, then inspect again. " + rows
                self.connections.message = message
                return .message(message)
            }
            let scope = try await cli.scope(repo: repo, command: command)
            guard !scope.changedFiles.isEmpty else { return .message("沒有可檢查的變更。 / No changes to review.") }
            return .consent(scope)
        }
    }

    func review() {
        guard let repo, canReview, case .consent = state else { return }
        guard runtime != nil else { connections.clearSecrets(); state = .message(DesktopError.runtime.localizedDescription); return }
        start("正在檢查本機變更副本。可能產生費用。 / Reviewing a copy of local changes. Charges may apply.", usesConnections: consentUsesConnections) { cli, command in
            if self.consentUsesConnections {
                guard let revision = self.connections.baseRevision, let budget = self.connections.budgetMs else { throw DesktopError.invalidOutput }
                defer { self.connections.clearSecrets() }
                let result = try await cli.connectionReview(repo: repo, revision: revision, ids: self.connections.selection,
                    budgetMs: budget, mode: self.connections.credentialMode, sources: self.connections.secrets, command: command,
                    inputSent: { await MainActor.run { self.connections.clearSecrets() } })
                return .result(result, demo: false)
            }
            return .result(try await cli.review(repo: repo, command: command), demo: false)
        }
    }

    func cancel() {
        connections.clearSecrets()
        if githubSetup.busy { githubSetup.cancel(); return }
        guard operation != nil, busy else { return }
        operation?.cancel()
        code = nil
        state = .busy("正在取消並清理本次暫存。 / Cancelling and cleaning temporary files.")
    }
    func demo() { guard !localBusy else { return }; state = .result(.demo, demo: true) }
    func exportDiagnostics() {
        let content = "Needlefish desktop diagnostic preview\nplatform=macOS arm64\nruntime=\(runtime == nil ? "unavailable" : "available")\nproject=\(repo == nil ? "not selected" : "selected; path omitted")\nNo code, prompts, account data or raw CLI output included.\n"
        let alert = NSAlert()
        alert.messageText = "診斷預覽 / Diagnostic preview"
        alert.informativeText = content
        alert.addButton(withTitle: "匯出 / Export")
        alert.addButton(withTitle: "取消 / Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "needlefish-diagnostics.txt"
        if panel.runModal() == .OK, let url = panel.url { saveDiagnostics(content, to: url) }
    }

    func saveDiagnostics(_ content: String, to url: URL) {
        guard !localBusy else { return }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
            state = .message("已匯出診斷。 / Diagnostics exported.")
        } catch {
            state = .message("無法儲存診斷。請選擇可寫入的位置並重試。 / Could not save diagnostics. Choose a writable location and retry.")
        }
    }
}

struct ContentView: View {
    @ObservedObject var model: Onboarding
    @ObservedObject private var githubSetup: GithubSetup
    @ObservedObject private var connections: AdvancedConnections
    init(model: Onboarding) { self.model = model; githubSetup = model.githubSetup; connections = model.connections }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Needlefish").font(.largeTitle).bold()
            if Bundle.main.object(forInfoDictionaryKey: "NeedlefishOfflineUITest") as? Bool == true {
                Text("OFFLINE UI TEST. No provider or credentials.").font(.headline).foregroundStyle(.orange)
            }
            Text("檢查一個專案的本機變更 / Review local changes in one project").font(.headline)
            if model.runtime?.development == true {
                Text("開發預覽。未通過乾淨機器與正式發行驗收。 / Development preview. Not a qualified release.")
                    .foregroundStyle(.orange)
            }
            if let repo = model.repo { Text("專案 / Project: " + repo.lastPathComponent).textSelection(.enabled) }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) { stateView }.frame(maxWidth: .infinity, alignment: .leading)
            }
            DisclosureGroup("進階連線 / Advanced connections") {
                ScrollView { AdvancedConnectionsView(owner: model, model: model.connections) }.frame(maxHeight: 380)
            }.disabled(model.githubSetup.busy)
            DisclosureGroup("GitHub 引導設定 / Guided GitHub setup") {
                ScrollView { GithubSetupView(model: githubSetup) }.frame(maxHeight: 460)
            }.disabled(model.localBusy)
            DisclosureGroup("安裝與移除 / Install and remove") {
                HStack {
                    Button("安裝正式版本 / Install release") { model.manageInstallation() }
                    Button("回復上一版 / Restore previous") { model.manageInstallation(rollback: true) }
                    Button("移除安裝資料 / Remove installations", action: model.uninstall)
                }.disabled(model.busy)
            }
            HStack {
                Button("選擇資料夾 / Choose folder", action: model.selectFolder).disabled(model.busy)
                Button("離線範例 / Offline example", action: model.demo).disabled(model.localBusy)
                Spacer()
                Button("預覽診斷 / Preview diagnostics", action: model.exportDiagnostics).disabled(model.localBusy)
            }
        }
        .padding(24)
        .frame(minWidth: 760, minHeight: 600)
    }

    @ViewBuilder private var stateView: some View {
        switch model.state {
        case .welcome:
            Text("選擇你信任且擁有的 Git 專案。環境診斷不傳送程式碼、不呼叫模型。 / Choose your own trusted Git project. Diagnostics do not send code or call a model.")
            Text("沒有帳戶也可查看明確標示的離線範例。 / You can view the labelled offline example without an account.")
        case .busy(let label):
            ProgressView().accessibilityLabel(label)
            Text(label)
            if let code = model.code {
                Text("只在你主動開始登入時輸入此碼。 / Enter this code only if you started this login.")
                Text(code).font(.title).monospaced().textSelection(.enabled)
                Link("開啟 OpenAI 登入 / Open OpenAI sign-in", destination: URL(string: "https://auth.openai.com/codex/device")!)
            }
            if model.canCancel { Button("取消 / Cancel", action: model.cancel) }
        case .diagnosis(let report):
            Text("環境診斷 / Environment checks").font(.title2)
            if report.repoAvailable, let root = report.repoRoot {
                Text("實際 Git 專案 / Actual Git project: " + root).textSelection(.enabled)
                Text("包含此 Git 專案根目錄下的本機變更。 / Includes local changes under this Git project root.")
            }
            ForEach(report.checks) { check in
                Text(check.explanation).foregroundStyle(check.status == .ok ? Color.primary : Color.orange)
            }
            Text("診斷不確認帳戶額度、網路模型可達性或 runner 能力資格。 / Diagnostics do not verify quota, model connectivity or runner qualification.")
                .font(.caption)
            HStack {
                Button("重新診斷 / Check again", action: model.diagnose)
                Button("登入 OpenAI / Sign in", action: model.login)
                Button("查看檢查範圍 / Review scope", action: model.prepare).disabled(!report.scopeReady)
            }
        case .consent(let scope):
            Text("開始前確認 / Before you start").font(.title2)
            Text("將檢查 \(scope.changedFiles.count) 個有本機變更的檔案。按開始時建立副本，包含已暫存、未暫存與可收錄的新檔案。期間請停止編輯。 / Reviews a copy of local staged, unstaged and eligible new files at start. Stop editing during capture.")
            if model.consentUsesConnections {
                Text("程式碼與規則會依下列順序交給所選連線。完整結果會結束備援。認證未知、資格未驗證、費用未知。 / Code and rules go to the selected routes in this order. A complete result ends fallback. Authentication unknown, unqualified, cost unknown.")
                ForEach(model.connections.inspection ?? []) { row in Text(row.summary + " · " + row.readiness) }
                Text("模型審查總預算 / Model budget: " + model.connections.budget + " ms. Collection and cleanup are outside this budget.")
            } else {
                Text("程式碼與專案規則會交給 OpenAI Codex，使用 gpt-5.6-sol，medium effort。費用未知，依目前登入帳戶計費。 / Code and project rules go to OpenAI Codex, gpt-5.6-sol, medium effort. Cost unknown, billed to the signed-in account.")
            }
            Text("這是拋棄式副本與事後完整性檢查，不是 OS 隔離。只用於你信任的自有專案。 / Uses a disposable copy and integrity checks, not OS isolation. Only review your own trusted projects.")
            if !scope.untrackedSkipped.isEmpty {
                Text("有 \(scope.untrackedSkipped.count) 個新檔案未收錄。 / Some new files are excluded.").foregroundStyle(.orange)
            }
            DisclosureGroup("檔案 / Files") {
                ForEach(Array(scope.changedFiles.enumerated()), id: \.offset) { _, file in Text(file.path).textSelection(.enabled) }
            }
            Toggle("我信任並擁有此專案。 / I own and trust this project.", isOn: $model.trusted)
            Toggle("我同意傳送程式碼，並接受未知費用。 / I consent to sending code and unknown charges.", isOn: $model.accepted)
            if model.knownMissingAmbientCodexAuth {
                Text("選定的 Codex 既有登入不可用。請登入後重新檢查範圍。 / The selected ambient Codex sign-in is unavailable. Sign in, then inspect scope again.")
                Button("登入 Codex / Sign in to Codex", action: model.login)
            }
            if !model.consentUsesConnections && model.diagnosis?.ready != true {
                Text("開始檢查前請先登入。 / Sign in before starting a review.")
                Button("登入 OpenAI / Sign in", action: model.login)
            }
            Button("開始檢查 / Start review", action: model.review).disabled(!model.canReview)
        case .result(let result, let demo):
            if demo { Text("離線範例。不是你的專案結果。 / OFFLINE EXAMPLE. Not your project result.").font(.title2).foregroundStyle(.orange) }
            Text(result.verdict.title).font(.title2).bold()
            Text(result.summary).textSelection(.enabled)
            Text("檢查僅涵蓋本次變更，不保證專案安全。 / Covers this change only. Does not guarantee project safety.")
            ForEach(Array(result.findings.enumerated()), id: \.offset) { _, finding in
                GroupBox {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(finding.severity) \(finding.title)").bold()
                        Text("\(finding.file):\(finding.lineStart)").monospaced()
                        Text(finding.whyItBreaks)
                        Text("下一步 / Next step").bold()
                        Text(finding.suggestedFix)
                    }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }
            }
            ForEach(Array(result.residualRisks.enumerated()), id: \.offset) { _, risk in
                Text("需要確認 / Check: " + risk.text).foregroundStyle(risk.blocks ? Color.orange : Color.primary)
            }
            if let coverage = result.coverage { Text(coverage).font(.caption) }
            Text(result.verdict == .pass ? "下一步：人工確認後再提交變更。 / Next: inspect the change before committing." : "下一步：依建議確認或修改，再重新檢查。 / Next: inspect or fix the issues, then review again.")
            if model.repo != nil { Button("重新診斷 / Check again", action: model.diagnose) }
        case .message(let text):
            Text(text).font(.title3)
            if model.repo != nil { Button("重新診斷 / Check again", action: model.diagnose) }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model: Onboarding
    override init() { model = Onboarding(); super.init() }
    init(model: Onboarding) { self.model = model; super.init() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if model.canCancel {
            model.cancel()
            Task {
                while model.canCancel { try? await Task.sleep(for: .milliseconds(100)) }
                sender.reply(toApplicationShouldTerminate: true)
            }
            return .terminateLater
        }
        return .terminateNow
    }
}

@main
struct NeedlefishApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup { ContentView(model: delegate.model) }
            .windowResizability(.contentMinSize)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
}
