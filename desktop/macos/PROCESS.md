# Process ownership

`Command.run` owns a process group only after `posix_spawn` succeeds. The Swift caller observes the direct child with `waitid(WNOWAIT)` and owns one group finalizer. The unreaped leader reserves its PID/PGID until the finalizer signals the group and reaps it with `waitpid`. A single deferred finalizer covers every subsequent return and throw from the owned lifecycle block; it confirms the child is still waitable before signalling. Stdout and stderr use separate nonblocking pipes drained together by the owning task. Each capture retains at most 8 MiB plus one 64 KiB read chunk and the kernel pipe buffer. Exceeding either limit stops the owned group. No output capture file is written. The owned lifecycle block ends before the final buffered pipe bytes are drained. Cancellation is an intent flag; the process loop sends one SIGTERM and allows the existing CLI termination finalizer its grace period before force termination.

| Exit path | Direct child owner | Attached child owner | Evidence |
| --- | --- | --- | --- |
| Normal exit | Swift observes the unreaped leader | Group signal, then leader reap | Normal-exit child PID disappears |
| Nonzero or signal exit | Swift observes the unreaped leader | Group signal, then leader reap | Failed/crashed leader child PID disappears |
| Cancel | Swift requests termination, then observes exit | Group signal, then leader reap | TERM-ignoring child PID disappears |
| Timeout or output limit | Swift requests termination, then observes exit | Group signal, then leader reap | Timeout child PID disappears; bounded output rejected |
| Spawn failure | No owned PID or PGID exists | No group is signalled | Missing executable reports failure and removes temporary output |
| Output read failure | Live capture uses the common finalizer; final drain follows reap | No signal follows reap | Deferred cleanup runs before invocation temporary-directory removal |
| Installed app launch failure | LaunchServices owns the attempted GUI process | No POSIX group is assigned by this wrapper | Receipt stays unchanged; candidate cleanup is best effort |

The existing TypeScript lifecycle owns any separate runner groups. The native wrapper does not claim OS isolation or control of malicious descendants that create a different session or group. POSIX PGIDs can be reused after the leader is reaped; this owner sends no group signals after that reap. Group signalling is scoped to the immediately owned command lifecycle; it is not a portable process-tree identity mechanism.

Before finalizer consolidation, the existing normal, nonzero, cancel and timeout actor checks all passed. The earlier premise had already been removed from those paths. The consolidation makes exceptional returns use the same owner rule. The census adds the previously unobserved spawn-failure path.

Run `python3 desktop/macos/scripts/process-census.py --package desktop/macos` to repeat the actor assertions without accounts or model calls. The script checks host capacity, starts the selected tests in their own process group and removes that group after completion.

The Python packager and census observe leader exit with `waitid(WNOWAIT)`, signal the owned group, then reap the leader. The unreaped leader reserves its PID until signalling completes. Darwin returns `EPERM` for a group containing only zombies, so these scripts tolerate that result. Their SIGTERM cleanup is best effort and cannot stop descendants that ignore the signal or change credentials, session, or group.

Quit defers termination only while an owned `Command` is being cleaned up. Installation and rollback do not own a command process group, so Quit does not wait for their LaunchServices callback. If the app quits before launch confirmation, its existing receipt remains unchanged. macOS may still open the candidate, and an unrecorded installation copy may remain for manual removal.

Installation app versions use separate UUID paths. The receipt records current, previous and pending-removal UUIDs. Installation records retired versions before attempting cleanup, and removal keeps the receipt on failure. This receipt is a real shared invariant, so each install, rollback and uninstall transaction holds a nonblocking OS lock on the owned root directory. Another running app receives a retry message. No lockfile, daemon or user credential is added.

The group finalizer sends SIGKILL. It does not prove synchronously that every attached writer has closed. A bounded Foundation/POSIX probe on production source `3559924` ran sixteen normal-leader-exit cases with a child that wrote one known valid JSON result in two chunks. All sixteen produced that exact typed result. Separate cancellation and timeout cases ignored a complete pass JSON and returned their terminal errors. This finite probe found no incorrect visible result; it does not prove all possible process schedules. Bounded pipe capture, strict JSON and verdict checks remain the consumer boundary. No generic process-tree supervisor is claimed.

The invocation workspace is removed after process and pipe finalization on both success and failure. A removal failure overrides any pending output or command error with a canned incomplete-cleanup error; no path, raw error or project contents are displayed. A project copy may remain for manual cleanup. The app does not silently clear immutable flags or claim that a failed cleanup removed the copy.
