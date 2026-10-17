#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import runpy
import signal
import subprocess
import sys
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("package_app", Path(__file__).with_name("package.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackagingTests(unittest.TestCase):
    def assert_group_signalled_before_reap(self, invoke, status):
        observed = []
        killpg = os.killpg
        waitid = os.waitid

        def observe_group(pgid, sig):
            child = waitid(os.P_PID, pgid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            observed.append((pgid, sig, child.si_status if child else None))
            killpg(pgid, sig)

        with mock.patch.object(os, "killpg", side_effect=observe_group):
            invoke()
        self.assertEqual([(sig, code) for _, sig, code in observed], [(signal.SIGTERM, status)])
        with self.assertRaises(ChildProcessError):
            waitid(os.P_PID, observed[0][0], os.WEXITED | os.WNOHANG)

    def test_commands_signal_owned_group_before_reaping_success_and_failure(self):
        for status in (0, 7):
            with self.subTest(status=status):
                def invoke():
                    command = [sys.executable, "-c", f"raise SystemExit({status})"]
                    if status:
                        with self.assertRaisesRegex(RuntimeError, "Command failed"):
                            package.run(command)
                    else:
                        package.run(command)
                self.assert_group_signalled_before_reap(invoke, status)

    def test_interrupted_wait_signals_and_reaps_owned_command(self):
        def invoke():
            with mock.patch.object(os, "waitid", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    package.run(["/bin/sleep", "30"])
        self.assert_group_signalled_before_reap(invoke, None)

    def test_command_cleanup_signals_attached_descendant(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / "terminated"
            command = """import os, signal, sys
from pathlib import Path
reader, writer = os.pipe()
if os.fork() == 0:
    os.close(reader)
    def stop(signum, frame):
        Path(sys.argv[1]).write_text('SIGTERM received')
        os._exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.alarm(3)
    os.write(writer, b'ready')
    os.close(writer)
    signal.pause()
else:
    os.close(writer)
    os.read(reader, 5)
    os.close(reader)
"""
            package.run([sys.executable, "-c", command, str(marker)])
            deadline = time.monotonic() + 3
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(marker.read_text(), "SIGTERM received")

    def test_census_signals_owned_group_before_reaping_success_and_failure(self):
        popen = subprocess.Popen
        for status in (0, 7):
            with self.subTest(status=status):
                def launch(_args, **kwargs):
                    return popen([sys.executable, "-c", f"raise SystemExit({status})"], **kwargs)

                def invoke():
                    with mock.patch.object(sys, "argv", ["process-census.py", "--package", "/unused"]), \
                         mock.patch.object(subprocess, "check_output", side_effect=["14", "1"]), \
                         mock.patch.object(os, "getloadavg", return_value=(0, 0, 0)), \
                         mock.patch.object(subprocess, "Popen", side_effect=launch):
                        if status:
                            with self.assertRaises(SystemExit) as error:
                                runpy.run_path(str(Path(__file__).with_name("process-census.py")))
                            self.assertEqual(error.exception.code, 7)
                        else:
                            runpy.run_path(str(Path(__file__).with_name("process-census.py")))
                self.assert_group_signalled_before_reap(invoke, status)

    def test_smoke_fixture_accepts_apostrophe_in_path(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "o'hare"
            subprocess.run([sys.executable, str(Path(__file__).with_name("smoke-fixture.py")), str(output)],
                           check=True, capture_output=True, text=True)
            result = subprocess.run([str(output / "fake-cli"), "doctor"], check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout)["repoRoot"], str(output.resolve()))

    def test_unapproved_release_is_blocked_before_executing_artifacts(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, "Release blocked"):
                package.verify_runtime(Path(root), {"releaseApproved": False})

    def test_node_is_signed_with_jit_entitlement_and_other_binaries_are_not(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / "bin").mkdir()
            (source / "bin/node").write_bytes(bytes.fromhex("cafebabf") + b"fixture")
            (source / "bin/codex").write_bytes(b"\xcf\xfa\xed\xfe" + b"fixture")
            calls = []
            package.sign_runtime(source, "Developer ID Application: fixture", "bin/node", runner=calls.append)
            node_call = next(call for call in calls if call[-1].endswith("/node"))
            codex_call = next(call for call in calls if call[-1].endswith("/codex"))
            self.assertEqual(node_call, ["codesign", "--force", "--options", "runtime", "--timestamp", "--sign",
                                        "Developer ID Application: fixture", "--entitlements",
                                        str(package.ROOT / "node.entitlements.plist"), str(source / "bin/node")])
            self.assertNotIn("--entitlements", codex_call)
            self.assertIn("leaf[field.1.2.840.113635.100.6.1.13]", package.release_requirement("ABCDE12345"))
            with self.assertRaisesRegex(ValueError, "team identifier"):
                package.release_requirement('bad"team')

    def test_every_native_binary_requires_arm64_before_signing(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / "node").write_bytes(bytes.fromhex("bfbafeca") + b"fixture")
            (source / "NOTICE").write_text("license")
            calls = []
            package.verify_arm64(source, runner=calls.append)
            self.assertEqual(calls, [["lipo", "-verify_arch", "arm64", str(source / "node")]])
            def reject_arch(args):
                raise RuntimeError("missing arm64")
            with self.assertRaisesRegex(RuntimeError, "missing arm64"):
                package.verify_arm64(source, runner=reject_arch)

    def test_output_reservation_never_removes_another_invocation(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "Needlefish.app"
            owned = package.reserve_output(output)
            (owned / "marker").write_text("first invocation")
            with self.assertRaises(FileExistsError):
                package.reserve_output(output)
            self.assertEqual((owned / "marker").read_text(), "first invocation")

    def test_staged_snapshot_is_verified_instead_of_mutable_source(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source"
            source.mkdir()
            names = ["node", "cli", "git", "codex", "NOTICE"]
            for name in names:
                (source / name).write_text("approved " + name)
                if name in ["node", "git", "codex"]:
                    (source / name).chmod(0o700)
            lock = {"releaseApproved": True,
                    "files": {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in names},
                    "runtime": {name: name for name in names[:4]}, "notices": ["NOTICE"]}
            staged = Path(root) / "staged"
            package.stage_runtime(source, staged, lock)
            (source / "node").write_text("changed source")
            package.verify_runtime(staged, lock)
            self.assertEqual((staged / "node").read_text(), "approved node")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                package.stage_runtime(source, Path(root) / "rejected", lock)

    def test_digest_inventory_and_notices_are_required(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            names = ["node", "cli", "git", "codex", "NOTICE"]
            for name in names:
                (source / name).write_text("fixture " + name)
                if name in ["node", "git", "codex"]:
                    (source / name).chmod(0o700)
            lock = {"releaseApproved": True,
                    "files": {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in names},
                    "runtime": {name: name for name in names[:4]}, "notices": ["NOTICE"]}
            package.verify_runtime(source, lock)
            (source / "node").chmod(0o600)
            with self.assertRaisesRegex(ValueError, "not executable"):
                package.verify_runtime(source, lock)
            (source / "node").chmod(0o700)
            (source / "node").write_text("tampered")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                package.verify_runtime(source, lock)
            (source / "node").write_text("fixture node")
            (source / "unexpected").write_text("extra")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                package.verify_runtime(source, lock)
            (source / "unexpected").unlink()
            (source / "escape").symlink_to("/bin/sh")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                package.verify_runtime(source, lock)


if __name__ == "__main__":
    unittest.main()
