import Darwin
import Foundation
import Security

struct InstallationStore {
    private let root: URL
    init(root: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Needlefish/Desktop")) { self.root = root }

    struct Receipt: Codable {
        var current: String?
        var previous: String?
        var pendingRemoval: [String]?
    }

    private func directory() throws {
        let fm = FileManager.default
        let parent = root.deletingLastPathComponent()
        for url in [parent, root] where fm.fileExists(atPath: url.path) {
            guard try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw DesktopError.command }
        }
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }

    private func lock() throws -> Int32 {
        try directory()
        let descriptor = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw DesktopError.command }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            throw DesktopError.installationBusy
        }
        return descriptor
    }

    private var receiptURL: URL { root.appendingPathComponent("receipt.json") }
    private func receipt() throws -> Receipt {
        guard FileManager.default.fileExists(atPath: receiptURL.path) else { return Receipt() }
        guard try receiptURL.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw DesktopError.command }
        return try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: receiptURL))
    }
    private func app(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw DesktopError.command }
        return root.appendingPathComponent(id + ".app")
    }
    private func save(_ receipt: Receipt) throws {
        try JSONEncoder().encode(receipt).write(to: receiptURL, options: .atomic)
    }

    static func verify(_ url: URL, team: String) throws {
        guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { throw DesktopError.command }
        var code: SecStaticCode?
        var requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"com.needlefish.desktop\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\""
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
              SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
              let code, SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode), requirement) == errSecSuccess,
              let bundle = Bundle(url: url), bundle.object(forInfoDictionaryKey: "NeedlefishDevelopment") as? Bool != true else {
            throw DesktopError.command
        }
    }

    @MainActor
    func install(_ source: URL, verify: (URL) throws -> Void, launch: (URL) async throws -> Void) async throws -> URL {
        let descriptor = try lock()
        defer { close(descriptor) }
        var record = try receipt()
        let id = UUID().uuidString
        let destination = try app(id)
        do {
            try FileManager.default.copyItem(at: source, to: destination)
            try verify(destination)
            try await launch(destination)
            if let oldPrevious = record.previous {
                record.pendingRemoval = (record.pendingRemoval ?? []) + [oldPrevious]
            }
            record.previous = record.current
            record.current = id
            try save(record)
            if let pending = record.pendingRemoval, !pending.isEmpty {
                record.pendingRemoval = pending.filter { retired in
                    do {
                        let url = try app(retired)
                        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                        return false
                    } catch { return true }
                }
                if record.pendingRemoval != pending { try? save(record) }
            }
            return destination
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }

    @MainActor
    func rollback(verify: (URL) throws -> Void, launch: (URL) async throws -> Void) async throws -> URL {
        let descriptor = try lock()
        defer { close(descriptor) }
        var record = try receipt()
        guard let previous = record.previous else { throw DesktopError.command }
        let destination = try app(previous)
        try verify(destination)
        try await launch(destination)
        record.previous = record.current
        record.current = previous
        try save(record)
        return destination
    }

    func uninstall() throws {
        let descriptor = try lock()
        defer { close(descriptor) }
        let record = try receipt()
        for id in Set([record.current, record.previous].compactMap { $0 } + (record.pendingRemoval ?? [])) {
            let url = try app(id)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
        if FileManager.default.fileExists(atPath: receiptURL.path) { try FileManager.default.removeItem(at: receiptURL) }
    }
}
