import Darwin
import Foundation

private struct CapturedStream {
    let pipe = Pipe()
    private(set) var data = Data()
    private(set) var finished = false
    static let limit = 8 * 1024 * 1024

    init() throws {
        guard fcntl(pipe.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) == 0 else {
            throw DesktopError.command
        }
    }

    mutating func drain() throws -> Bool {
        guard !finished else { return false }
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let count = read(pipe.fileHandleForReading.fileDescriptor, &chunk, chunk.count)
        if count < 0 {
            if errno == EAGAIN || errno == EINTR { return false }
            throw DesktopError.command
        }
        if count == 0 { finished = true }
        guard count <= Self.limit - data.count else { throw DesktopError.outputLimit }
        data.append(contentsOf: chunk.prefix(count))
        return count > 0
    }
}

struct CommandOutput: Sendable {
    let status: Int32
    let stdout: Data
    let stderr: Data
}

final class Command: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.withLock { cancelled = true } }

    func run(_ arguments: [String], environment: [String: String], temporary: URL,
             timeout: TimeInterval, input: Data? = nil, progress: @escaping @Sendable (String) async -> Void = { _ in }) async throws -> CommandOutput {
        try await Task.detached { [self] in
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: temporary) }
            var stdout = try CapturedStream()
            var stderr = try CapturedStream()
            defer {
                try? stdout.pipe.fileHandleForReading.close()
                try? stdout.pipe.fileHandleForWriting.close()
                try? stderr.pipe.fileHandleForReading.close()
                try? stderr.pipe.fileHandleForWriting.close()
            }
            let stdin = input.map { _ in Pipe() }
            defer {
                try? stdin?.fileHandleForReading.close()
                try? stdin?.fileHandleForWriting.close()
            }
            if let stdin {
                guard fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETFL, O_NONBLOCK) == 0,
                      fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else { throw DesktopError.command }
            }
            var actions: posix_spawn_file_actions_t?
            var attributes: posix_spawnattr_t?
            posix_spawn_file_actions_init(&actions)
            posix_spawnattr_init(&attributes)
            defer {
                posix_spawn_file_actions_destroy(&actions)
                posix_spawnattr_destroy(&attributes)
            }
            if let stdin {
                posix_spawn_file_actions_adddup2(&actions, stdin.fileHandleForReading.fileDescriptor, STDIN_FILENO)
            } else {
                posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
            }
            posix_spawn_file_actions_adddup2(&actions, stdout.pipe.fileHandleForWriting.fileDescriptor, STDOUT_FILENO)
            posix_spawn_file_actions_adddup2(&actions, stderr.pipe.fileHandleForWriting.fileDescriptor, STDERR_FILENO)
            posix_spawn_file_actions_addchdir_np(&actions, temporary.path)
            posix_spawnattr_setpgroup(&attributes, 0)
            var defaults = sigset_t()
            sigemptyset(&defaults)
            for signal in [SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGPIPE] { sigaddset(&defaults, signal) }
            var mask = sigset_t()
            sigemptyset(&mask)
            posix_spawnattr_setsigdefault(&attributes, &defaults)
            posix_spawnattr_setsigmask(&attributes, &mask)
            posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT))
            let argv = arguments.map { strdup($0) } + [nil]
            let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
            defer { argv.forEach { free($0) }; envp.forEach { free($0) } }
            var child: pid_t = 0
            let spawned = argv.withUnsafeBufferPointer { args in
                envp.withUnsafeBufferPointer { env in
                    posix_spawn(&child, arguments[0], &actions, &attributes,
                                UnsafeMutablePointer(mutating: args.baseAddress!), UnsafeMutablePointer(mutating: env.baseAddress!))
                }
            }
            guard spawned == 0 else { throw DesktopError.command }
            try? stdout.pipe.fileHandleForWriting.close()
            try? stderr.pipe.fileHandleForWriting.close()
            try? stdin?.fileHandleForReading.close()
            var inputOffset = 0
            var inputClosed = false
            var status: Int32 = 0
            do {
                defer { kill(-child, SIGKILL) }
                let deadline = Date().addingTimeInterval(timeout)
                var failure: DesktopError?
                var stopDate: Date?
                var previousCode: String?
                while true {
                    do {
                        _ = try stdout.drain()
                        _ = try stderr.drain()
                    } catch {
                        failure = error as? DesktopError ?? .command
                        kill(-child, SIGKILL)
                    }
                    if let stdin, let input, !inputClosed {
                        if inputOffset < input.count {
                            let count = input.withUnsafeBytes { bytes in
                                Darwin.write(stdin.fileHandleForWriting.fileDescriptor, bytes.baseAddress!.advanced(by: inputOffset), min(4096, input.count - inputOffset))
                            }
                            if count > 0 { inputOffset += count }
                            else if count < 0 && errno != EAGAIN && errno != EINTR { failure = .command; inputClosed = true; try? stdin.fileHandleForWriting.close() }
                        }
                        if inputOffset == input.count { inputClosed = true; try? stdin.fileHandleForWriting.close() }
                    }
                    let waited = waitpid(child, &status, WNOHANG)
                    if waited == child { break }
                    if waited < 0 {
                        if errno == EINTR { continue }
                        throw DesktopError.command
                    }
                    let wasCancelled = lock.withLock { cancelled }
                    if wasCancelled { failure = .cancelled }
                    if Date() >= deadline && failure == nil { failure = .timeout }
                    if failure != nil {
                        // The CLI owns detached runner cleanup. Allow its termination finalizer to finish.
                        if let stopDate {
                            if Date().timeIntervalSince(stopDate) > 12 { kill(-child, SIGKILL) }
                        } else {
                            kill(-child, SIGTERM)
                            stopDate = Date()
                        }
                    }
                    if stdout.data.count <= 64 * 1024,
                       let code = deviceCode(String(decoding: stdout.data, as: UTF8.self)) ?? githubDeviceCode(String(decoding: stderr.data + stdout.data, as: UTF8.self)), code != previousCode {
                        previousCode = code
                        await progress(code)
                    }
                    var descriptors = [
                        pollfd(fd: stdout.finished ? -1 : stdout.pipe.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0),
                        pollfd(fd: stderr.finished ? -1 : stderr.pipe.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0),
                    ]
                    _ = poll(&descriptors, nfds_t(descriptors.count), 100)
                }
                let wasCancelled = lock.withLock { cancelled }
                if wasCancelled { failure = .cancelled }
                if let failure { throw failure }
            }
            while try stdout.drain() {}
            while try stderr.drain() {}
            let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
            return CommandOutput(status: code, stdout: stdout.data, stderr: stderr.data)
        }.value
    }
}

