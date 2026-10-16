import Foundation
import SwiftUI

struct RawConnection: Codable, Identifiable, Equatable, Sendable {
    struct Launch: Codable, Equatable, Sendable { var command: String; var args: [String] }
    struct Route: Codable, Equatable, Sendable { var kind: String; var baseUrl: String? }
    struct Auth: Codable, Equatable, Sendable { var env: [String: String]; var route: Route? }
    var id: String
    var adapter: String
    var model: String?
    var launch: Launch?
    var auth: Auth?
}
struct ConnectionsDocument: Codable, Equatable, Sendable {
    var version = 1
    var connections: [RawConnection] = []
}
struct ConnectionDescriptor: Decodable, Identifiable, Sendable {
    let id: String
    let adapter: String
    let requestedModel: String?
    let route: String
    let credentialSource: String
    let providerAccount: String
    let authentication: String
    let readiness: String
    let qualification: String
    var summary: String {
        "\(id) · \(adapter) · \(requestedModel ?? "agent default") · \(route) · auth unknown · unqualified · cost unknown"
    }
    func validated() throws -> Self {
        guard providerAccount == "unknown", authentication == "unknown", qualification == "unqualified",
              ["unknown", "local-available", "local-blocked"].contains(readiness),
              ["openai", "cliproxyapi", "ambient", "opaque"].contains(route) else { throw DesktopError.invalidOutput }
        return self
    }
}
struct ConnectionIssue: Decodable, Sendable { let field: String; let code: String }
struct ConnectionsResponse: Decodable, Sendable {
    let schemaVersion: Int
    let ok: Bool
    let code: String?
    let issues: [ConnectionIssue]?
    let revision: String?
    let baseRevision: String?
    let document: ConnectionsDocument?
    let connections: [ConnectionDescriptor]?
    func validated(status: Int32) throws -> Self {
        guard schemaVersion == 1 else { throw DesktopError.invalidOutput }
        guard ok else { throw ConnectionsFailure(code: code ?? "invalid_output", issues: issues ?? []) }
        guard status == 0 else { throw DesktopError.invalidOutput }
        for descriptor in connections ?? [] { _ = try descriptor.validated() }
        return self
    }
}
struct ConnectionsFailure: Error, LocalizedError {
    let code: String
    var issues: [ConnectionIssue] = []
    var errorDescription: String? {
        switch code {
        case "revision_conflict": "設定已由別處更改。草稿保留。重新載入後，明確選擇重套草稿。 / Configuration changed. Draft retained. Reload before explicitly reapplying."
        case "configuration_unavailable": "無法開啟設定。請先由安裝管理者建立由你擁有的安全設定目錄，再重新載入。 / Configuration unavailable. Ask the installer to prepare a safe user-owned configuration directory, then reload."
        case "save_state_unknown": "保存狀態未知。草稿保留。請重新載入確認，不能直接重試保存。 / Save state unknown. Reload to inspect before retrying."
        case "config_busy": "另一個操作正在保存設定。請稍後重新載入。 / Configuration busy. Reload shortly."
        case "invalid_configuration":
            if issues.contains(where: { $0.field == "id" && $0.code == "duplicate_id" }) {
                "連線名稱重複。請為每條連線使用不同名稱。草稿未保存。 / Duplicate profile ID. Use distinct names. Draft not saved."
            } else {
                "連線設定不合法。請確認名稱、模型、目的地、來源名稱與 ACP 參數。草稿未保存。 / Invalid profile. Check ID, model, destination, source names and ACP arguments. Draft not saved."
            }
        default: "連線操作未完成。請檢查欄位與本機設定後重試。未顯示原始輸出。 / Connection operation incomplete. Check fields and local configuration."
        }
    }
}

