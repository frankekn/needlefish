import AppKit
import Darwin
import Foundation
import XCTest
@testable import NeedlefishDesktop

final class DesktopTests: XCTestCase {
    let fm = FileManager.default
    func temporary() throws -> URL {
        let url = fm.temporaryDirectory.appendingPathComponent("needlefish-desktop-test-" + UUID().uuidString)
        try fm.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    func fixture(_ body: String) throws -> Runtime {
        let root = try temporary()
        let script = root.appendingPathComponent("fake-cli")
        try ("#!/bin/sh\n" + body + "\n").write(to: script, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        return Runtime(node: "/bin/sh", cli: script.path, codex: script.path, git: "/usr/bin/git", development: true)
    }
    let doctorJSON = #"{"schemaVersion":1,"repoRoot":"/test/project","checks":[{"name":"node","status":"ok","detail":"v24"},{"name":"runner","status":"ok","detail":"codex"},{"name":"auth","status":"ok","detail":"logged in"},{"name":"git","status":"ok","detail":"repo"},{"name":"base","status":"ok","detail":"changes"}]}"#
    let scopeJSON = #"{"mode":"uncommitted","changedFiles":[{"path":"src/example.ts"}],"patchBytes":20,"untrackedSkipped":[]}"#
    func resultJSON(_ verdict: String) -> String {
        let severity = verdict == "pass" ? "P3" : "P2"
        return "{\"schemaVersion\":1,\"verdict\":\"\(verdict)\",\"summary\":\"Review complete\",\"findings\":[{\"severity\":\"\(severity)\",\"title\":\"Empty list fails\",\"file\":\"example.ts\",\"lineStart\":8,\"whyItBreaks\":\"Missing first item\",\"suggestedFix\":\"Check the list\"}],\"residualRisks\":[]}"
    }
    func testDoctorUsesSharedJSONAndExactArguments() async throws {
        let runtime = try fixture("[ \"$*\" = 'doctor --repo /test/project --runner codex --json' ] || exit 3\nprintf '%s' '\(doctorJSON)'")
        let report = try await DesktopCLI(runtime: runtime).doctor(repo: URL(fileURLWithPath: "/test/project"), command: Command())
        XCTAssertEqual(report.checks.map(\.name), ["node", "runner", "auth", "git", "base"])
        XCTAssertEqual(report.ready, true)
    }
    func testNotRepoDoesNotInitializeProject() async throws {
        let json = doctorJSON.replacingOccurrences(of: #""git","status":"ok""#, with: #""git","status":"fail""#)
            .replacingOccurrences(of: #""repoRoot":"/test/project","#, with: "")
        let runtime = try fixture("printf '%s' '\(json)'\nexit 1")
        let report = try await DesktopCLI(runtime: runtime).doctor(repo: URL(fileURLWithPath: "/test/project"), command: Command())
        XCTAssertEqual(report.repoAvailable, false)
        XCTAssertEqual(report.ready, false)
        XCTAssertEqual(report.checks[3].explanation, "無法讀取 Git 專案。請選擇正確資料夾。不會自動初始化或修改專案。 / Choose a Git project.")
    }
    func testFailedOrUnknownGitCannotSupplyRepositoryRoot() throws {
        for status in ["fail", "unknown"] {
            for root in ["/test/project", "relative/project", "/project/../other"] {
                let json = doctorJSON
                    .replacingOccurrences(of: #""git","status":"ok""#, with: "\"git\",\"status\":\"\(status)\"")
                    .replacingOccurrences(of: "/test/project", with: root)
                XCTAssertThrowsError(try JSONDecoder().decode(Doctor.self, from: Data(json.utf8)).validated()) { error in
                    XCTAssertEqual(error.localizedDescription, DesktopError.invalidOutput.localizedDescription)
                }
            }
        }
    }
    func testMissingAuthAndUnknownCapabilityCannotBeReady() throws {
        for status in ["fail", "unknown"] {
            let json = doctorJSON.replacingOccurrences(of: #""auth","status":"ok""#, with: "\"auth\",\"status\":\"\(status)\"")
            let report = try JSONDecoder().decode(Doctor.self, from: Data(json.utf8)).validated()
            XCTAssertEqual(report.ready, false)
            XCTAssertEqual(report.scopeReady, true)
        }
    }
    func testUncommittedReviewDoesNotRequireBranchBase() throws {
        let json = doctorJSON.replacingOccurrences(of: #""base","status":"ok""#, with: #""base","status":"fail""#)
        let report = try JSONDecoder().decode(Doctor.self, from: Data(json.utf8)).validated()
        XCTAssertEqual(report.ready, true)
        XCTAssertEqual(report.checks[4].explanation, "此介面只檢查未提交變更，不需要分支基準。 / This view reviews uncommitted changes only; no branch base is required.")
    }
    func testMalformedDoctorIsRejected() throws {
        let data = Data(#"{"schemaVersion":1,"checks":[]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(Doctor.self, from: data).validated())
    }
    func testAllVerdictsAndFindingsArePreserved() async throws {
        for verdict in ["pass", "changes_requested", "needs_human"] {
            let runtime = try fixture("printf '%s' '\(resultJSON(verdict))'")
            let result = try await DesktopCLI(runtime: runtime).review(repo: URL(fileURLWithPath: "/project"), command: Command())
            XCTAssertEqual(result.verdict.rawValue, verdict)
            XCTAssertEqual(result.findings[0].suggestedFix, "Check the list")
            XCTAssertEqual(result.findings[0].lineStart, 8)
        }
    }
    func testNonzeroCannotClaimPassButCanReturnConservativeResult() async throws {
        for verdict in ["pass", "needs_human"] {
            let runtime = try fixture("printf '%s' '\(resultJSON(verdict))'\nexit 1")
            do {
                let result = try await DesktopCLI(runtime: runtime).review(repo: URL(fileURLWithPath: "/project"), command: Command())
                XCTAssertEqual(result.verdict.rawValue, "needs_human")
            } catch {
                XCTAssertEqual(verdict, "pass")
            }
        }
    }
    func testNetworkQuotaAndAuthErrorsUseCannedMessages() async throws {
        for (message, expected) in [("network error", DesktopError.network), ("usage limit", .quota), ("auth rejected", .auth)] {
            let runtime = try fixture("printf '%s' '\(message) private-token /private/project' >&2\nexit 1")
            do {
                _ = try await DesktopCLI(runtime: runtime).review(repo: URL(fileURLWithPath: "/project"), command: Command())
                XCTFail("Must remain incomplete")
            } catch {
                XCTAssertEqual(error.localizedDescription, expected.localizedDescription)
                XCTAssertEqual(error.localizedDescription.contains("private-token"), false)
            }
        }
    }
    func testCancellationStopsProcessGroupAndRemovesTemporaryFiles() async throws {
        let root = try temporary()
        let childPID = root.appendingPathComponent("child-pid")
        let runtime = try fixture("sleep 120 &\necho $! > '\(childPID.path)'\nwait")
        let work = root.appendingPathComponent("work")
        let command = Command()
        let task = Task { try await command.run(runtime.command([]), environment: ["PATH": "/usr/bin:/bin"], temporary: work, timeout: 30) }
        for _ in 0..<100 {
            if fm.fileExists(atPath: childPID.path) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let pid = Int32(try String(contentsOf: childPID, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
        command.cancel()
        command.cancel()
        do { _ = try await task.value; XCTFail("Must cancel") }
        catch { XCTAssertEqual(error.localizedDescription, DesktopError.cancelled.localizedDescription) }
        XCTAssertEqual(fm.fileExists(atPath: work.path), false)
        for _ in 0..<50 {
            if kill(pid, 0) != 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(kill(pid, 0), -1)
    }
    func testCancellationAllowsCLIFinalizerToRun() async throws {
        let root = try temporary()
        let ready = root.appendingPathComponent("ready")
        let cleaned = root.appendingPathComponent("cleaned")
        let runtime = try fixture("trap 'sleep 0.3; printf finished > \"\(cleaned.path)\"; exit 0' TERM\nprintf ready > '\(ready.path)'\nwhile :; do sleep 0.1; done")
        let command = Command()
        let task = Task { try await command.run(runtime.command([]), environment: ["PATH": "/usr/bin:/bin"], temporary: root.appendingPathComponent("work"), timeout: 10) }
        for _ in 0..<100 {
            if fm.fileExists(atPath: ready.path) { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(try String(contentsOf: ready, encoding: .utf8), "ready")
        command.cancel()
        command.cancel()
        do { _ = try await task.value; XCTFail("Must cancel") }
        catch { XCTAssertEqual(error.localizedDescription, DesktopError.cancelled.localizedDescription) }
        XCTAssertEqual(try String(contentsOf: cleaned, encoding: .utf8), "finished")
    }
    func testCommandCapturesBothStreamsThroughPipes() async throws {
        let runtime = try fixture("if [ -p /dev/fd/1 ] && [ -p /dev/fd/2 ]; then printf pipes; printf diagnostic >&2; else printf regular-files; fi")
        let output = try await DesktopCLI(runtime: runtime).call([], command: Command())
        XCTAssertEqual(String(decoding: output.stdout, as: UTF8.self), "pipes")
        XCTAssertEqual(String(decoding: output.stderr, as: UTF8.self), "diagnostic")
    }
    func testOversizedOutputIsNotParsedAsAResult() async throws {
        let runtime = try fixture("head -c 9000000 /dev/zero")
        do {
            _ = try await DesktopCLI(runtime: runtime).review(repo: URL(fileURLWithPath: "/project"), command: Command())
            XCTFail("Must reject oversized output")
        } catch { XCTAssertEqual(error.localizedDescription, DesktopError.outputLimit.localizedDescription) }
    }
    func testCancellationAndTimeoutKillTermIgnoringDescendantAfterLeaderExits() async throws {
        for cancel in [true, false] {
            let root = try temporary()
            let childPID = root.appendingPathComponent("child-pid")
            let runtime = try fixture("sh -c 'trap \"\" TERM; echo $$ > \"\(childPID.path)\"; while :; do sleep 0.1; done' &\ntrap 'exit 0' TERM\nwait")
            let command = Command()
            let task = Task { try await command.run(runtime.command([]), environment: ["PATH": "/bin:/usr/bin"], temporary: root.appendingPathComponent("work"), timeout: cancel ? 10 : 0.3) }
            for _ in 0..<100 {
                if fm.fileExists(atPath: childPID.path) { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let pid = Int32(try String(contentsOf: childPID, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
            if cancel { command.cancel() }
            do { _ = try await task.value; XCTFail("Must stop") }
            catch { XCTAssertEqual(error.localizedDescription, (cancel ? DesktopError.cancelled : .timeout).localizedDescription) }
            for _ in 0..<100 {
                if kill(pid, 0) != 0 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(kill(pid, 0), -1)
            XCTAssertEqual(fm.fileExists(atPath: root.appendingPathComponent("work").path), false)
        }
    }
    func testNormalAndFailedLeaderExitCannotLeaveOwnedDescendants() async throws {
        for status in [0, 1, 137] {
            let root = try temporary()
            let childPID = root.appendingPathComponent("child-pid")
            let exit = status == 137 ? "kill -KILL $$" : "exit \(status)"
            let runtime = try fixture("sleep 120 &\necho $! > '\(childPID.path)'\n\(exit)")
            let output = try await Command().run(runtime.command([]), environment: ["PATH": "/bin:/usr/bin"], temporary: root.appendingPathComponent("work"), timeout: 10)
            XCTAssertEqual(output.status, Int32(status))
            let pid = Int32(try String(contentsOf: childPID, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
            for _ in 0..<100 {
                if kill(pid, 0) != 0 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(kill(pid, 0), -1)
        }
    }
    func testBothStreamsPreserveExactLimitWithoutDeadlock() async throws {
        let runtime = try fixture("head -c 8388608 /dev/zero >&2 &\nhead -c 8388608 /dev/zero\nwait")
        let output = try await DesktopCLI(runtime: runtime).call([], command: Command(), timeout: 10)
        XCTAssertEqual(output.status, 0)
        XCTAssertEqual(output.stdout, Data(repeating: 0, count: 8 * 1024 * 1024))
        XCTAssertEqual(output.stderr, Data(repeating: 0, count: 8 * 1024 * 1024))
    }
    func testBurstOnEitherStreamIsBoundedAndKillsProducer() async throws {
        for redirect in ["", ">&2"] {
            let root = try temporary()
            let finished = root.appendingPathComponent("finished")
            let runtime = try fixture("head -c 134217728 /dev/zero \(redirect)\nprintf escaped > '\(finished.path)'")
            let work = root.appendingPathComponent("work")
            do {
                _ = try await Command().run(runtime.command([]), environment: ["PATH": "/bin:/usr/bin"], temporary: work, timeout: 10)
                XCTFail("Burst must stop at capture boundary")
            } catch { XCTAssertEqual(error.localizedDescription, DesktopError.outputLimit.localizedDescription) }
            XCTAssertEqual(fm.fileExists(atPath: finished.path), false)
            XCTAssertEqual(fm.fileExists(atPath: work.path), false)
        }
    }
    func testCancelledAndTimedOutCompletePassJSONCannotSucceed() async throws {
        for cancel in [true, false] {
            let runtime = try fixture("printf '%s' '\(resultJSON("pass"))'\nsleep 120")
            let root = try temporary()
            let command = Command()
            if cancel { command.cancel() }
            do {
                _ = try await command.run(runtime.command([]), environment: ["PATH": "/bin:/usr/bin"], temporary: root.appendingPathComponent("work"), timeout: 0.1)
                XCTFail("Terminal failure must override valid JSON")
            } catch { XCTAssertEqual(error.localizedDescription, (cancel ? DesktopError.cancelled : .timeout).localizedDescription) }
        }
    }
    func testSpawnFailureOwnsNoGroupAndRemovesTemporaryOutput() async throws {
        let root = try temporary()
        let work = root.appendingPathComponent("work")
        do {
            _ = try await Command().run([root.appendingPathComponent("missing-cli").path], environment: [:], temporary: work, timeout: 1)
            XCTFail("Must reject missing executable")
        } catch { XCTAssertEqual(error.localizedDescription, DesktopError.command.localizedDescription) }
        XCTAssertEqual(fm.fileExists(atPath: work.path), false)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: root.path), [])
    }
    func testTimeoutAndLoginCancelAreNotSuccess() async throws {
        let runtime = try fixture("sleep 120")
        let root = try temporary()
        do {
            _ = try await Command().run([runtime.codex, "login", "--device-auth"], environment: ["PATH": "/bin:/usr/bin"],
                                        temporary: root.appendingPathComponent("login"), timeout: 0.1)
            XCTFail("Must time out")
        } catch { XCTAssertEqual(error.localizedDescription, DesktopError.timeout.localizedDescription) }
        let cancelled = Command()
        cancelled.cancel()
        do {
            _ = try await cancelled.run([runtime.codex, "login", "--device-auth"], environment: ["PATH": "/bin:/usr/bin"],
                                        temporary: root.appendingPathComponent("cancelled"), timeout: 10)
            XCTFail("Must cancel")
        } catch { XCTAssertEqual(error.localizedDescription, DesktopError.cancelled.localizedDescription) }
    }
    func testOnlyOfficialDeviceCodeIsDisplayed() {
        XCTAssertEqual(deviceCode("https://auth.openai.com/codex/device\nEnter this one-time code (expires in 15 minutes)\nABCD-12345\n"), "ABCD-12345")
        XCTAssertNil(deviceCode("https://evil.example/codex/device\nEnter this one-time code\nABCD-12345"))
        XCTAssertNil(deviceCode("https://auth.openai.com/codex/device\nEnter this one-time code\nsecret-token"))
    }
    @MainActor
    func testInstallFailurePreservesPreviousAndRollbackAndUninstallPreserveUnownedFiles() async throws {
        let root = try temporary()
        let source = root.appendingPathComponent("source.app")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        let storeRoot = root.appendingPathComponent("managed")
        let store = InstallationStore(root: storeRoot)
        let first = try await store.install(source, verify: { _ in }, launch: { _ in })
        do {
            _ = try await store.install(source, verify: { _ in throw DesktopError.command }, launch: { _ in })
            XCTFail("Must reject invalid install")
        } catch { XCTAssertEqual(error.localizedDescription, DesktopError.command.localizedDescription) }
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: storeRoot.path).filter { $0.hasSuffix(".app") }.count, 1)
        let second = try await store.install(source, verify: { _ in }, launch: { _ in })
        XCTAssertNotEqual(first.path, second.path)
        let restored = try await store.rollback(verify: { _ in }, launch: { _ in })
        XCTAssertEqual(restored.path, first.path)
        let unowned = storeRoot.appendingPathComponent("user.txt")
        try "keep".write(to: unowned, atomically: true, encoding: .utf8)
        try store.uninstall()
        XCTAssertEqual(try String(contentsOf: unowned, encoding: .utf8), "keep")
        XCTAssertEqual(fm.fileExists(atPath: first.path), false)
        XCTAssertEqual(fm.fileExists(atPath: second.path), false)
    }
    struct SavedInstallationReceipt: Decodable {
        let current: String?
        let previous: String?
        let pendingRemoval: [String]?
    }
    @MainActor
    func testFailedRetirementKeepsOwnershipAndUninstallRetries() async throws {
        let root = try temporary()
        let source = root.appendingPathComponent("source.app")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        let managed = root.appendingPathComponent("managed")
        let store = InstallationStore(root: managed)
        let oldest = try await store.install(source, verify: { _ in }, launch: { _ in })
        let second = try await store.install(source, verify: { _ in }, launch: { _ in })
        XCTAssertEqual(chflags(oldest.path, UInt32(UF_IMMUTABLE)), 0)
        defer { _ = chflags(oldest.path, 0) }
        XCTAssertThrowsError(try fm.removeItem(at: oldest))
        let third = try await store.install(source, verify: { _ in }, launch: { _ in })
        let receiptURL = managed.appendingPathComponent("receipt.json")
        let saved = try Data(contentsOf: receiptURL)
        let record = try JSONDecoder().decode(SavedInstallationReceipt.self, from: saved)
        XCTAssertEqual(record.current, third.deletingPathExtension().lastPathComponent)
        XCTAssertEqual(record.previous, second.deletingPathExtension().lastPathComponent)
        XCTAssertEqual(record.pendingRemoval, [oldest.deletingPathExtension().lastPathComponent])
        let unowned = managed.appendingPathComponent(UUID().uuidString + ".app")
        try fm.createDirectory(at: unowned, withIntermediateDirectories: true)
        let marker = unowned.appendingPathComponent("user.txt")
        try "keep".write(to: marker, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try InstallationStore(root: managed).uninstall())
        XCTAssertEqual(try Data(contentsOf: receiptURL), saved)
        XCTAssertEqual(fm.fileExists(atPath: oldest.path), true)
        XCTAssertEqual(chflags(oldest.path, 0), 0)
        try InstallationStore(root: managed).uninstall()
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: managed.path), [unowned.lastPathComponent])
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "keep")
        try store.uninstall()
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "keep")
    }
    @MainActor
    func testLaterInstallRetriesRetiredVersionsWithoutLosingRollback() async throws {
        let root = try temporary()
        let source = root.appendingPathComponent("source.app")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        let managed = root.appendingPathComponent("managed")
        let store = InstallationStore(root: managed)
        let oldest = try await store.install(source, verify: { _ in }, launch: { _ in })
        let second = try await store.install(source, verify: { _ in }, launch: { _ in })
        XCTAssertEqual(chflags(oldest.path, UInt32(UF_IMMUTABLE)), 0)
        defer { _ = chflags(oldest.path, 0) }
        let third = try await store.install(source, verify: { _ in }, launch: { _ in })
        XCTAssertEqual(chflags(oldest.path, 0), 0)
        let fourth = try await InstallationStore(root: managed).install(source, verify: { _ in }, launch: { _ in })
        let saved = try Data(contentsOf: managed.appendingPathComponent("receipt.json"))
        let record = try JSONDecoder().decode(SavedInstallationReceipt.self, from: saved)
        XCTAssertEqual(record.current, fourth.deletingPathExtension().lastPathComponent)
        XCTAssertEqual(record.previous, third.deletingPathExtension().lastPathComponent)
        XCTAssertEqual(record.pendingRemoval, [])
        XCTAssertEqual(fm.fileExists(atPath: oldest.path), false)
        XCTAssertEqual(fm.fileExists(atPath: second.path), false)
        let restored = try await store.rollback(verify: { _ in }, launch: { _ in })
        XCTAssertEqual(restored.path, third.path)
    }
    @MainActor
    func testFailedReceiptCommitKeepsRollbackAndCleansCandidate() async throws {
        let root = try temporary()
        let source = root.appendingPathComponent("source.app")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        let managed = root.appendingPathComponent("managed")
        let store = InstallationStore(root: managed)
        let first = try await store.install(source, verify: { _ in }, launch: { _ in })
        let second = try await store.install(source, verify: { _ in }, launch: { _ in })
        let receiptURL = managed.appendingPathComponent("receipt.json")
        let saved = try Data(contentsOf: receiptURL)
        XCTAssertEqual(chflags(receiptURL.path, UInt32(UF_IMMUTABLE)), 0)
        defer { _ = chflags(receiptURL.path, 0) }
        do {
            _ = try await store.install(source, verify: { _ in }, launch: { _ in })
            XCTFail("Must reject failed receipt commit")
        } catch {
            XCTAssertEqual(try Data(contentsOf: receiptURL), saved)
        }
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: managed.path).sorted(),
                       [first.lastPathComponent, second.lastPathComponent, "receipt.json"].sorted())
        XCTAssertEqual(chflags(receiptURL.path, 0), 0)
        let restored = try await store.rollback(verify: { _ in }, launch: { _ in })
        XCTAssertEqual(restored.path, first.path)
    }
    @MainActor
    func testLegacyReceiptSupportsRollbackUpgradeAndUninstall() async throws {
        let root = try temporary()
        let firstID = "11111111-1111-4111-8111-111111111111"
        let secondID = "22222222-2222-4222-8222-222222222222"
        let first = root.appendingPathComponent(firstID + ".app")
        let second = root.appendingPathComponent(secondID + ".app")
        try fm.createDirectory(at: first, withIntermediateDirectories: true)
        try fm.createDirectory(at: second, withIntermediateDirectories: true)
        try Data("{\"current\":\"\(secondID)\",\"previous\":\"\(firstID)\"}".utf8)
            .write(to: root.appendingPathComponent("receipt.json"))
        let store = InstallationStore(root: root)
        let restored = try await store.rollback(verify: { _ in }, launch: { _ in })
        XCTAssertEqual(restored.path, first.path)
        let upgraded = try await store.install(first, verify: { _ in }, launch: { _ in })
        XCTAssertEqual(fm.fileExists(atPath: upgraded.path), true)
        XCTAssertEqual(fm.fileExists(atPath: first.path), true)
        XCTAssertEqual(fm.fileExists(atPath: second.path), false)
        try store.uninstall()
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: root.path), [])
    }
    @MainActor
    func testFailedLaunchDoesNotReplaceReceiptOnInstallOrRollback() async throws {
        let root = try temporary()
        let source = root.appendingPathComponent("source.app")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        let store = InstallationStore(root: root.appendingPathComponent("managed"))
        let first = try await store.install(source, verify: { _ in }, launch: { _ in })
        let second = try await store.install(source, verify: { _ in }, launch: { _ in })
        for rollback in [false, true] {
            do {
                if rollback {
                    _ = try await store.rollback(verify: { _ in }, launch: { _ in throw DesktopError.command })
                } else {
                    _ = try await store.install(source, verify: { _ in }, launch: { _ in throw DesktopError.command })
                }
                XCTFail("Must reject failed launch")
            } catch { XCTAssertEqual(error.localizedDescription, DesktopError.command.localizedDescription) }
        }
        let restored = try await store.rollback(verify: { _ in }, launch: { _ in })
        XCTAssertEqual(restored.path, first.path)
        let current = try await store.rollback(verify: { _ in }, launch: { _ in })
        XCTAssertEqual(current.path, second.path)
    }
    func testMissingOrRelativeRepositoryRootCannotEnableReview() throws {
        for root in ["", "relative/project", "/project/../other"] {
            let json = doctorJSON.replacingOccurrences(of: "/test/project", with: root)
            XCTAssertThrowsError(try JSONDecoder().decode(Doctor.self, from: Data(json.utf8)).validated())
        }
        let privateRoot = doctorJSON.replacingOccurrences(of: "/test/project", with: "/private/tmp/project")
        XCTAssertEqual(try JSONDecoder().decode(Doctor.self, from: Data(privateRoot.utf8)).validated().repoRoot, "/private/tmp/project")
        let missing = doctorJSON.replacingOccurrences(of: #""repoRoot":"/test/project","#, with: "")
        XCTAssertThrowsError(try JSONDecoder().decode(Doctor.self, from: Data(missing.utf8)).validated())
    }
    func testPassWithBlockingFindingOrRiskIsRejectedButP3PassIsValid() throws {
        let valid = try JSONDecoder().decode(Result.self, from: Data(resultJSON("pass").utf8)).validated()
        XCTAssertEqual(valid.verdict, .pass)
        let blocking = resultJSON("pass").replacingOccurrences(of: "P3", with: "P2")
        XCTAssertThrowsError(try JSONDecoder().decode(Result.self, from: Data(blocking.utf8)).validated())
        let risk = resultJSON("pass").replacingOccurrences(of: #""residualRisks":[]"#, with: #""residualRisks":[{"text":"missing coverage","blocks":true}]"#)
        XCTAssertThrowsError(try JSONDecoder().decode(Result.self, from: Data(risk.utf8)).validated())
    }
    @MainActor
    func testInstallationDirectoryLockRejectsConcurrentTransactionsAndReleasesOnFailure() async throws {
        let root = try temporary()
        let source = root.appendingPathComponent("source.app")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        let managed = root.appendingPathComponent("managed")
        let first = InstallationStore(root: managed)
        let other = InstallationStore(root: managed)
        do {
            _ = try await first.install(source, verify: { _ in }, launch: { _ in
                XCTAssertThrowsError(try other.uninstall()) { error in
                    XCTAssertEqual(error.localizedDescription, DesktopError.installationBusy.localizedDescription)
                }
                do {
                    _ = try await other.install(source, verify: { _ in }, launch: { _ in })
                    XCTFail("Must reject concurrent transaction")
                } catch { XCTAssertEqual(error.localizedDescription, DesktopError.installationBusy.localizedDescription) }
                throw DesktopError.command
            })
            XCTFail("Must preserve failed launch")
        } catch { XCTAssertEqual(error.localizedDescription, DesktopError.command.localizedDescription) }
        let installed = try await other.install(source, verify: { _ in }, launch: { _ in })
        XCTAssertEqual(fm.fileExists(atPath: installed.path), true)
        try other.uninstall()
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: managed.path), [])
    }
    func testUninstallRejectsTraversalAndSymlink() throws {
        let root = try temporary()
        for json in [#"{"current":"../../user-project"}"#, #"{"pendingRemoval":["../../user-project"]}"#] {
            try Data(json.utf8).write(to: root.appendingPathComponent("receipt.json"))
            XCTAssertThrowsError(try InstallationStore(root: root).uninstall())
        }
        let link = root.appendingPathComponent("link")
        try fm.createSymbolicLink(at: link, withDestinationURL: root)
        XCTAssertThrowsError(try InstallationStore(root: link).uninstall())
    }
}

@MainActor
final class OnboardingTests: XCTestCase {
    func waitForIdle(_ model: Onboarding) async throws {
        for _ in 0..<100 {
            if !model.busy { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTFail("Operation did not complete")
    }
    func testAppKitCanConstructDelegate() {
        let delegateType: NSObject.Type = AppDelegate.self
        guard let delegate = delegateType.init() as? AppDelegate else { return XCTFail("Expected app delegate") }
        XCTAssertEqual(delegate.applicationShouldTerminate(NSApplication.shared), .terminateNow)
        guard case .welcome = delegate.model.state else { return XCTFail("Expected welcome state") }
    }
    func testQuitDoesNotWaitForInstallationLaunchAndPreservesReceipt() async throws {
        let fixture = DesktopTests()
        let root = try fixture.temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source.app")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let managed = root.appendingPathComponent("managed")
        let store = InstallationStore(root: managed)
        _ = try await store.install(source, verify: { _ in }, launch: { _ in })
        _ = try await store.install(source, verify: { _ in }, launch: { _ in })
        let receiptURL = managed.appendingPathComponent("receipt.json")
        let receipt = try Data(contentsOf: receiptURL)
        for rollback in [false, true] {
            let delegate = AppDelegate()
            var pendingLaunch: CheckedContinuation<Void, Error>?
            delegate.model.startInstallation(source: rollback ? nil : source, store: store, verify: { _ in }) { _ in
                try await withCheckedThrowingContinuation { pendingLaunch = $0 }
            }
            for _ in 0..<100 {
                if pendingLaunch != nil { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            guard let continuation = pendingLaunch else { return XCTFail("Launch did not start") }
            XCTAssertEqual(delegate.model.busy, true)
            XCTAssertEqual(delegate.model.canCancel, false)
            XCTAssertEqual(delegate.applicationShouldTerminate(NSApplication.shared), .terminateNow)
            XCTAssertEqual(try Data(contentsOf: receiptURL), receipt)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path).filter { $0.hasSuffix(".app") }.count, rollback ? 2 : 3)
            continuation.resume(throwing: DesktopError.command)
            try await waitForIdle(delegate.model)
            XCTAssertEqual(try Data(contentsOf: receiptURL), receipt)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path).filter { $0.hasSuffix(".app") }.count, 2)
        }
    }

    func testQuitWaitsForOwnedCommandCleanup() async throws {
        let fixture = DesktopTests()
        let root = try fixture.temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let childPID = root.appendingPathComponent("child-pid")
        let cleaned = root.appendingPathComponent("cleaned")
        let runtime = try fixture.fixture("trap 'sleep 0.2; printf cleaned > \"\(cleaned.path)\"; exit 1' TERM\nsleep 120 &\necho $! > \"\(childPID.path)\"\nwait")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let delegate = AppDelegate(model: Onboarding(runtime: runtime))
        delegate.model.login()
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: childPID.path) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let pid = Int32(try String(contentsOf: childPID, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
        XCTAssertEqual(delegate.applicationShouldTerminate(NSApplication.shared), .terminateLater)
        XCTAssertEqual(delegate.model.busy, true)
        XCTAssertEqual(FileManager.default.fileExists(atPath: cleaned.path), false)
        try await waitForIdle(delegate.model)
        XCTAssertEqual(try String(contentsOf: cleaned, encoding: .utf8), "cleaned")
        XCTAssertEqual(kill(pid, 0), -1)
        XCTAssertEqual(errno, ESRCH)
        XCTAssertEqual(delegate.applicationShouldTerminate(NSApplication.shared), .terminateNow)
    }

    func testDemoCannotEnablePaidReview() {
        let model = Onboarding()
        model.demo()
        model.trusted = true
        model.accepted = true
        model.review()
        guard case .result(let result, let demo) = model.state else { return XCTFail("Expected example") }
        XCTAssertEqual(demo, true)
        XCTAssertEqual(result.summary, "離線範例。沒有讀取你的專案，也沒有呼叫 AI。 / Offline example. Your project was not reviewed.")
    }
    func testNoChangesIsNotProjectPass() async throws {
        let fixture = DesktopTests()
        let runtime = try fixture.fixture("printf '%s' '{\"mode\":\"uncommitted\",\"changedFiles\":[],\"patchBytes\":0,\"untrackedSkipped\":[]}'")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let model = Onboarding(runtime: runtime)
        model.repo = URL(fileURLWithPath: "/project")
        model.prepare()
        try await waitForIdle(model)
        guard case .message(let text) = model.state else { return XCTFail("Expected no changes") }
        XCTAssertEqual(text, "沒有可檢查的變更。這不代表整個專案已驗證安全。 / No changes to review. Your project has not been verified safe.")
    }
    func testDiagnosisAndLoginPreserveSelectedFolderWhenGitIsUnavailable() async throws {
        let fixture = DesktopTests()
        for login in [false, true] {
            for malformed in [false, true] {
                var doctor = fixture.doctorJSON.replacingOccurrences(of: #""git","status":"ok""#, with: #""git","status":"fail""#)
                if !malformed { doctor = doctor.replacingOccurrences(of: #""repoRoot":"/test/project","#, with: "") }
                let runtime = try fixture.fixture("case \"$1\" in login) exit 0;; doctor) printf '%s' '\(doctor)'; exit 1;; *) exit 3;; esac")
                defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
                let model = Onboarding(runtime: runtime)
                model.repo = URL(fileURLWithPath: "/selected/folder")
                if login { model.login() } else { model.diagnose() }
                try await waitForIdle(model)
                XCTAssertEqual(model.repo?.path, "/selected/folder")
                XCTAssertEqual(model.canReview, false)
                if malformed {
                    guard case .message(let text) = model.state else { return XCTFail("Malformed doctor must be rejected") }
                    XCTAssertEqual(text, DesktopError.invalidOutput.localizedDescription)
                } else {
                    guard case .diagnosis(let report) = model.state else { return XCTFail("Non-repository diagnosis must remain available") }
                    XCTAssertEqual(report.scopeReady, false)
                    XCTAssertEqual(report.checks[3].explanation, "無法讀取 Git 專案。請選擇正確資料夾。不會自動初始化或修改專案。 / Choose a Git project.")
                }
            }
        }
    }
    func testUnsignedUserCanInspectScopeButCannotStartReview() async throws {
        let fixture = DesktopTests()
        let doctor = fixture.doctorJSON.replacingOccurrences(of: #""auth","status":"ok""#, with: #""auth","status":"fail""#)
        let runtime = try fixture.fixture("case \"$1\" in doctor) printf '%s' '\(doctor)';; *) case \"$*\" in *--dry-run*) printf '%s' '\(fixture.scopeJSON)';; *) printf '%s' '\(fixture.resultJSON("pass"))';; esac;; esac")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let model = Onboarding(runtime: runtime)
        model.repo = URL(fileURLWithPath: "/project")
        model.diagnose()
        try await waitForIdle(model)
        model.prepare()
        try await waitForIdle(model)
        guard case .consent(let scope) = model.state else { return XCTFail("Scope inspection must work without auth") }
        XCTAssertEqual(scope.changedFiles[0].path, "src/example.ts")
        model.trusted = true
        model.accepted = true
        model.review()
        try await waitForIdle(model)
        guard case .consent = model.state else { return XCTFail("Unsigned review must remain at consent") }
    }
    func testSignedInUserCanReviewAfterBothConsents() async throws {
        let fixture = DesktopTests()
        let runtime = try fixture.fixture("case \"$1\" in doctor) printf '%s' '\(fixture.doctorJSON)';; *) case \"$*\" in *--dry-run*) printf '%s' '\(fixture.scopeJSON)';; *) printf '%s' '\(fixture.resultJSON("pass"))';; esac;; esac")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let model = Onboarding(runtime: runtime)
        model.repo = URL(fileURLWithPath: "/project")
        model.diagnose()
        try await waitForIdle(model)
        model.prepare()
        try await waitForIdle(model)
        model.trusted = true
        XCTAssertEqual(model.canReview, false)
        model.accepted = true
        XCTAssertEqual(model.canReview, true)
        model.review()
        try await waitForIdle(model)
        guard case .result(let result, let demo) = model.state else { return XCTFail("Expected signed-in review") }
        XCTAssertEqual(result.summary, "Review complete")
        XCTAssertEqual(demo, false)
    }
    func testDiagnosticExportCannotReplaceAnActiveOperation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("needlefish-busy-export-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = Onboarding()
        model.state = .busy("Review in progress")
        model.saveDiagnostics("diagnostic preview", to: root)
        guard case .busy(let label) = model.state else { return XCTFail("Export must preserve the active operation") }
        XCTAssertEqual(label, "Review in progress")
        XCTAssertEqual(FileManager.default.fileExists(atPath: root.path), false)
    }
    func testDiagnosticExportReportsFailureAndSuccess() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("needlefish-export-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = Onboarding()
        model.saveDiagnostics("diagnostic preview", to: root.appendingPathComponent("missing/report.txt"))
        guard case .message(let failure) = model.state else { return XCTFail("Expected export failure") }
        XCTAssertEqual(failure, "無法儲存診斷。請選擇可寫入的位置並重試。 / Could not save diagnostics. Choose a writable location and retry.")
        let destination = root.appendingPathComponent("report.txt")
        model.saveDiagnostics("diagnostic preview", to: destination)
        guard case .message(let success) = model.state else { return XCTFail("Expected export success") }
        XCTAssertEqual(success, "已匯出診斷。 / Diagnostics exported.")
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "diagnostic preview")
    }
    func testConsentIsRequiredBeforeReview() async throws {
        let fixture = DesktopTests()
        let runtime = try fixture.fixture("printf '%s' '\(fixture.scopeJSON)'")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let model = Onboarding(runtime: runtime)
        model.repo = URL(fileURLWithPath: "/project")
        model.prepare()
        try await waitForIdle(model)
        model.review()
        guard case .consent(let scope) = model.state else { return XCTFail("Consent required") }
        XCTAssertEqual(scope.changedFiles[0].path, "src/example.ts")
        XCTAssertEqual(model.busy, false)
    }
}