struct DesktopCLI: Sendable {
    let runtime: Runtime
    func call(_ args: [String], command: Command, timeout: TimeInterval = 90) async throws -> CommandOutput {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("needlefish-desktop-" + UUID().uuidString)
        return try await command.run(runtime.command(args), environment: runtime.environment(temporary: temporary),
                                     temporary: temporary, timeout: timeout)
    }
    func doctor(repo: URL, command: Command) async throws -> Doctor {
        let output = try await call(["doctor", "--repo", repo.path, "--runner", "codex", "--json"], command: command)
        guard output.status == 0 || output.status == 1 else { throw DesktopError.command }
        return try JSONDecoder().decode(Doctor.self, from: output.stdout).validated()
    }
    func scope(repo: URL, command: Command) async throws -> Scope {
        let output = try await call(["--repo", repo.path, "--runner", "codex", "--uncommitted", "--dry-run", "--json"], command: command)
        guard output.status == 0 else { throw DesktopError.command }
        return try JSONDecoder().decode(Scope.self, from: output.stdout)
    }
    func review(repo: URL, command: Command) async throws -> Result {
        let output = try await call(["--repo", repo.path, "--runner", "codex", "--model", "gpt-5.6-sol",
                                     "--uncommitted", "--json"], command: command, timeout: 25 * 60)
        // A future CLI may exit nonzero with a conservative result. Never accept nonzero as pass.
        guard !output.stdout.isEmpty else {
            let message = String(decoding: output.stderr, as: UTF8.self)
            if message.contains("usage limit") || message.contains("rate limited") { throw DesktopError.quota }
            if message.contains("network error") { throw DesktopError.network }
            if message.contains("auth rejected") || message.contains("auth error") { throw DesktopError.auth }
            throw DesktopError.command
        }
        let result = try JSONDecoder().decode(Result.self, from: output.stdout).validated()
        guard output.status == 0 || result.verdict != .pass else { throw DesktopError.command }
        return result
    }
}