extension DesktopCLI {
    func connections(_ operation: String, repo: URL, command: Command, input: Data? = nil) async throws -> ConnectionsResponse {
        let output = try await call(["connections", operation, "--json", "--repo", repo.path], command: command, input: input)
        do { return try JSONDecoder().decode(ConnectionsResponse.self, from: output.stdout).validated(status: output.status) }
        catch let error as ConnectionsFailure { throw error }
        catch { throw DesktopError.invalidOutput }
    }
    func connectionReview(repo: URL, revision: String, ids: [String], budgetMs: Int,
                          mode: String, sources: [String: String], command: Command,
                          inputSent: @escaping @Sendable () async -> Void = {}) async throws -> Result {
        struct Request: Encodable {
            let repo: String
            let scope = "local-uncommitted"
            let expectedRevision: String
            let ids: [String]
            let budgetMs: Int
            let credentialMode: String
            let sources: [String: String]
        }
        var input = try JSONEncoder().encode(Request(repo: repo.path, expectedRevision: revision, ids: ids,
                                                   budgetMs: budgetMs, credentialMode: mode, sources: sources))
        defer { input.resetBytes(in: 0..<input.count) }
        // The CLI budget covers models. Collection and finalizers have an additional finite watchdog allowance.
        let output = try await call(["connections", "review", "--json"], command: command,
                                    timeout: Double(budgetMs) / 1000 + 10 * 60, input: input, inputSent: inputSent)
        let text = String(decoding: output.stdout + output.stderr, as: UTF8.self)
        for value in sources.values where !value.isEmpty {
            let json = String(decoding: try JSONEncoder().encode(value), as: UTF8.self).dropFirst().dropLast()
            let percent = value.utf8.map { String(format: "%%%02X", $0) }.joined()
            guard !text.contains(value), !text.contains(json), !text.lowercased().contains(percent.lowercased()) else {
                throw DesktopError.invalidOutput
            }
        }
        guard output.status == 0 else { throw DesktopError.command }
        do { return try JSONDecoder().decode(Result.self, from: output.stdout).validated() }
        catch { throw DesktopError.invalidOutput }
    }
}

