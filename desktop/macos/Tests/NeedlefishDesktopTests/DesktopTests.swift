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
        let runtime = try fixture("printf '%s' '\(json)'\nexit 1")
        let report = try await DesktopCLI(runtime: runtime).doctor(repo: URL(fileURLWithPath: "/test/project"), command: Command())
        XCTAssertEqual(report.repoAvailable, false)
        XCTAssertEqual(report.ready, false)
        XCTAssertEqual(report.checks[3].explanation, "無法讀取 Git 專案。請選擇正確資料夾。不會自動初始化或修改專案。 / Choose a Git project.")
    }
    func testMissingAuthAndUnknownCapabilityCannotBeReady() throws {
        for status in ["fail", "unknown"] {
            let json = doctorJSON.replacingOccurrences(of: #""auth","status":"ok""#, with: "\"auth\",\"status\":\"\(status)\"")
            let report = try JSONDecoder().decode(Doctor.self, from: Data(json.utf8)).validated()
            XCTAssertEqual(report.ready, false)
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
    func testBoundedReadRejectsExtraBytesAndPreservesExactOutput() throws {
        let root = try temporary()
        let file = root.appendingPathComponent("output")
        try Data("hello!".utf8).write(to: file)
        XCTAssertEqual(try readBounded(file, limit: 6), Data("hello!".utf8))
        XCTAssertThrowsError(try readBounded(file, limit: 5)) { error in
            XCTAssertEqual(error.localizedDescription, DesktopError.outputLimit.localizedDescription)
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
        let missing = doctorJSON.replacingOccurrences(of: #""repoRoot":"/test/project",""#, with: "")
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
        try Data(#"{"current":"../../user-project"}"#.utf8).write(to: root.appendingPathComponent("receipt.json"))
        XCTAssertThrowsError(try InstallationStore(root: root).uninstall())
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
