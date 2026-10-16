import Foundation

struct Runtime: Codable, Sendable {
    let node: String
    let cli: String
    let codex: String
    let git: String
    let development: Bool

    func command(_ args: [String]) -> [String] { [node, cli] + args }

    static func bundled() throws -> Runtime {
        guard let resources = Bundle.main.resourceURL else { throw DesktopError.runtime }
        let data = try Data(contentsOf: resources.appendingPathComponent("runtime.json"))
        let runtime = try JSONDecoder().decode(Runtime.self, from: data)
        func resolve(_ value: String) -> String {
            runtime.development ? value : resources.appendingPathComponent("runtime/" + value).path
        }
        let resolved = Runtime(node: resolve(runtime.node), cli: resolve(runtime.cli),
                               codex: resolve(runtime.codex), git: resolve(runtime.git), development: runtime.development)
        for executable in [resolved.node, resolved.codex, resolved.git] {
            guard FileManager.default.isExecutableFile(atPath: executable) else { throw DesktopError.runtime }
        }
        guard FileManager.default.fileExists(atPath: resolved.cli) else { throw DesktopError.runtime }
        return resolved
    }

    func environment(temporary: URL) -> [String: String] {
        ["HOME": FileManager.default.homeDirectoryForCurrentUser.path,
         "PATH": URL(fileURLWithPath: git).deletingLastPathComponent().path + ":" +
            URL(fileURLWithPath: node).deletingLastPathComponent().path + ":/usr/bin:/bin",
         "TMPDIR": temporary.path, "CODEX_BIN": codex,
         "CODEX_REASONING_EFFORT": "medium", "NO_COLOR": "1", "TERM": "dumb"]
    }
}

enum DesktopError: Error, LocalizedError {
    case runtime, invalidOutput, cancelled, timeout, outputLimit, command, quota, network, auth, installationBusy
    var errorDescription: String? {
        switch self {
        case .installationBusy: "另一個 Needlefish 正在安裝或移除。請稍後重試。 / Another Needlefish is installing or removing a version. Retry shortly."
        case .quota: "帳戶額度不足或請求過多。請在 OpenAI 帳戶確認額度，稍後再試。不會自動改用其他帳戶。 / Quota or rate limit. Check your OpenAI account and retry later."
        case .network: "網路連線失敗。請確認網路與代理設定，再重試。 / Connection failed. Check network and proxy settings."
        case .auth: "登入失效。請重新診斷並登入 OpenAI。 / Sign-in rejected. Check again and sign in."
        case .runtime: "安裝包不完整。此開發版本需要已驗證的 runtime。請取得正式安裝包。 / Runtime unavailable."
        case .invalidOutput: "無法讀取檢查結果。未完成，請重新檢查。 / Invalid output. Review incomplete."
        case .cancelled: "已取消。本次工作已停止。 / Cancelled."
        case .timeout: "等待逾時。請確認網路後重試。 / Timed out. Check your connection and retry."
        case .outputLimit: "輸出超過安全上限。未完成，請縮小變更後重試。 / Output limit exceeded."
        case .command: "未完成。請重新診斷環境，確認登入、網路與帳戶額度後重試。 / Incomplete. Check login, connection and quota."
        }
    }
}

