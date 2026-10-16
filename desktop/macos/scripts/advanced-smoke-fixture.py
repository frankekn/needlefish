#!/usr/bin/env python3
"""Create an isolated, visibly offline CLI for advanced native UI checks."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
args = parser.parse_args()
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=False)
(root / "document.json").write_text(json.dumps({"version": 1, "connections": [
    {"id": "offline-a", "adapter": "codex", "model": "offline-model", "auth": {
        "route": {"kind": "openai"}, "env": {"CODEX_API_KEY": "OFFLINE_A_KEY"}}},
    {"id": "offline-b", "adapter": "codex", "model": "offline-model", "auth": {
        "route": {"kind": "cliproxyapi", "baseUrl": "http://localhost:1234/v1"},
        "env": {"CODEX_PROXY_API_KEY": "OFFLINE_B_KEY"}}}]}))
script = root / "fake-cli.py"
script.write_text('''#!/usr/bin/python3
import hashlib
import json
from pathlib import Path
import sys
import time
root = Path(__file__).resolve().parent
docfile = root / "document.json"
document = json.loads(docfile.read_text())
revision = "sha256:" + hashlib.sha256(docfile.read_bytes()).hexdigest()
def emit(value):
    print(json.dumps(value), flush=True)
def rows(ids=None):
    profiles = document["connections"]
    if ids is not None:
        profiles = [next(p for p in profiles if p["id"] == name) for name in ids]
    return [{"id": p["id"], "adapter": p["adapter"], "requestedModel": p.get("model"),
             "route": p.get("auth", {}).get("route", {}).get("kind", "opaque" if p["adapter"] == "acp" else "ambient"),
             "credentialSource": "reference-configured" if p.get("auth") else "ambient",
             "providerAccount": "unknown", "authentication": "unknown", "qualification": "unqualified",
             "readiness": "local-available"} for p in profiles]
if sys.argv[1] == "doctor":
    emit({"schemaVersion": 1, "repoRoot": str(root), "checks": [{"name": name, "status": "ok", "detail": "OFFLINE UI TEST"} for name in ["node", "runner", "capability", "auth", "git", "base"]]})
elif sys.argv[1] == "connections":
    operation = sys.argv[2]
    request = json.load(sys.stdin) if operation in ["apply", "validate", "inspect", "review"] else None
    if operation == "edit":
        emit({"schemaVersion": 1, "ok": True, "baseRevision": revision, "document": document})
    elif operation == "apply":
        if (root / "force-conflict").exists() or request["expectedRevision"] != revision:
            emit({"schemaVersion": 1, "ok": False, "code": "revision_conflict"}); sys.exit(1)
        ids = [p["id"] for p in request["document"]["connections"]]
        if len(ids) != len(set(ids)):
            emit({"schemaVersion": 1, "ok": False, "code": "invalid_configuration"}); sys.exit(1)
        document = request["document"]
        docfile.write_text(json.dumps(document))
        revision = "sha256:" + hashlib.sha256(docfile.read_bytes()).hexdigest()
        if (root / "apply-invalid-output").exists():
            print("truncated", flush=True); sys.exit(0)
        emit({"schemaVersion": 1, "ok": True, "revision": revision, "connections": rows()})
    elif operation == "inspect":
        emit({"schemaVersion": 1, "ok": True, "revision": revision, "connections": rows(request["ids"])})
    elif operation == "review":
        time.sleep(30 if (root / "slow-review").exists() else 1)
        emit({"schemaVersion": 1, "verdict": "needs_human", "summary": "OFFLINE UI TEST. No actual review.", "findings": [], "residualRisks": [{"text": "Offline fixture requires human inspection.", "blocks": True}]})
    else:
        emit({"schemaVersion": 1, "ok": True, "revision": revision, "connections": rows()})
else:
    emit({"mode": "uncommitted", "changedFiles": [{"path": "OFFLINE-UI-TEST.ts"}], "patchBytes": 42, "untrackedSkipped": []})
''')
script.chmod(0o700)
print(script)