@MainActor
final class AdvancedConnections: ObservableObject {
    enum DraftState: Equatable { case unloaded, editing, conflict, reloadRequired }
    @Published private(set) var draftState: DraftState = .unloaded
    @Published private(set) var document = ConnectionsDocument()
    @Published private(set) var baseRevision: String?
    @Published private(set) var catalog: [ConnectionDescriptor] = []
    @Published private(set) var selection: [String] = []
    @Published private(set) var inspection: [ConnectionDescriptor]?
    @Published private(set) var inspectionRevision: String?
    @Published var budget = ""
    @Published var credentialMode = "existing"
    @Published var secrets: [String: String] = [:]
    @Published var message: String?
    private var retainedDraft: ConnectionsDocument?
    var dirty: Bool { document != savedDocument }
    private var savedDocument = ConnectionsDocument()
    var budgetMs: Int? { guard let value = Int(budget), (1...2147483647).contains(value) else { return nil }; return value }
    var validSelection: Bool { !selection.isEmpty && Set(selection).count == selection.count && selection.allSatisfy { id in document.connections.contains { $0.id == id } } }
    var sourceRefs: [String] { Array(Set(selection.flatMap { id in document.connections.first { $0.id == id }?.auth?.env.values.map { $0 } ?? [] })).sorted() }
    var sessionAllowed: Bool { validSelection && selection.allSatisfy { id in !(document.connections.first { $0.id == id }?.auth?.env.isEmpty ?? true) } }
    var ready: Bool { draftState == .editing && !dirty && validSelection && budgetMs != nil && inspectionRevision == baseRevision && inspection?.count == selection.count && inspection?.allSatisfy { $0.readiness == "local-available" } == true && (credentialMode == "existing" && sourceRefs.isEmpty || credentialMode == "session" && sessionAllowed && sourceRefs.allSatisfy { !(secrets[$0] ?? "").isEmpty }) }
    func invalidate() { inspection = nil; inspectionRevision = nil }
    func clearSecrets() { secrets.removeAll() }
    func reset() {
        document = ConnectionsDocument(); savedDocument = document; baseRevision = nil; catalog = []
        selection = []; draftState = .unloaded; retainedDraft = nil; message = nil; invalidate(); clearSecrets()
    }
    func load(_ response: ConnectionsResponse) throws {
        guard let document = response.document, let revision = response.baseRevision, document.version == 1 else { throw DesktopError.invalidOutput }
        self.document = document; savedDocument = document; baseRevision = revision; draftState = .editing
        selection = selection.filter { id in document.connections.contains { $0.id == id } }
        invalidate(); clearSecrets(); message = nil
    }
    func change(_ profile: RawConnection, replacing id: String?) {
        if let id, let index = document.connections.firstIndex(where: { $0.id == id }) { document.connections[index] = profile }
        else { document.connections.append(profile) }
        invalidate(); clearSecrets(); message = "草稿已修改，尚未保存。 / Draft changed, not saved."
    }
    func delete(_ id: String) {
        document.connections.removeAll { $0.id == id }; selection.removeAll { $0 == id }; invalidate(); clearSecrets(); message = "草稿已修改，尚未保存。 / Draft changed, not saved."
    }
    func select(_ id: String) { if !selection.contains(id) { selection.append(id) }; invalidate(); clearSecrets() }
    func remove(_ id: String) { selection.removeAll { $0 == id }; invalidate(); clearSecrets() }
    func move(_ id: String, by delta: Int) {
        guard let index = selection.firstIndex(of: id), selection.indices.contains(index + delta) else { return }
        selection.swapAt(index, index + delta); invalidate(); clearSecrets()
    }
    func saved(_ response: ConnectionsResponse) throws {
        guard let revision = response.revision, let rows = response.connections else { throw DesktopError.invalidOutput }
        baseRevision = revision; catalog = rows; savedDocument = document; draftState = .editing; retainedDraft = nil
        invalidate(); clearSecrets(); message = "已保存。請重新檢查順序與範圍。 / Saved. Inspect the selection and scope again."
    }
    func failed(_ error: Error) {
        if let failure = error as? ConnectionsFailure, ["revision_conflict", "save_state_unknown"].contains(failure.code) {
            retainedDraft = document; draftState = failure.code == "revision_conflict" ? .conflict : .reloadRequired
        }
        message = (error as? ConnectionsFailure)?.localizedDescription ?? (error as? DesktopError)?.localizedDescription ?? DesktopError.invalidOutput.localizedDescription
        invalidate(); clearSecrets()
    }
    func reapply() {
        guard let retainedDraft, draftState == .editing else { return }
        document = retainedDraft; self.retainedDraft = nil; invalidate(); message = "已重套草稿，尚未保存。 / Draft reapplied, not saved."
    }
    var canReapply: Bool { retainedDraft != nil && draftState == .editing }
    func inspected(_ response: ConnectionsResponse) throws {
        guard let revision = response.revision, revision == baseRevision, let rows = response.connections,
              rows.map(\.id) == selection else { throw ConnectionsFailure(code: "revision_conflict") }
        inspection = rows; inspectionRevision = revision
    }
    func request(_ operation: String) throws -> Data {
        struct DocumentRequest: Encodable { let document: ConnectionsDocument }
        struct Apply: Encodable { let expectedRevision: String; let document: ConnectionsDocument }
        struct Selection: Encodable { let ids: [String] }
        if operation == "inspect" { return try JSONEncoder().encode(Selection(ids: selection)) }
        if operation == "apply" {
            guard draftState == .editing, let baseRevision else { throw DesktopError.invalidOutput }
            return try JSONEncoder().encode(Apply(expectedRevision: baseRevision, document: document))
        }
        return try JSONEncoder().encode(DocumentRequest(document: document))
    }
}

