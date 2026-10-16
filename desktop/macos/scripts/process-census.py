#!/usr/bin/env python3
"""Rerun the native process-owner assertions without accounts or model calls."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--package", type=Path, required=True)
args = parser.parse_args()
cores = int(subprocess.check_output(["sysctl", "-n", "hw.ncpu"], text=True))
pressure = int(subprocess.check_output(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], text=True))
if os.getloadavg()[0] >= cores or pressure > 1:
    raise SystemExit("Host saturated. Run the census after capacity recovers.")
selected = [
    "testNormalAndFailedLeaderExitCannotLeaveOwnedDescendants",
    "testCancellationAndTimeoutKillTermIgnoringDescendantAfterLeaderExits",
    "testCancellationAllowsCLIFinalizerToRun",
    "testTimeoutAndLoginCancelAreNotSuccess",
    "testSpawnFailureOwnsNoGroupAndRemovesTemporaryOutput",
    "testFailedLaunchDoesNotReplaceReceiptOnInstallOrRollback",
]
process = subprocess.Popen(["swift", "test", "--package-path", str(args.package), "-j", "2", "--filter", "|".join(selected)], start_new_session=True)
print(f"Census test process group {process.pid}", flush=True)
try:
    status = process.wait()
finally:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
if status:
    raise SystemExit(status)
print(json.dumps({
    "normal_and_nonzero_leader_exit": "direct child reaped; attached child kill(pid,0) == -1",
    "cancel_and_timeout": "TERM-ignoring attached child kill(pid,0) == -1; temporary files removed",
    "graceful_finalizer": "literal cleanup marker read after a delayed TERM handler",
    "pre_cancelled_login_and_timeout": "not success; correct terminal error observed",
    "spawn_failure": "missing executable reports terminal error and temporary directory is empty; no owned PGID",
    "installed_app_launch_failure": "fake launch callback failure preserves prior receipt; not a live LaunchServices qualification",
    "detached_runner_groups": "owned by existing TS lifecycle, not generic Swift group wrapper",
    "limits": "Not OS isolation. A malicious descendant can change session/group; POSIX PGIDs can be reused."
}, indent=2))