struct Doctor: Decodable, Sendable {
    struct Check: Decodable, Identifiable, Sendable {
        enum Status: String, Decodable, Sendable { case ok, fail, unknown }
        let name: String
        let status: Status
        let detail: String
        var id: String { name }
        var explanation: String {
            switch (name, status) {
            case ("auth", .ok): "已登入。 / Signed in."
            case ("auth", _): "需要登入，或目前無法確認登入。請使用 OpenAI 登入。 / Sign in with OpenAI."
            case ("git", .ok): "已找到 Git 專案。 / Git project found."
            case ("git", _): "無法讀取 Git 專案。請選擇正確資料夾。不會自動初始化或修改專案。 / Choose a Git project."
            case ("runner", .ok): "已找到 Codex。版本與能力仍需正式發行驗證。 / Codex found. Release qualification required."
            case ("runner", _): "Codex 不可用。請重新安裝正式 Needlefish 安裝包。 / Reinstall the supported package."
            case ("node", .ok): "執行環境可用。 / Runtime available."
            case ("node", _): "執行環境不相容。請重新安裝正式安裝包。 / Reinstall the supported package."
            case ("base", _): "此介面只檢查未提交變更，不需要分支基準。 / This view reviews uncommitted changes only; no branch base is required."
            default: "無法確認檢查範圍。請先選擇有本機變更的 Git 專案。 / Review scope unavailable."
            }
        }
    }
    let schemaVersion: Int
    let repoRoot: String?
    let checks: [Check]
    func validated() throws -> Doctor {
        guard schemaVersion == 1, checks.count == 5,
              Set(checks.map(\.name)) == Set(["node", "runner", "auth", "git", "base"]) else {
            throw DesktopError.invalidOutput
        }
        if repoAvailable {
            guard let repoRoot, repoRoot.hasPrefix("/"), !repoRoot.contains("\0"),
                  !repoRoot.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
                throw DesktopError.invalidOutput
            }
        }
        return self
    }
    var ready: Bool { checks.filter { $0.name != "base" }.allSatisfy { $0.status == .ok } }
    var repoAvailable: Bool { checks.contains { $0.name == "git" && $0.status == .ok } }
}

struct Scope: Decodable, Sendable {
    struct File: Decodable, Sendable { let path: String }
    let mode: String
    let changedFiles: [File]
    let patchBytes: Int
    let untrackedSkipped: [Skipped]
    struct Skipped: Decodable, Sendable { let path: String }
}

struct Result: Decodable, Sendable {
    enum Verdict: String, Decodable, Sendable {
        case pass, changesRequested = "changes_requested", needsHuman = "needs_human"
        var title: String {
            switch self {
            case .pass: "沒有阻擋問題 / No blocking issues"
            case .changesRequested: "找到問題 / Issues found"
            case .needsHuman: "未完成，需要人工確認 / Human review needed"
            }
        }
    }
    struct Finding: Decodable, Sendable {
        let severity: String
        let title: String
        let file: String
        let lineStart: Int
        let whyItBreaks: String
        let suggestedFix: String
    }
    struct Risk: Decodable, Sendable { let text: String; let blocks: Bool }
    let schemaVersion: Int
    let verdict: Verdict
    let summary: String
    let findings: [Finding]
    let residualRisks: [Risk]
    let coverage: String?
    func validated() throws -> Result {
        guard schemaVersion == 1, !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              findings.allSatisfy({ ["P0", "P1", "P2", "P3"].contains($0.severity) && $0.lineStart > 0 && !$0.title.isEmpty }) else {
            throw DesktopError.invalidOutput
        }
        if verdict == .pass && (findings.contains { ["P0", "P1", "P2"].contains($0.severity) } || residualRisks.contains { $0.blocks }) {
            throw DesktopError.invalidOutput
        }
        return self
    }
    static let demo = Result(schemaVersion: 1, verdict: .changesRequested,
        summary: "離線範例。沒有讀取你的專案，也沒有呼叫 AI。 / Offline example. Your project was not reviewed.",
        findings: [Finding(severity: "P2", title: "範例：空清單會造成錯誤 / Example: empty list fails",
            file: "example.ts", lineStart: 8, whyItBreaks: "讀取不存在的第一個項目。 / Reads a missing first item.",
            suggestedFix: "先處理空清單，再讀取項目。 / Handle an empty list before reading an item.")],
        residualRisks: [], coverage: nil)
}

func deviceCode(_ output: String) -> String? {
    let plain = output.replacingOccurrences(of: "\u{001B}\\[[0-9;]*m", with: "", options: .regularExpression)
    guard plain.contains("https://auth.openai.com/codex/device"),
          let marker = plain.range(of: "Enter this one-time code") else { return nil }
    let lines = plain[marker.upperBound...].split(separator: "\n")
    return lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { $0.range(of: "^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$", options: .regularExpression) != nil }
}