private struct ProfileSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var profile: RawConnection
    let save: (RawConnection) -> Void
    @State private var route = "ambient"
    @State private var source = ""
    @State private var endpoint = ""
    @State private var args = "[]"
    @State private var env = "{}"
    @State private var error: String?
    @FocusState private var idFocused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("連線草稿 / Connection draft").font(.title2)
            if Bundle.main.object(forInfoDictionaryKey: "NeedlefishOfflineUITest") as? Bool == true {
                Text("OFFLINE UI TEST. No provider or credentials.").font(.headline).foregroundStyle(.orange)
            }
            Text("填設定與來源名稱，不要填密鑰值。CLI 保存時驗證。 / Settings and source names only. Never enter secret values here. The CLI validates before saving.")
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("名稱 / Profile ID", text: $profile.id).focused($idFocused)
                Picker("執行器 / Adapter", selection: $profile.adapter) {
                    ForEach(["codex", "claude", "opencode", "pi", "openai", "grok", "acp"], id: \.self) { Text($0).tag($0) }
                }
                TextField("要求模型 / Requested model", text: Binding(get: { profile.model ?? "" }, set: { profile.model = $0.isEmpty ? nil : $0 }))
                if profile.adapter == "codex" {
                    Picker("目的地 / Destination", selection: $route) {
                        Text("既有登入，目的地未知 / Existing sign-in, destination unknown").tag("ambient")
                        Text("OpenAI direct").tag("openai")
                        Text("CLIProxyAPI").tag("cliproxyapi")
                    }
                    if route != "ambient" { TextField("密鑰來源名稱 / Key source name", text: $source) }
                    if route == "cliproxyapi" { TextField("Proxy base URL", text: $endpoint) }
                }
                if profile.adapter == "acp" {
                    TextField("執行檔絕對路徑 / Executable path", text: Binding(get: { profile.launch?.command ?? "" }, set: { profile.launch = .init(command: $0, args: profile.launch?.args ?? []) }))
                    TextField("參數 JSON 陣列，保留 {model} / Arguments JSON array", text: $args)
                    TextField("密鑰來源對照 JSON / Credential source map", text: $env)
                    Text("ACP 目的地與實際模型未知。 / ACP destination and delivered model unknown.")
                }
            }
            if let error { Text(error).foregroundStyle(.orange) }
            HStack {
                Button("取消編輯 / Cancel edit", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("套用至草稿 / Use draft") {
                    do {
                        var result = profile
                        if result.adapter == "acp" {
                            result.launch = .init(command: profile.launch?.command ?? "", args: try JSONDecoder().decode([String].self, from: Data(args.utf8)))
                            let refs = try JSONDecoder().decode([String: String].self, from: Data(env.utf8))
                            result.auth = refs.isEmpty ? nil : .init(env: refs)
                        } else {
                            result.launch = nil
                            result.auth = result.adapter == "codex" && route != "ambient" ? .init(env: [route == "openai" ? "CODEX_API_KEY" : "CODEX_PROXY_API_KEY": source], route: .init(kind: route, baseUrl: route == "cliproxyapi" ? endpoint : nil)) : nil
                        }
                        save(result); dismiss()
                    } catch { self.error = "JSON 格式錯誤。未修改草稿。 / Invalid JSON. Draft unchanged." }
                }.keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 640)
        .onAppear {
            route = profile.auth?.route?.kind ?? "ambient"; endpoint = profile.auth?.route?.baseUrl ?? ""
            source = profile.auth?.env.values.first ?? ""
            args = String(decoding: (try? JSONEncoder().encode(profile.launch?.args ?? [])) ?? Data("[]".utf8), as: UTF8.self)
            env = String(decoding: (try? JSONEncoder().encode(profile.auth?.env ?? [:])) ?? Data("{}".utf8), as: UTF8.self)
            idFocused = true
        }
    }
}

