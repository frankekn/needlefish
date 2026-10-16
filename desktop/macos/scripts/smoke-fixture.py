#!/usr/bin/env python3
"""Create a fake CLI for native UI smoke checks. Never calls a model or reads credentials."""
import argparse
import json
import shlex
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
checks = [{"name": name, "status": "ok", "detail": "offline UI fixture"}
          for name in ["node", "runner", "capability", "auth", "git", "base"]]
doctor = json.dumps({"schemaVersion": 1, "repoRoot": str(args.output.resolve()), "checks": checks})
scope = json.dumps({"mode": "uncommitted", "changedFiles": [{"path": "example.ts"}],
                    "patchBytes": 42, "untrackedSkipped": []})
result = json.dumps({"schemaVersion": 1, "verdict": "changes_requested",
                     "summary": "OFFLINE UI TEST. Not an actual project review.",
                     "findings": [
                         {"severity": "P2", "title": "Same location, separate finding", "file": "example.ts", "lineStart": 8,
                          "whyItBreaks": "First independent impact.", "suggestedFix": "First distinct next step."},
                         {"severity": "P2", "title": "Same location, separate finding", "file": "example.ts", "lineStart": 8,
                          "whyItBreaks": "Second independent impact.", "suggestedFix": "Second distinct next step."}],
                     "residualRisks": []})
script = args.output / "fake-cli"
script.write_text("#!/bin/sh\n" + f"""case "$1" in
 doctor) printf '%s' {shlex.quote(doctor)};;
 login) printf '%s\\n' 'https://auth.openai.com/codex/device' 'Enter this one-time code' 'TEST-00000'; sleep 120;;
 *) case "$*" in
      *--dry-run*) printf '%s' {shlex.quote(scope)};;
      *) sleep 1; printf '%s' {shlex.quote(result)};;
    esac;;
esac
""")
script.chmod(0o700)
print(script.resolve())
