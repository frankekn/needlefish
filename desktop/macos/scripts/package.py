#!/usr/bin/env python3
"""Build a development app or fail-closed, pinned, signed distribution app. No downloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import platform
import shutil
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MACH_O_MAGICS = {bytes.fromhex(value) for value in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}


def run(args):
    process = subprocess.Popen(args, start_new_session=True)
    print(f"process group {process.pid}", flush=True)
    try:
        os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT)
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            # Darwin reports EPERM when the unreaped zombie is the group's only member.
            pass
        finally:
            status = process.wait()
    if status != 0:
        raise RuntimeError(f"Command failed: {args[0]}")


def verify_runtime(source, lock):
    if not lock.get("releaseApproved"):
        raise ValueError("Release blocked. runtime-lock.json has no approved provenance, licenses or qualification.")
    files = lock.get("files", {})
    if not files or not lock.get("notices"):
        raise ValueError("Approved per-file SHA-256 digests and redistribution notices are required.")
    actual = set()
    for item in source.rglob("*"):
        if item.is_symlink():
            raise ValueError("Runtime symlinks are not supported. Materialize and hash their owned files.")
        if item.is_file():
            relative = item.relative_to(source).as_posix()
            actual.add(relative)
            if hashlib.sha256(item.read_bytes()).hexdigest() != files.get(relative):
                raise ValueError(f"Runtime digest mismatch: {relative}")
    if actual != set(files):
        raise ValueError("Runtime file inventory mismatch.")
    for key in ("node", "cli", "git", "codex"):
        if lock["runtime"][key] not in actual:
            raise ValueError(f"Missing runtime component: {key}")
    for key in ("node", "git", "codex"):
        if not os.access(source / lock["runtime"][key], os.X_OK):
            raise ValueError(f"Runtime entrypoint is not executable: {key}")
    if not set(lock["notices"]).issubset(actual):
        raise ValueError("Missing redistribution notice.")


def release_requirement(team):
    if len(team) != 10 or not team.isascii() or not team.isalnum() or team != team.upper():
        raise ValueError("A ten-character Apple team identifier is required.")
    return ('anchor apple generic and identifier "com.needlefish.desktop" '
            'and certificate 1[field.1.2.840.113635.100.6.2.6] exists '
            'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
            f'and certificate leaf[subject.OU] = "{team}"')


def verify_arm64(source, runner=run):
    for item in sorted(source.rglob("*")):
        if item.is_file():
            with item.open("rb") as handle:
                magic = handle.read(4)
            if magic in MACH_O_MAGICS:
                runner(["lipo", "-verify_arch", "arm64", str(item)])


def sign_runtime(source, identity, node, runner=run):
    for item in sorted(source.rglob("*"), reverse=True):
        if not item.is_file():
            continue
        with item.open("rb") as handle:
            magic = handle.read(4)
        if magic not in MACH_O_MAGICS:
            continue
        args = ["codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity]
        if item.relative_to(source).as_posix() == node:
            args += ["--entitlements", str(ROOT / "node.entitlements.plist")]
        runner(args + [str(item)])


def reserve_output(output):
    app = output.absolute()
    app.mkdir(mode=0o700, parents=True)
    return app


def stage_runtime(source, destination, lock):
    shutil.copytree(source, destination)
    verify_runtime(destination, lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--development", action="store_true")
    parser.add_argument("--node", type=Path)
    parser.add_argument("--cli", type=Path)
    parser.add_argument("--codex", type=Path)
    parser.add_argument("--git", type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--signing-identity")
    parser.add_argument("--team")
    parser.add_argument("--output", type=Path, default=ROOT / "build/Needlefish.app")
    args = parser.parse_args()
    lock = json.loads((ROOT / "runtime-lock.json").read_text())
    if args.development:
        runtime = {key: str(getattr(args, key).resolve(strict=True)) for key in ("node", "cli", "codex", "git")}
        runtime["development"] = True
    else:
        if not args.runtime or not args.signing_identity or not args.team:
            raise ValueError("Release requires an approved runtime directory, Developer ID identity and team.")
        if platform.system() != "Darwin" or platform.machine() != "arm64" or lock.get("platform") != "darwin-arm64":
            raise ValueError("Release packaging requires an Apple silicon macOS host and darwin-arm64 lock.")
        release_requirement(args.team)
        if not lock.get("releaseApproved"):
            raise ValueError("Release blocked. runtime-lock.json has no approved provenance, licenses or qualification.")
        runtime = lock["runtime"]
    app = reserve_output(args.output)
    try:
        (app / "Contents/MacOS").mkdir(parents=True)
        resources = app / "Contents/Resources"
        resources.mkdir()
        architecture = [] if args.development else ["--arch", "arm64"]
        run(["swift", "build", "--package-path", str(ROOT), "-j", "2"] + architecture)
        binary_path = subprocess.check_output(["swift", "build", "--package-path", str(ROOT), "--show-bin-path"] + architecture, text=True).strip()
        shutil.copy2(Path(binary_path) / "NeedlefishDesktop", app / "Contents/MacOS/NeedlefishDesktop")
        if not args.development:
            stage_runtime(args.runtime, resources / "runtime", lock)
            (resources / "runtime-lock.json").write_text(json.dumps(lock, indent=2))
        (resources / "runtime.json").write_text(json.dumps(runtime))
        info = {
            "CFBundleExecutable": "NeedlefishDesktop", "CFBundleIdentifier": "com.needlefish.desktop",
            "CFBundleName": "Needlefish", "CFBundleDisplayName": "Needlefish",
            "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "0.1.0",
            "CFBundleVersion": "1", "LSMinimumSystemVersion": "14.0",
            "NSHighResolutionCapable": True, "NeedlefishDevelopment": args.development,
            "NSHumanReadableCopyright": "Needlefish contributors. MIT.",
        }
        if args.team:
            info["NeedlefishTeamIdentifier"] = args.team
        with (app / "Contents/Info.plist").open("wb") as handle:
            plistlib.dump(info, handle)
        identity = "-" if args.development else args.signing_identity
        if not args.development:
            verify_arm64(app)
            sign_runtime(resources / "runtime", identity, runtime["node"])
            signed_entitlements = subprocess.check_output(
                ["codesign", "--display", "--entitlements", ":-", str(resources / "runtime" / runtime["node"])])
            if plistlib.loads(signed_entitlements) != {"com.apple.security.cs.allow-jit": True}:
                raise ValueError("Signed Node JIT entitlements do not match the reviewed contract.")
        signing = ["codesign", "--force", "--sign", identity]
        if not args.development:
            signing += ["--options", "runtime", "--timestamp"]
        run(signing + [str(app)])
        run(["codesign", "--verify", "--deep", "--strict", str(app)])
        if not args.development:
            run(["codesign", "--verify", "--deep", "--strict", "-R", release_requirement(args.team), str(app)])
            print("Signed app built. Not distributable until notarized, stapled and clean-machine qualified.")
        print(app)
    except BaseException:
        shutil.rmtree(app, ignore_errors=True)
        raise


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        sys.exit(str(error))