struct AdvancedConnectionsView: View {
    @ObservedObject var owner: Onboarding
    @ObservedObject var model: AdvancedConnections
    @State private var editing: RawConnection?
    @State private var originalID: String?
    @State private var deleting: RawConnection?
    @FocusState private var profileFocus: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("連線是本機設定名稱，不代表不同帳號。認證未知、資格未驗證、費用未知。 / Profiles do not prove independent accounts. Authentication unknown, unqualified, cost unknown.")
            HStack {
                Button("載入連線 / Load connections") { owner.connectionOperation("edit") }.disabled(owner.repo == nil || owner.busy)
                Button("新增連線 / Add connection") { originalID = nil; editing = .init(id: "", adapter: "codex", model: "gpt-5.6-sol") }.focused($profileFocus, equals: "add").disabled(model.baseRevision == nil || owner.busy)
                Button("保存全部草稿 / Save all drafts") { owner.connectionOperation("apply") }.disabled(owner.busy || model.draftState != .editing || !model.dirty)
                if model.canReapply { Button("明確重套草稿 / Reapply retained draft", action: model.reapply).disabled(owner.busy) }
            }
            if let message = model.message { Text(message).foregroundStyle(.orange).textSelection(.enabled) }
            ForEach(Array(model.document.connections.enumerated()), id: \.offset) { _, profile in
                HStack {
                    Text(profile.id + " · " + profile.adapter + " · " + (profile.model ?? "agent default"))
                    Spacer()
                    Button("編輯 / Edit " + profile.id) { originalID = profile.id; editing = profile }.focused($profileFocus, equals: "edit-" + profile.id)
                    Button("刪除 / Delete " + profile.id) { deleting = profile }
                    Button("加入順序 / Select " + profile.id) { model.select(profile.id) }.disabled(model.selection.contains(profile.id))
                }.disabled(owner.busy)
            }
            Text("本次順序 / This review's route order").font(.headline)
            ForEach(Array(model.selection.enumerated()), id: \.offset) { index, id in
                HStack {
                    Text("\(index + 1). \(id)")
                    Spacer()
                    Button("上移 / Move up " + id) { model.move(id, by: -1) }.disabled(index == 0)
                    Button("下移 / Move down " + id) { model.move(id, by: 1) }.disabled(index == model.selection.count - 1)
                    Button("移出 / Remove " + id) { model.remove(id) }
                }.disabled(owner.busy)
            }
            LabeledContent("模型審查總預算，毫秒 / Model review budget in milliseconds") {
                TextField("", text: $model.budget).accessibilityLabel("模型審查總預算，毫秒 / Model review budget in milliseconds")
            }.disabled(owner.busy)
            if !model.budget.isEmpty && model.budgetMs == nil {
                Text("預算須為 1 到 2147483647 的整數。 / Budget must be an integer from 1 through 2147483647.").foregroundStyle(.orange)
            }
            Text("收集來源與清理不計入模型預算。外層失控監控另允許十分鐘，再要求清理。 / Collection and cleanup are outside the model budget. The watchdog allows ten extra minutes, then requests cleanup.").font(.caption)
            Picker("認證來源 / Credential mode", selection: $model.credentialMode) {
                Text("既有登入與可用來源 / Existing credentials").tag("existing")
                Text("只在本次提供 / Session only").tag("session")
            }.disabled(owner.busy)
            if model.credentialMode == "existing" && !model.sourceRefs.isEmpty {
                Text("此 App 不轉送任意環境密鑰。這些明確來源須選擇只在本次提供。 / This app does not forward environment keys. Choose Session only for explicit source references.").foregroundStyle(.orange)
            }
            if model.credentialMode == "session" {
                if !model.sessionAllowed { Text("每條選定連線都必須設定明確來源。 / Every selected profile needs explicit source references.").foregroundStyle(.orange) }
                ForEach(model.sourceRefs, id: \.self) { ref in
                    LabeledContent("本次密鑰 / Session value " + ref) {
                        SecureField("", text: Binding(get: { model.secrets[ref] ?? "" }, set: { model.secrets[ref] = $0 }))
                            .accessibilityLabel("本次密鑰 / Session value " + ref)
                    }.disabled(owner.busy)
                }
                Text("只透過匿名 stdin 傳遞，不保存。無法保證記憶體實體清除。 / Anonymous stdin only, not persisted. Physical memory erasure is not guaranteed.").font(.caption)
            }
            if let rows = model.inspection { ForEach(rows) { row in Text(row.summary + " · " + row.readiness) } }
            Button("檢查連線與範圍 / Inspect connections and scope", action: owner.prepareConnections)
                .disabled(owner.busy || model.dirty || !model.validSelection || model.budgetMs == nil || model.draftState != .editing)
        }
        .sheet(item: $editing, onDismiss: { profileFocus = originalID.map { "edit-" + $0 } ?? "add" }) { profile in ProfileSheet(profile: profile) { model.change($0, replacing: originalID) } }
        .confirmationDialog("刪除連線草稿？ / Delete profile from draft?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            if let deleting { Button("刪除 / Delete " + deleting.id, role: .destructive) { model.delete(deleting.id); self.deleting = nil } }
            Button("取消 / Cancel", role: .cancel) { deleting = nil }
        }
        .onChange(of: model.budget) { owner.invalidateConnectionConsent() }
        .onChange(of: model.credentialMode) { model.clearSecrets(); owner.invalidateConnectionConsent() }
        .onChange(of: model.document) { owner.invalidateConnectionConsent() }
        .onChange(of: model.selection) { owner.invalidateConnectionConsent() }
    }
}
