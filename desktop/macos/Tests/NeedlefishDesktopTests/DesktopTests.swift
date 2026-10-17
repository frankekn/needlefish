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
    let doctorJSON = #"{"schemaVersion":1,"repoRoot":"/test/project","checks":[{"name":"node","status":"ok","detail":"v24"},{"name":"runner","status":"ok","detail":"codex"},{"name":"capability","status":"ok","detail":"repositoryRead"},{"name":"auth","status":"ok","detail":"logged in"},{"name":"git","status":"ok","detail":"repo"},{"name":"base","status":"ok","detail":"changes"}]}"#
    let scopeJSON = #"{"mode":"uncommitted","changedFiles":[{"path":"src/example.ts"}],"patchBytes":20,"untrackedSkipped":[]}"#
    func resultJSON(_ verdict: String) -> String {
        let severity = verdict == "pass" ? "P3" : "P2"
        return "{\"schemaVersion\":1,\"verdict\":\"\(verdict)\",\"summary\":\"Review complete\",\"findings\":[{\"severity\":\"\(severity)\",\"title\":\"Empty list fails\",\"file\":\"example.ts\",\"lineStart\":8,\"whyItBreaks\":\"Missing first item\",\"suggestedFix\":\"Check the list\"}],\"residualRisks\":[]}"
    }
    func testDoctorUsesSharedJSONAndExactArguments() async throws {
        let runtime = try fixture("[ \"$*\" = 'doctor --repo /test/project --runner codex --json' ] || exit 3\nprintf '%s' '\(doctorJSON)'")
        let report = try await DesktopCLI(runtime: runtime).doctor(repo: URL(fileURLWithPath: "/test/project"), command: Command())
        XCTAssertEqual(report.checks.map(\.name), ["node", "runner", "capability", "auth", "git", "base"])
        XCTAssertEqual(report.ready, true)
    }
    func testNotRepoDoesNotInitializeProject() async throws {
        let json = doctorJSON.replacingOccurrences(of: #""git","status":"ok""#, with: #""git","status":"fail""#)
            .replacingOccurrences(of: #""repoRoot":"/test/project","#, with: "")
        let runtime = try fixture("printf '%s' '\(json)'\nexit 1")
        let report = try await DesktopCLI(runtime: runtime).doctor(repo: URL(fileURLWithPath: "/test/project"), command: Command())
        XCTAssertEqual(report.repoAvailable, false)
        XCTAssertEqual(report.ready, false)
        XCTAssertEqual(report.checks.first { $0.name == "git" }?.explanation, "無法讀取 Git 專案。請選擇正確資料夾。不會自動初始化或修改專案。 / Choose a Git project.")
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
        XCTAssertEqual(report.checks.first { $0.name == "base" }?.explanation, "此介面只檢查未提交變更，不需要分支基準。 / This view reviews uncommitted changes only; no branch base is required.")
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
    func testGroupSignalsReserveLeaderUntilFinalReap() async throws {
        for mode in ["normal", "failed", "signal", "timeout", "cancel"] {
            let runtime = try fixture(mode == "normal" ? "exit 0" : mode == "failed" ? "exit 7" : mode == "signal" ? "kill -KILL $$" : "sleep 120")
            let observations = SignalObservations()
            let command = Command { group, signal in
                var info = siginfo_t()
                let observed = waitid(P_PID, id_t(-group), &info, WEXITED | WNOHANG | WNOWAIT)
                observations.append(pid: -group, signal: signal, observed: observed, error: errno, exited: info.si_pid)
                guard observed == 0 else { return -1 }
                return kill(group, signal)
            }
            if mode == "cancel" { command.cancel() }
            let root = try temporary()
            do {
                let output = try await command.run(runtime.command([]), environment: ["PATH": "/bin:/usr/bin"],
                                                   temporary: root.appendingPathComponent("work"), timeout: mode == "timeout" ? 0.1 : 10)
                XCTAssertEqual(output.status, mode == "normal" ? 0 : mode == "failed" ? 7 : 137)
            } catch {
                XCTAssertEqual(error.localizedDescription, (mode == "cancel" ? DesktopError.cancelled : .timeout).localizedDescription)
                XCTAssertEqual(["cancel", "timeout"].contains(mode), true)
            }
            let signals = observations.values
            XCTAssertEqual(signals.last?.signal, SIGKILL)
            for observation in signals {
                XCTAssertEqual(observation.observed, 0, "\(mode) signal after leader lost; errno=\(observation.error)")
            }
            if let final = signals.last {
                XCTAssertEqual(final.exited, final.pid, "Final group signal must retain exited leader")
                var info = siginfo_t()
                let status = waitid(P_PID, id_t(final.pid), &info, WEXITED | WNOHANG | WNOWAIT)
                let error = errno
                XCTAssertEqual(status, -1)
                XCTAssertEqual(error, ECHILD)
            }
            XCTAssertEqual(fm.fileExists(atPath: root.appendingPathComponent("work").path), false)
        }
    }
    func testReviewRejectsUndeletableTemporaryWorkspace() async throws {
        let root = try temporary()
        let pathFile = root.appendingPathComponent("temporary-path")
        let runtime = try fixture("printf '%s' \"$TMPDIR\" > '\(pathFile.path)'\nprintf project-source > \"$TMPDIR/copied-project\"\nchflags uchg \"$TMPDIR/copied-project\"\nprintf '%s' '\(resultJSON("pass"))'")
        defer {
            if let path = try? String(contentsOf: pathFile, encoding: .utf8) {
                _ = chflags(path + "/copied-project", 0)
                try? fm.removeItem(atPath: path)
            }
        }
        do {
            _ = try await DesktopCLI(runtime: runtime).review(repo: URL(fileURLWithPath: "/project"), command: Command())
            XCTFail("Undeletable project copy must not produce a completed review")
        } catch {
            XCTAssertEqual(error.localizedDescription, "本次暫存資料未能清除，可能仍含專案副本。檢查未完成。 / Temporary cleanup failed; a project copy may remain. Review incomplete.")
            XCTAssertEqual(error.localizedDescription.contains(root.path), false)
        }
        let path = try String(contentsOf: pathFile, encoding: .utf8)
        XCTAssertEqual(try String(contentsOfFile: path + "/copied-project", encoding: .utf8), "project-source")
        XCTAssertEqual(chflags(path + "/copied-project", 0), 0)
        try fm.removeItem(atPath: path)
        XCTAssertEqual(fm.fileExists(atPath: path), false)
    }
    func testCleanupFailureOverridesCancellationTimeoutAndOutputFailure() async throws {
        for mode in ["cancel", "timeout", "output"] {
            let root = try temporary()
            let work = root.appendingPathComponent("work")
            let copied = work.appendingPathComponent("copied-project")
            let body = mode == "output" ? "head -c 9000000 /dev/zero" : "trap 'exit 0' TERM\nwhile :; do sleep 0.1; done"
            let runtime = try fixture("printf project-source > '\(copied.path)'\nchflags uchg '\(copied.path)'\n\(body)")
            defer { _ = chflags(copied.path, 0); try? fm.removeItem(at: work) }
            let command = Command()
            let task = Task { try await command.run(runtime.command([]), environment: ["PATH": "/bin:/usr/bin"],
                                                    temporary: work, timeout: mode == "timeout" ? 0.2 : 10) }
            for _ in 0..<100 {
                var attributes = stat()
                if lstat(copied.path, &attributes) == 0 && attributes.st_flags & UInt32(UF_IMMUTABLE) != 0 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            if mode == "cancel" { command.cancel() }
            do { _ = try await task.value; XCTFail("Cleanup failure must stay observable") }
            catch { XCTAssertEqual(error.localizedDescription, DesktopError.cleanup.localizedDescription) }
            XCTAssertEqual(try String(contentsOf: copied, encoding: .utf8), "project-source")
            XCTAssertEqual(chflags(copied.path, 0), 0)
            try fm.removeItem(at: work)
            XCTAssertEqual(fm.fileExists(atPath: work.path), false)
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
        for _ in 0..<50 {
            if kill(pid, 0) != 0 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let status = kill(pid, 0)
        let error = errno
        XCTAssertEqual(status, -1)
        XCTAssertEqual(error, ESRCH)
        XCTAssertEqual(delegate.applicationShouldTerminate(NSApplication.shared), .terminateNow)
    }

    func testCleanupFailureIsPresentedAsIncompleteInsteadOfResult() async throws {
        let fixture = DesktopTests()
        let root = try fixture.temporary()
        defer { try? FileManager.default.removeItem(at: root) }
        let pathFile = root.appendingPathComponent("temporary-path")
        let runtime = try fixture.fixture("if [ \"$1\" = doctor ]; then printf '%s' '\(fixture.doctorJSON)'; exit 0; fi\ncase \"$*\" in *--dry-run*) printf '%s' '\(fixture.scopeJSON)'; exit 0;; esac\nprintf '%s' \"$TMPDIR\" > '\(pathFile.path)'\nprintf project-source > \"$TMPDIR/copied-project\"\nchflags uchg \"$TMPDIR/copied-project\"\nprintf '%s' '\(fixture.resultJSON("pass"))'")
        defer {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent())
            if let path = try? String(contentsOf: pathFile, encoding: .utf8) {
                _ = chflags(path + "/copied-project", 0)
                try? FileManager.default.removeItem(atPath: path)
            }
        }
        let model = Onboarding(runtime: runtime)
        model.repo = URL(fileURLWithPath: "/project")
        model.diagnose()
        try await waitForIdle(model)
        model.prepare()
        try await waitForIdle(model)
        model.trusted = true
        model.accepted = true
        model.review()
        try await waitForIdle(model)
        guard case .message(let message) = model.state else { return XCTFail("Review must remain incomplete") }
        XCTAssertEqual(message, "本次暫存資料未能清除，可能仍含專案副本。檢查未完成。 / Temporary cleanup failed; a project copy may remain. Review incomplete.")
        XCTAssertEqual(message.contains(root.path), false)
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
                    XCTAssertEqual(report.checks.first { $0.name == "git" }?.explanation, "無法讀取 Git 專案。請選擇正確資料夾。不會自動初始化或修改專案。 / Choose a Git project.")
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
    func testOldGitDiagnosisExplainsUpgradeWithoutExposingRawDetails() async throws {
        let fixture = DesktopTests()
        let doctor = fixture.doctorJSON
            .replacingOccurrences(of: #""repoRoot":"/test/project","#, with: "")
            .replacingOccurrences(of: #"{"name":"git","status":"ok","detail":"repo"}"#,
                with: #"{"name":"git","status":"fail","detail":"git version 2.40.1; needlefish needs git 2.41 or later private-token /private/project","fix":"Upgrade git to 2.41 or later."}"#)
        let runtime = try fixture.fixture("printf '%s' '\(doctor)'\nexit 1")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let model = Onboarding(runtime: runtime)
        model.repo = URL(fileURLWithPath: "/selected/folder")
        model.diagnose()
        try await waitForIdle(model)
        guard case .diagnosis(let report) = model.state else { return XCTFail("Expected old Git diagnosis") }
        XCTAssertEqual(report.checks.first { $0.name == "git" }?.explanation, "Git 版本過舊。請升級至 Git 2.41 以上，再重新診斷。 / Upgrade Git to 2.41 or later, then check again.")
        XCTAssertEqual(report.scopeReady, false)
        XCTAssertEqual(model.repo?.path, "/selected/folder")
    }
    func testScopeCollectionFailureDoesNotSuggestLoginOrExposeStderr() async throws {
        let fixture = DesktopTests()
        let doctor = fixture.doctorJSON.replacingOccurrences(of: #""auth","status":"ok""#, with: #""auth","status":"fail""#)
        let runtime = try fixture.fixture("case \"$1\" in doctor) printf '%s' '\(doctor)';; *) printf '%s' 'capture limit exceeded private-token /private/project' >&2; exit 1;; esac")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let model = Onboarding(runtime: runtime)
        model.repo = URL(fileURLWithPath: "/project")
        model.diagnose()
        try await waitForIdle(model)
        model.prepare()
        try await waitForIdle(model)
        guard case .message(let text) = model.state else { return XCTFail("Expected incomplete collection") }
        XCTAssertEqual(text, "無法整理變更範圍。請重新診斷專案，或縮小本機變更後重試。 / Could not collect changes. Check the project again or reduce local changes and retry.")
        XCTAssertEqual(model.canReview, false)
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
        model.demo()
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

final class GithubSetupTests: XCTestCase {
    func testAnonymousInputPipeWritesExactBytesAndRemovesTemporaryDirectory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-github-input-" + UUID().uuidString)
        let input = Data(repeating: 65, count: 16_384)
        let result = try await Command().run(["/usr/bin/wc", "-c"], environment: ["PATH": "/usr/bin:/bin"],
                                            temporary: root, timeout: 5, input: input)
        XCTAssertEqual(result.status, 0)
        XCTAssertEqual(String(decoding: result.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines), "16384")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
    func testClosedChildInputDoesNotSignalTheApp() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-github-epipe-" + UUID().uuidString)
        do {
            _ = try await Command().run(["/bin/sh", "-c", "exec 0<&-; sleep 0.2"], environment: ["PATH": "/usr/bin:/bin"],
                                        temporary: root, timeout: 5, input: Data(repeating: 65, count: 100_000))
            XCTFail("Closed pipe must fail")
        } catch { XCTAssertEqual(error as? DesktopError, .command) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
    func testInputWriterCanBeCancelledWithoutAReader() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-github-cancel-" + UUID().uuidString)
        let command = Command()
        let task = Task {
            try await command.run(["/bin/sleep", "30"], environment: ["PATH": "/usr/bin:/bin"], temporary: root,
                                  timeout: 30, input: Data(repeating: 65, count: 100_000))
        }
        try await Task.sleep(for: .milliseconds(150))
        command.cancel()
        do { _ = try await task.value; XCTFail("Must cancel") }
        catch { XCTAssertEqual(error as? DesktopError, .cancelled) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
    func testSuccessfulChildCannotSilentlyDropInput() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-github-short-input-" + UUID().uuidString)
        do {
            _ = try await Command().run(["/usr/bin/true"], environment: ["PATH": "/usr/bin:/bin"], temporary: root,
                                        timeout: 5, input: Data(repeating: 65, count: 100_000))
            XCTFail("Incomplete input must fail")
        } catch { XCTAssertEqual(error as? DesktopError, .command) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
    func testGitHubDeviceCodeDoesNotConfuseCodexLogin() {
        XCTAssertEqual(githubDeviceCode("! First copy your one-time code: AB12-CD34\nhttps://github.com/login/device"), "AB12-CD34")
        XCTAssertNil(githubDeviceCode("AB12-CD34"))
        XCTAssertNil(githubDeviceCode("password: controlled-placeholder"))
    }
    func testSetupProtocolCannotClaimCredentialMetadataAsAuthentication() throws {
        let json = #"{"schemaVersion":1,"repository":"owner/repo","admin":true,"actions":true,"phase":"merged","conflict":null,"secret":"present","authentication":"unknown","firstReview":"not_verified","prUrl":null,"workflow":"test","disclosure":"test","settingsUrl":"https://github.com/owner/repo/settings/actions","removal":"test"}"#
        let report = try JSONDecoder().decode(GithubSetupStatus.self, from: Data(json.utf8)).validated()
        XCTAssertEqual(report.phase, .merged)
        for bad in [json.replacingOccurrences(of: "unknown", with: "passed"), json.replacingOccurrences(of: "not_verified", with: "completed"), json.replacingOccurrences(of: "https://github.com/owner/repo/settings/actions", with: "https://attacker.invalid")] {
            XCTAssertThrowsError(try JSONDecoder().decode(GithubSetupStatus.self, from: Data(bad.utf8)).validated())
        }
    }
}

@MainActor
final class GithubSetupOwnershipTests: XCTestCase {
    func testGitHubOperationPreservesOfflineDemoAndDiagnosticExport() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-github-local-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let script = root.appendingPathComponent("cli")
        let ready = root.appendingPathComponent("ready")
        let release = root.appendingPathComponent("release")
        let calls = root.appendingPathComponent("calls")
        try """
        printf '%s\n' "$*" >> '\(calls.path)'
        printf ready > '\(ready.path)'
        while [ ! -f '\(release.path)' ]; do sleep 0.01; done
        printf '%s' '{"schemaVersion":1,"repositories":[{"name":"owner/offline-fixture"}]}'
        """.write(to: script, atomically: true, encoding: .utf8)
        let model = Onboarding(runtime: Runtime(node: "/bin/sh", cli: script.path, codex: "/usr/bin/true", git: "/usr/bin/git", development: true))
        model.githubSetup.load()
        defer { model.cancel() }
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: ready.path) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(try String(contentsOf: ready, encoding: .utf8), "ready")
        XCTAssertEqual(model.busy, true)
        XCTAssertEqual(model.localBusy, false)
        model.demo()
        if case .result(let result, let demo) = model.state {
            XCTAssertEqual(demo, true)
            XCTAssertEqual(result.summary, "離線範例。沒有讀取你的專案，也沒有呼叫 AI。 / Offline example. Your project was not reviewed.")
        } else { XCTFail("Offline demo must remain available during GitHub setup") }
        let destination = root.appendingPathComponent("diagnostics.txt")
        model.saveDiagnostics("diagnostic preview", to: destination)
        XCTAssertEqual(try? String(contentsOf: destination, encoding: .utf8), "diagnostic preview")
        if case .message(let message) = model.state {
            XCTAssertEqual(message, "已匯出診斷。 / Diagnostics exported.")
        } else { XCTFail("Diagnostic export must report its result during GitHub setup") }
        model.login()
        XCTAssertEqual(try String(contentsOf: calls, encoding: .utf8), "setup github repositories --json\n")
        XCTAssertEqual(model.githubSetup.busy, true)
        XCTAssertEqual(model.canCancel, true)
        try "release".write(to: release, atomically: true, encoding: .utf8)
        for _ in 0..<100 {
            if !model.busy { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.busy, false)
        if case .repositories(let repositories) = model.githubSetup.state {
            XCTAssertEqual(repositories.map(\.name), ["owner/offline-fixture"])
        } else { XCTFail("Local actions must not cancel or replace GitHub setup") }
        if case .message(let message) = model.state {
            XCTAssertEqual(message, "已匯出診斷。 / Diagnostics exported.")
        } else { XCTFail("GitHub completion must preserve the independent local result") }
    }
    func testGitHubCommandMakesParentBusyAndQuitCancelsItsOwnedGroup() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-github-owner-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let script = root.appendingPathComponent("cli")
        try "sleep 30\n".write(to: script, atomically: true, encoding: .utf8)
        let runtime = Runtime(node: "/bin/sh", cli: script.path, codex: "/usr/bin/true", git: "/usr/bin/git", development: true)
        let model = Onboarding(runtime: runtime)
        model.githubSetup.load()
        XCTAssertTrue(model.busy)
        XCTAssertTrue(model.canCancel)
        model.cancel()
        for _ in 0..<100 {
            if !model.canCancel { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTAssertFalse(model.busy)
        XCTAssertFalse(model.canCancel)
        guard case .error(let message) = model.githubSetup.state else { return XCTFail("Cancellation must be visible") }
        XCTAssertEqual(message, DesktopError.cancelled.localizedDescription)
    }
}

private final class SignalObservations: @unchecked Sendable {
    struct Observation {
        let pid: pid_t
        let signal: Int32
        let observed: Int32
        let error: Int32
        let exited: pid_t
    }
    private let lock = NSLock()
    private var stored: [Observation] = []
    var values: [Observation] { lock.withLock { stored } }
    func append(pid: pid_t, signal: Int32, observed: Int32, error: Int32, exited: pid_t) {
        lock.withLock { stored.append(Observation(pid: pid, signal: signal, observed: observed, error: error, exited: exited)) }
    }
}

@MainActor
final class GithubCredentialBoundaryTests: XCTestCase {
    func testConflictBlocksCredentialCommandAndKnownSetupAcceptsStdin() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-github-boundary-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let json = #"{"schemaVersion":1,"repository":"owner/repo","admin":true,"actions":true,"phase":"preview","conflict":null,"secret":"present","authentication":"unknown","firstReview":"not_verified","prUrl":null,"workflow":"test","disclosure":"test","settingsUrl":"https://github.com/owner/repo/settings/actions","removal":"test"}"#
        let ready = try JSONDecoder().decode(GithubSetupStatus.self, from: Data(json.utf8)).validated()
        let conflicted = try JSONDecoder().decode(GithubSetupStatus.self, from: Data(json.replacingOccurrences(of: "\"preview\"", with: "\"conflict\"").replacingOccurrences(of: "\"conflict\":null", with: "\"conflict\":\"Unrecognized workflow\"").utf8)).validated()
        let script = root.appendingPathComponent("cli")
        let input = root.appendingPathComponent("synthetic-input")
        try "[ \"$*\" = 'setup github set-secret --repository owner/repo --json --confirm --replace-secret' ] || exit 3\ncat > '\(input.path)'\nprintf '%s' '\(json)'\n".write(to: script, atomically: true, encoding: .utf8)
        let model = GithubSetup(runtime: Runtime(node: "/bin/sh", cli: script.path, codex: "/usr/bin/true", git: "/usr/bin/git", development: true))
        model.state = .status(conflicted)
        model.consent = true
        model.replace = true
        model.credential = "controlled-test-input"
        model.secret(conflicted)
        XCTAssertFalse(model.busy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: input.path))
        model.state = .status(ready)
        model.secret(ready)
        for _ in 0..<100 {
            if !model.busy { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTAssertEqual(try String(contentsOf: input, encoding: .utf8), "controlled-test-input")
        XCTAssertEqual(model.credential, "")
        guard case .status(let result) = model.state else { return XCTFail("Known setup must accept the separate secret action") }
        XCTAssertEqual(result.secret, "present")
        XCTAssertEqual(result.authentication, "unknown")
    }
}

@MainActor
final class AdvancedConnectionsTests: XCTestCase {
    let fixture = DesktopTests()
    func ownedTemporary() throws -> URL {
        let root = try fixture.temporary()
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    func cliFixture(_ body: String) throws -> Runtime {
        let runtime = try fixture.fixture(body)
        let root = URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return runtime
    }
    let raw = #"{"version":1,"connections":[{"id":"agent","adapter":"acp","model":"requested-model","launch":{"command":"/test/agent","args":["--model","{model}"]},"auth":{"env":{"AGENT_TOKEN":"SHARED_TOKEN"}}},{"id":"proxy","adapter":"codex","model":"requested-model","auth":{"route":{"kind":"cliproxyapi","baseUrl":"http://localhost:1234/v1"},"env":{"CODEX_PROXY_API_KEY":"SHARED_TOKEN"}}}]}"#
    func response(_ json: String) throws -> ConnectionsResponse { try JSONDecoder().decode(ConnectionsResponse.self, from: Data(json.utf8)).validated(status: 0) }
    func loaded() throws -> AdvancedConnections {
        let model = AdvancedConnections()
        try model.load(response("{\"schemaVersion\":1,\"ok\":true,\"baseRevision\":\"sha256:old\",\"document\":\(raw)}"))
        return model
    }
    func row(_ id: String, readiness: String = "local-available") -> String {
        "{\"id\":\"\(id)\",\"adapter\":\"codex\",\"requestedModel\":\"requested-model\",\"route\":\"cliproxyapi\",\"credentialSource\":\"reference-configured\",\"providerAccount\":\"unknown\",\"authentication\":\"unknown\",\"readiness\":\"\(readiness)\",\"qualification\":\"unqualified\"}"
    }
    func inspect(_ model: AdvancedConnections, readiness: String = "local-available") throws {
        try model.inspected(response("{\"schemaVersion\":1,\"ok\":true,\"revision\":\"sha256:old\",\"connections\":[\(model.selection.map { row($0, readiness: readiness) }.joined(separator: ","))]}"))
    }
    func testRawDraftPreservesPlaceholderRouteAndSourceNames() throws {
        let model = try loaded()
        model.change(.init(id: "extra", adapter: "codex", model: "other"), replacing: nil)
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: model.request("apply")) as? [String: Any])
        XCTAssertEqual(request["expectedRevision"] as? String, "sha256:old")
        let doc = try XCTUnwrap(request["document"] as? [String: Any])
        let profiles = try XCTUnwrap(doc["connections"] as? [[String: Any]])
        XCTAssertEqual((profiles[0]["launch"] as? [String: Any])?["args"] as? [String], ["--model", "{model}"])
        XCTAssertEqual((profiles[0]["auth"] as? [String: Any])?["env"] as? [String: String], ["AGENT_TOKEN": "SHARED_TOKEN"])
        XCTAssertNil((profiles[0]["auth"] as? [String: Any])?["kind"])
        XCTAssertEqual(model.selection, [])
    }
    func testConflictRetainsDraftRequiresReloadAndExplicitReapply() throws {
        let model = try loaded()
        model.change(.init(id: "new", adapter: "codex", model: "other"), replacing: nil)
        model.failed(ConnectionsFailure(code: "revision_conflict"))
        XCTAssertEqual(model.document.connections.map(\.id), ["agent", "proxy", "new"])
        XCTAssertEqual(model.draftState, .conflict)
        XCTAssertThrowsError(try model.request("apply"))
        try model.load(response("{\"schemaVersion\":1,\"ok\":true,\"baseRevision\":\"sha256:new\",\"document\":\(raw)}"))
        XCTAssertEqual(model.document.connections.map(\.id), ["agent", "proxy"])
        model.reapply()
        XCTAssertEqual(model.document.connections.map(\.id), ["agent", "proxy", "new"])
        XCTAssertEqual(model.baseRevision, "sha256:new")
        XCTAssertTrue(model.dirty)
    }
    func testOrderDistinctReferencesAndDeletionInvalidateReadiness() throws {
        let model = try loaded()
        model.select("proxy"); model.select("agent"); model.select("proxy")
        XCTAssertEqual(model.selection, ["proxy", "agent"])
        XCTAssertEqual(model.sourceRefs, ["SHARED_TOKEN"])
        model.move("agent", by: -1)
        XCTAssertEqual(model.selection, ["agent", "proxy"])
        model.budget = "1000"
        model.credentialMode = "session"; model.secrets["SHARED_TOKEN"] = "offline-only-value"
        try inspect(model)
        XCTAssertTrue(model.ready)
        model.delete("agent")
        XCTAssertEqual(model.selection, ["proxy"])
        XCTAssertNil(model.inspection)
        XCTAssertFalse(model.ready)
    }
    func testDeletedAndDuplicateNamesCannotProduceReadyReview() throws {
        let model = try loaded()
        model.select("absent")
        XCTAssertFalse(model.validSelection)
        model.remove("absent")
        model.select("proxy")
        model.change(.init(id: "proxy", adapter: "codex", model: "duplicate"), replacing: nil)
        XCTAssertTrue(model.dirty)
        XCTAssertFalse(model.ready)
    }
    func testUnknownAuthIsNotLoginButKnownLocalBlockCannotStart() throws {
        let model = try loaded(); model.select("proxy"); model.budget = "1000"
        try inspect(model, readiness: "local-blocked")
        XCTAssertFalse(model.ready)
        try inspect(model)
        XCTAssertFalse(model.ready)
        XCTAssertEqual(model.inspection?.first?.authentication, "unknown")
        model.credentialMode = "session"
        XCTAssertFalse(model.ready)
        model.secrets["SHARED_TOKEN"] = "offline-only-value"
        XCTAssertTrue(model.ready)
        model.clearSecrets()
        XCTAssertFalse(model.ready)
    }
    func testBudgetIsExplicitBoundedAndConfigurationFailuresAreCanned() throws {
        let model = try loaded()
        XCTAssertNil(model.budgetMs)
        for value in ["0", "-1", "2147483648", "not-a-number"] { model.budget = value; XCTAssertNil(model.budgetMs) }
        model.budget = "2147483647"; XCTAssertEqual(model.budgetMs, 2147483647)
        model.failed(ConnectionsFailure(code: "configuration_unavailable"))
        XCTAssertEqual(model.message, ConnectionsFailure(code: "configuration_unavailable").localizedDescription)
    }
    func testInspectionMustMatchExactRevisionAndOrder() throws {
        let model = try loaded(); model.select("proxy"); model.select("agent")
        for (revision, ids) in [("sha256:new", ["proxy", "agent"]), ("sha256:old", ["agent", "proxy"])] {
            let json = "{\"schemaVersion\":1,\"ok\":true,\"revision\":\"\(revision)\",\"connections\":[\(ids.map { row($0) }.joined(separator: ","))]}"
            XCTAssertThrowsError(try model.inspected(response(json)))
        }
        XCTAssertNil(model.inspection)
    }
    func testExistingReviewFailuresKeepTheirStructuredRecovery() async throws {
        for mode in ["existing", "session"] {
            for code in ["revision_conflict", "invalid_request"] {
                let runtime = try cliFixture("cat >/dev/null; printf '%s' '{\"schemaVersion\":1,\"ok\":false,\"code\":\"\(code)\"}'; exit 1")
                do {
                    _ = try await DesktopCLI(runtime: runtime).connectionReview(repo: URL(fileURLWithPath: "/project"), revision: "old", ids: ["proxy"], budgetMs: 1000, mode: mode, sources: [:], command: Command())
                    XCTFail("Structured failure must stay incomplete")
                } catch let error as ConnectionsFailure {
                    XCTAssertEqual(error.code, code)
                } catch { XCTFail("Expected structured recovery, got \(error)") }
            }
        }
    }
    func testBlockedInspectionStaysEditableUntilRunnerIsAvailable() async throws {
        let root = try ownedTemporary()
        let blocked = root.appendingPathComponent("blocked")
        try Data().write(to: blocked)
        let doctor = #"{"schemaVersion":1,"repoRoot":"/project","checks":[{"name":"node","status":"ok","detail":"offline"},{"name":"runner","status":"ok","detail":"offline"},{"name":"capability","status":"ok","detail":"offline"},{"name":"auth","status":"ok","detail":"offline"},{"name":"git","status":"ok","detail":"offline"},{"name":"base","status":"ok","detail":"offline"}]}"#
        let runtime = try cliFixture("""
        if [ "$1" = doctor ]; then printf '%s' '\(doctor)'
        elif [ "$1" = connections ]; then
          cat >/dev/null
          if [ -f '\(blocked.path)' ]; then printf '%s' '{"schemaVersion":1,"ok":true,"revision":"sha256:old","connections":[\(row("proxy", readiness: "local-blocked"))]}'
          else printf '%s' '{"schemaVersion":1,"ok":true,"revision":"sha256:old","connections":[\(row("proxy"))]}'
          fi
        else printf '%s' '{"mode":"uncommitted","changedFiles":[{"path":"app.ts"}],"patchBytes":42,"untrackedSkipped":[]}'
        fi
        """)
        let owner = Onboarding(runtime: runtime)
        owner.repo = URL(fileURLWithPath: "/project")
        try owner.connections.load(response("{\"schemaVersion\":1,\"ok\":true,\"baseRevision\":\"sha256:old\",\"document\":\(raw)}"))
        owner.connections.select("proxy"); owner.connections.budget = "1000"
        owner.connections.credentialMode = "session"; owner.connections.secrets["SHARED_TOKEN"] = "offline-only-value"
        owner.prepareConnections()
        for _ in 0..<100 {
            if !owner.busy { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard case .message(let message) = owner.state else { return XCTFail("Blocked connection must not enter consent") }
        XCTAssertTrue(message.contains("proxy")); XCTAssertTrue(message.contains("local-blocked"))
        XCTAssertEqual(owner.connections.draftState, .editing)
        XCTAssertFalse(owner.canReview)
        try FileManager.default.removeItem(at: blocked)
        owner.prepareConnections()
        for _ in 0..<100 {
            if !owner.busy { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard case .consent = owner.state else { return XCTFail("Available runner must permit consent") }
        owner.trusted = true; owner.accepted = true
        XCTAssertTrue(owner.canReview)
        XCTAssertNil(owner.connections.message)
        XCTAssertEqual(owner.connections.inspection?.first?.qualification, "unqualified")
    }
    func testNoviceScopeFailureDoesNotChangeAdvancedDraftOrSecrets() async throws {
        let runtime = try cliFixture("exit 1")
        let owner = Onboarding(runtime: runtime)
        owner.repo = URL(fileURLWithPath: "/project")
        try owner.connections.load(response("{\"schemaVersion\":1,\"ok\":true,\"baseRevision\":\"sha256:old\",\"document\":\(raw)}"))
        owner.connections.message = "existing advanced message"
        owner.connections.secrets["SHARED_TOKEN"] = "offline-only-value"
        owner.prepare()
        for _ in 0..<100 {
            if !owner.busy { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard case .message = owner.state else { return XCTFail("Failed novice command must report incomplete") }
        XCTAssertEqual(owner.connections.message, "existing advanced message")
        XCTAssertEqual(owner.connections.secrets["SHARED_TOKEN"], "offline-only-value")
        XCTAssertEqual(owner.connections.document.connections.map(\.id), ["agent", "proxy"])
    }
    func testSessionReviewUsesOnlyBoundedAnonymousInputAndExactContract() async throws {
        let root = try ownedTemporary()
        let capture = root.appendingPathComponent("fake-input.json")
        let runtime = try cliFixture("[ \"$*\" = 'connections review --json' ] || exit 3\ncat > '\(capture.path)'\nprintf '%s' '\(fixture.resultJSON("needs_human"))'")
        let result = try await DesktopCLI(runtime: runtime).connectionReview(repo: URL(fileURLWithPath: "/project"), revision: "sha256:exact", ids: ["proxy", "agent"], budgetMs: 1200, mode: "session", sources: ["SHARED_TOKEN": "offline-only-value"], command: Command())
        XCTAssertEqual(result.verdict.rawValue, "needs_human")
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: capture)) as? [String: Any])
        XCTAssertEqual(Set(request.keys), Set(["repo", "scope", "expectedRevision", "ids", "budgetMs", "credentialMode", "sources"]))
        XCTAssertEqual(request["repo"] as? String, "/project")
        XCTAssertEqual(request["scope"] as? String, "local-uncommitted")
        XCTAssertEqual(request["ids"] as? [String], ["proxy", "agent"])
        XCTAssertEqual(request["sources"] as? [String: String], ["SHARED_TOKEN": "offline-only-value"])
        XCTAssertEqual(request["budgetMs"] as? Int, 1200)
        XCTAssertNil(runtime.environment(temporary: root)["SHARED_TOKEN"])
    }
    func testNonzeroMalformedAndEchoedSessionOutputRemainIncomplete() async throws {
        let secret = "offline-only-value"
        for body in ["cat >/dev/null; printf '%s' '\(fixture.resultJSON("pass"))'; exit 1", "cat >/dev/null; printf invalid", "cat >/dev/null; printf '%s' '\(fixture.resultJSON("pass"))'; printf '\(secret)' >&2"] {
            let runtime = try cliFixture(body)
            do {
                _ = try await DesktopCLI(runtime: runtime).connectionReview(repo: URL(fileURLWithPath: "/project"), revision: "missing", ids: ["proxy"], budgetMs: 1000, mode: "session", sources: ["SHARED_TOKEN": secret], command: Command())
                XCTFail("Must remain incomplete")
            } catch { XCTAssertFalse(error.localizedDescription.contains(secret)) }
        }
    }
    func testOversizeInputIsRejectedBeforeSpawn() async throws {
        let root = try ownedTemporary()
        let marker = root.appendingPathComponent("spawned")
        let runtime = try cliFixture("touch '\(marker.path)'")
        do {
            _ = try await Command().run(runtime.command([]), environment: [:], temporary: root.appendingPathComponent("invocation"), timeout: 1, input: Data(repeating: 65, count: 131073))
            XCTFail("Must reject input")
        } catch { XCTAssertEqual(error as? DesktopError, .invalidOutput) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    }
    func testInputSentCallbackHappensBeforeResult() async throws {
        let root = try ownedTemporary()
        let marker = root.appendingPathComponent("sent")
        let runtime = try cliFixture("cat >/dev/null\nsleep 0.2\n[ -f '\(marker.path)' ] || exit 3\nprintf completed")
        let output = try await DesktopCLI(runtime: runtime).call([], command: Command(), input: Data("{}".utf8), inputSent: { try? Data("cleared".utf8).write(to: marker) })
        XCTAssertEqual(output.status, 0)
        XCTAssertEqual(String(decoding: output.stdout, as: UTF8.self), "completed")
    }
    func testNoviceReadyIsUnchangedAndAdvancedChangesInvalidateConsent() throws {
        let owner = Onboarding(runtime: nil)
        owner.trusted = true; owner.accepted = true
        XCTAssertFalse(owner.canReview)
        owner.consentUsesConnections = true
        owner.state = .consent(try JSONDecoder().decode(Scope.self, from: Data(fixture.scopeJSON.utf8)))
        owner.invalidateConnectionConsent()
        XCTAssertFalse(owner.trusted)
        XCTAssertFalse(owner.accepted)
        guard case .message = owner.state else { return XCTFail("Must require a new inspection") }
    }
}

final class AdvancedInputDeadlineTests: XCTestCase {
    func testUnreadInputHasItsOwnDeadlineAndLeavesNoGroup() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("nf-advanced-input-deadline-" + UUID().uuidString)
        let started = Date()
        do {
            _ = try await Command().run(["/bin/sleep", "30"], environment: [:], temporary: root, timeout: 30,
                                        input: Data(repeating: 65, count: 131072))
            XCTFail("Unread input must time out")
        } catch { XCTAssertEqual(error as? DesktopError, .timeout) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
}

@MainActor
final class AdvancedBoundaryRegressionTests: XCTestCase {
    func testCurrentSixCheckDoctorContractIsAcceptedAndCapabilityStillGates() throws {
        let fixture = DesktopTests()
        let json = fixture.doctorJSON
        let report = try JSONDecoder().decode(Doctor.self, from: Data(json.utf8)).validated()
        XCTAssertTrue(report.ready)
        let unknown = json.replacingOccurrences(of: #""capability","status":"ok""#, with: #""capability","status":"unknown""#)
        let unavailable = try JSONDecoder().decode(Doctor.self, from: Data(unknown.utf8)).validated()
        XCTAssertFalse(unavailable.ready)
        XCTAssertFalse(unavailable.scopeReady)
    }
    func testKnownMissingAmbientCodexBlocksWithoutTreatingUnknownAsLogin() async throws {
        let fixture = DesktopTests()
        for status in ["fail", "unknown"] {
            let json = fixture.doctorJSON.replacingOccurrences(of: #""auth","status":"ok""#, with: "\"auth\",\"status\":\"\(status)\"")
            let runtime = try fixture.fixture("printf '%s' '\(json)'")
            addTeardownBlock { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
            let owner = Onboarding(runtime: runtime)
            owner.repo = URL(fileURLWithPath: "/test/project")
            owner.diagnose()
            for _ in 0..<100 {
                if !owner.busy { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            guard case .diagnosis = owner.state else { return XCTFail("Expected the current doctor contract") }
            let document = #"{"schemaVersion":1,"ok":true,"baseRevision":"missing","document":{"version":1,"connections":[{"id":"native","adapter":"codex","model":"requested-model"}]}}"#
            try owner.connections.load(JSONDecoder().decode(ConnectionsResponse.self, from: Data(document.utf8)).validated(status: 0))
            owner.connections.select("native")
            owner.consentUsesConnections = true
            XCTAssertEqual(owner.knownMissingAmbientCodexAuth, status == "fail")
            owner.connections.credentialMode = "session"
            XCTAssertFalse(owner.knownMissingAmbientCodexAuth)
        }
    }
    func testConflictFreezesProfileDraftUntilReload() throws {
        let model = try AdvancedConnectionsTests().loaded()
        model.change(.init(id: "retained", adapter: "codex", model: "requested"), replacing: nil)
        model.failed(ConnectionsFailure(code: "revision_conflict"))
        model.change(.init(id: "lost-edit", adapter: "codex", model: "requested"), replacing: nil)
        model.delete("agent")
        XCTAssertEqual(model.document.connections.map(\.id), ["agent", "proxy", "retained"])
        XCTAssertEqual(model.draftState, .conflict)
    }
    func testAmbiguousApplyRequiresReloadButValidationFailureDoesNot() async throws {
        let fixture = DesktopTests()
        for (scenario, tail) in [
            ("malformed", "printf truncated"),
            ("missing_fields", "printf '%s' '{\"schemaVersion\":1,\"ok\":true}'"),
            ("unknown_code", "printf '%s' '{\"schemaVersion\":1,\"ok\":false,\"code\":\"unrecognized\"}'"),
            ("nonzero", "exit 1"), ("cancelled", "sleep 30"),
            ("validation", "printf '%s' '{\"schemaVersion\":1,\"ok\":false,\"code\":\"invalid_configuration\"}'; exit 1")
        ] {
            let root = try fixture.temporary()
            addTeardownBlock { try? FileManager.default.removeItem(at: root) }
            let marker = root.appendingPathComponent("committed")
            let body = "cat >/dev/null; " + (scenario == "validation" ? "" : "printf committed > '\(marker.path)'; ") + tail
            let runtime = try fixture.fixture(body)
            addTeardownBlock { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
            let command = Command()
            let model = try AdvancedConnectionsTests().loaded()
            model.change(.init(id: "retained", adapter: "codex", model: "requested"), replacing: nil)
            let input = try model.request("apply")
            let task = Task { try await DesktopCLI(runtime: runtime).connections("apply", repo: root, command: command, input: input) }
            if scenario == "cancelled" {
                for _ in 0..<100 {
                    if FileManager.default.fileExists(atPath: marker.path) { break }
                    try await Task.sleep(for: .milliseconds(20))
                }
                XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "committed")
                command.cancel()
            }
            do { _ = try await task.value; XCTFail("Must remain an incomplete save") }
            catch {
                model.failed(error)
                XCTAssertEqual((error as? ConnectionsFailure)?.code, scenario == "validation" ? "invalid_configuration" : "save_state_unknown")
            }
            XCTAssertEqual(model.draftState, scenario == "validation" ? .editing : .reloadRequired)
            XCTAssertEqual(model.document.connections.map(\.id), ["agent", "proxy", "retained"])
            if scenario != "validation" { XCTAssertThrowsError(try model.request("apply")) }
        }
    }
    func testApplyDescriptorIdentityMustMatchWholeDraftBeforeSavedState() throws {
        let maker = AdvancedConnectionsTests()
        for ids in [[], ["agent"], ["proxy", "agent"], ["agent", "agent"], ["agent", "proxy", "extra"], ["agent", "proxy"]] {
            let model = try maker.loaded()
            var profile = model.document.connections[1]
            profile.model = "updated-model"
            model.change(profile, replacing: "proxy")
            let json = "{\"schemaVersion\":1,\"ok\":true,\"revision\":\"sha256:new\",\"connections\":[\(ids.map { maker.row($0) }.joined(separator: ","))]}"
            let response = try maker.response(json)
            if ids == ["agent", "proxy"] {
                try model.saved(response)
                XCTAssertEqual(model.baseRevision, "sha256:new")
                XCTAssertFalse(model.dirty)
            } else {
                do { try model.saved(response); XCTFail("Partial descriptor success must remain unknown") }
                catch {
                    XCTAssertEqual((error as? ConnectionsFailure)?.code, "save_state_unknown")
                    model.failed(error)
                }
                XCTAssertEqual(model.baseRevision, "sha256:old")
                XCTAssertEqual(model.draftState, .reloadRequired)
                XCTAssertTrue(model.dirty)
            }
            XCTAssertEqual(model.document.connections.map(\.id), ["agent", "proxy"])
            XCTAssertEqual(model.document.connections[1].model, "updated-model")
        }
    }
    func testPercentEncodedCredentialsCannotReachRawOrDisplayedOutput() async throws {
        let fixture = DesktopTests()
        for (secret, variants) in [
            ("token/part", ["token%2Fpart", "token%2fpart", "%74oken%2Fpart", "to%6ben%2fpart", #"token\u00252Fpart"#, "%GG token%2Fpart %", "%fftoken%2Fpart"]),
            ("鑰/匙", ["%E9%91%B0%2f%E5%8C%99", "%GG %e9%91%b0/%e5%8c%99 %"])
        ] {
            for variant in variants {
                for channel in ["summary", "stderr"] {
                    if channel == "stderr" && variant.contains(#"\u0025"#) { continue }
                    let root = try fixture.temporary()
                    defer { try? FileManager.default.removeItem(at: root) }
                    let input = root.appendingPathComponent("input.json")
                    let json = fixture.resultJSON("pass").replacingOccurrences(of: "Review complete", with: channel == "summary" ? variant : "Safe complete result")
                    let body = "cat > '\(input.path)'; printf '%s' '\(json)'" + (channel == "stderr" ? "; printf '%s' '\(variant)' >&2" : "")
                    let runtime = try fixture.fixture(body)
                    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
                    do {
                        _ = try await DesktopCLI(runtime: runtime).connectionReview(repo: root, revision: "missing", ids: ["proxy"], budgetMs: 1000, mode: "session", sources: ["SHARED_TOKEN": secret], command: Command())
                        XCTFail("Encoded credential accepted in \(channel): \(variant)")
                    } catch { XCTAssertEqual(error as? DesktopError, .invalidOutput) }
                    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: input)) as? [String: Any])
                    XCTAssertEqual(request["sources"] as? [String: String], ["SHARED_TOKEN": secret])
                }
            }
        }
        let runtime = try fixture.fixture("cat >/dev/null; printf '%s' '\(fixture.resultJSON("pass").replacingOccurrences(of: "Review complete", with: "Valid URL https://example.test/a%2fb %GG 鑰匙"))'")
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        let valid = try await DesktopCLI(runtime: runtime).connectionReview(repo: URL(fileURLWithPath: "/project"), revision: "missing", ids: ["proxy"], budgetMs: 1000, mode: "session", sources: ["SHARED_TOKEN": "token/part"], command: Command())
        XCTAssertEqual(valid.summary, "Valid URL https://example.test/a%2fb %GG 鑰匙")
        XCTAssertEqual(valid.verdict.rawValue, "pass")
    }
    func testMixedOrUnknownApplyEnvelopesRequireReloadAndRetainDraft() async throws {
        let fixture = DesktopTests()
        let maker = AdvancedConnectionsTests()
        let success = "\"schemaVersion\":1,\"ok\":true,\"revision\":\"sha256:new\",\"connections\":[\(maker.row("agent")),\(maker.row("proxy")),\(maker.row("retained"))]"
        let failure = #""schemaVersion":1,"ok":false,"code":"invalid_configuration""#
        let extraFields = [#""revision":null"#, #""revision":"sha256:new""#, #""connections":null"#, #""connections":[]"#, #""baseRevision":null"#, #""baseRevision":"missing""#, #""document":null"#, #""document":{"version":1,"connections":[]}"#, #""unexpected":null"#]
        let bodies = extraFields.map { "{" + failure + "," + $0 + "}" } + [
            "{" + success + #","code":null}"#, "{" + success + #","code":"cancelled"}"#,
            "{" + success + #","issues":null}"#, "{" + success + #","issues":[]}"#,
            "{" + success + #","unexpected":null}"#, "{" + success + #","baseRevision":null}"#,
            #"{"schemaVersion":1,"ok":false,"code":"cancelled","connections":null}"#
        ]
        for json in bodies {
            let runtime = try fixture.fixture("cat >/dev/null; printf '%s' '\(json)'")
            defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
            let model = try maker.loaded()
            model.change(.init(id: "retained", adapter: "codex", model: "unsaved-model"), replacing: nil)
            do {
                let response = try await DesktopCLI(runtime: runtime).connections("apply", repo: URL(fileURLWithPath: "/project"), command: Command(), input: model.request("apply"))
                try model.saved(response)
                XCTFail("Mixed envelope accepted: \(json)")
            } catch {
                XCTAssertEqual((error as? ConnectionsFailure)?.code, "save_state_unknown", json)
                model.failed(error)
            }
            XCTAssertEqual(model.draftState, .reloadRequired, json)
            XCTAssertEqual(model.document.connections.map(\.id), ["agent", "proxy", "retained"])
            XCTAssertEqual(model.document.connections.last?.model, "unsaved-model")
            XCTAssertEqual(model.baseRevision, "sha256:old")
            XCTAssertThrowsError(try model.request("apply"))
        }
    }
    func testValidConnectionsEnvelopeVariantsStayUsable() async throws {
        let fixture = DesktopTests()
        let maker = AdvancedConnectionsTests()
        for code in ["invalid_configuration", "cancelled"] {
            let json = "{\"schemaVersion\":1,\"ok\":false,\"code\":\"\(code)\",\"issues\":[]}"
            let runtime = try fixture.fixture("cat >/dev/null; printf '%s' '\(json)'; exit 1")
            defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
            let model = try maker.loaded()
            model.change(.init(id: "retained", adapter: "codex", model: "unsaved-model"), replacing: nil)
            do {
                _ = try await DesktopCLI(runtime: runtime).connections("apply", repo: URL(fileURLWithPath: "/project"), command: Command(), input: model.request("apply"))
                XCTFail("Known precommit failure must throw")
            } catch {
                XCTAssertEqual((error as? ConnectionsFailure)?.code, code)
                model.failed(error)
            }
            XCTAssertEqual(model.draftState, .editing)
            XCTAssertEqual(model.document.connections.last?.model, "unsaved-model")
            XCTAssertNoThrow(try model.request("apply"))
        }
        for (operation, json) in [
            ("edit", "{\"schemaVersion\":1,\"ok\":true,\"baseRevision\":\"missing\",\"document\":\(maker.raw)}"),
            ("validate", "{\"schemaVersion\":1,\"ok\":true,\"connections\":[\(maker.row("proxy"))]}"),
            ("apply", "{\"schemaVersion\":1,\"ok\":true,\"revision\":\"sha256:new\",\"connections\":[\(maker.row("agent")),\(maker.row("proxy"))]}")
        ] {
            let runtime = try fixture.fixture("cat >/dev/null; printf '%s' '\(json)'")
            defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
            let response = try await DesktopCLI(runtime: runtime).connections(operation, repo: URL(fileURLWithPath: "/project"), command: Command(), input: Data("{}".utf8))
            XCTAssertTrue(response.ok)
            if operation == "edit" { XCTAssertEqual(response.document?.connections.map(\.id), ["agent", "proxy"]) }
            else { XCTAssertEqual(response.connections?.map(\.id), operation == "apply" ? ["agent", "proxy"] : ["proxy"]) }
        }
    }
    func testUnicodeEscapedCredentialCannotReachDisplayedResult() async throws {
        let fixture = DesktopTests()
        let secret = "offline-only-value"
        let escaped = secret.utf16.map { String(format: "\\u%04x", $0) }.joined()
        let response = fixture.resultJSON("pass").replacingOccurrences(of: "Review complete", with: escaped)
        let runtime = try fixture.fixture("cat >/dev/null; printf '%s' '\(response)'")
        addTeardownBlock { try? FileManager.default.removeItem(at: URL(fileURLWithPath: runtime.cli).deletingLastPathComponent()) }
        do {
            _ = try await DesktopCLI(runtime: runtime).connectionReview(repo: URL(fileURLWithPath: "/project"), revision: "missing", ids: ["proxy"], budgetMs: 1000, mode: "session", sources: ["SHARED_TOKEN": secret], command: Command())
            XCTFail("Unicode-escaped credential must remain incomplete")
        } catch { XCTAssertEqual(error as? DesktopError, .invalidOutput) }
    }
}
