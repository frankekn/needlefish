# Process ownership

`Command.run` owns a process group only after `posix_spawn` succeeds. The Swift caller owns the direct child's `waitpid` and one group finalizer. A single deferred finalizer covers every subsequent return and throw. Cancellation is an intent flag; the process loop sends one SIGTERM and allows the existing CLI termination finalizer its grace period before force termination.

| Exit path | Direct child owner | Attached child owner | Evidence |
| --- | --- | --- | --- |
| Normal exit | Swift reaps the leader | Common group finalizer | Normal-exit child PID disappears |
| Nonzero or signal exit | Swift reaps the leader | Common group finalizer | Failed/crashed leader child PID disappears |
| Cancel | Swift requests termination, then reaps | Common group finalizer | TERM-ignoring child PID disappears |
| Timeout or output limit | Swift requests termination, then reaps | Common group finalizer | Timeout child PID disappears; bounded output rejected |
| Spawn failure | No owned PID or PGID exists | No group is signalled | Missing executable reports failure and removes temporary output |
| Output read failure | Leader has already been reaped | Common group finalizer | Deferred cleanup runs before invocation temporary-directory removal |
| Installed app launch failure | LaunchServices owns the attempted GUI process | No POSIX group is assigned by this wrapper | Receipt stays unchanged; candidate copy is removed |

The existing TypeScript lifecycle owns any separate runner groups. The native wrapper does not claim OS isolation or control of malicious descendants that create a different session or group. POSIX PGIDs can be reused. Group signalling is scoped to the immediately owned command lifecycle; it is not a portable process-tree identity mechanism.

Before finalizer consolidation, the existing normal, nonzero, cancel and timeout actor checks all passed. The earlier premise had already been removed from those paths. The consolidation makes exceptional returns use the same owner rule. The census adds the previously unobserved spawn-failure path.

Run `python3 desktop/macos/scripts/process-census.py --package desktop/macos` to repeat the actor assertions without accounts or model calls. The script checks host capacity, starts the selected tests in their own process group and removes that group after completion.

Installation app versions use separate UUID paths. The one current/previous receipt is a real shared invariant, so each install, rollback and uninstall transaction holds a nonblocking OS lock on the owned root directory. Another running app receives a retry message. No lockfile, daemon or user credential is added.
