#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_app", Path(__file__).with_name("package.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackagingTests(unittest.TestCase):
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
