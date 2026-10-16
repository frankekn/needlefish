#!/usr/bin/env python3
"""One-run ACP facade for the local Muse Code exec CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

MODEL = "muse-wonder-1.0"
EFFORT = "high"


def emit(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)


def run_prompt(prompt, cwd):
    # Outside runner-repo: the post-run worktree check must see only model writes.
    with tempfile.TemporaryDirectory(prefix="muse-prompt-", dir=Path(cwd).parent) as tmp:
        prompt_path = Path(tmp) / "prompt.txt"
        prompt_path.write_text(prompt)
        prompt_path.chmod(0o600)
        command = os.environ.get("NEEDLEFISH_MUSE_BIN", "/Users/termtek/.local/bin/muse")
        child = subprocess.Popen(
            [command, "exec", "--json", "--provider", "meta", "--model", MODEL,
             "--reasoning-effort", EFFORT, "--contributor-mode", "on",
             "--no-session-log", "--no-foreign-personal-context", "--disable-reminders",
             "--yolo", "--workspace", cwd, "--prompt-file", str(prompt_path)],
            cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            # Inherit stderr so every failed/successful transcript reaches the harness.
            text=True, env={**os.environ, "MUSE_NO_AUTO_UPDATE": "1"},
        )
        terminal = None
        configured = False
        diagnostics = []
        for line in child.stdout:
            # Preserve every raw event, including tool output, for the canary scanner.
            emit({"method": "muse/event", "params": {"raw": line}})
            event = json.loads(line)
            payload = event.get("payload", {})
            if event.get("payload_type") == "task.lifecycle.status":
                status_event = payload.get("event", {})
                diagnostics.append(status_event)
            if event.get("payload_type") == "run.model.configured":
                if payload.get("model_id") != MODEL:
                    raise ValueError("Muse configured an unexpected model")
                configured = True
            if payload.get("kind") == "run_terminal":
                terminal = payload
        status = child.wait()
        if status != 0:
            diagnostics_path = Path(__file__).with_name("diagnostics")
            diagnostics_path.mkdir(mode=0o700, exist_ok=True)
            record = {"pid": child.pid, "statuses": diagnostics,
                      "terminal": {key: value for key, value in (terminal or {}).items() if key != "text"}}
            output = diagnostics_path / f"{child.pid}.json"
            output.write_text(json.dumps(record, indent=2))
            output.chmod(0o600)
            raise RuntimeError(f"Muse exec exited {status}")
        if not configured or terminal is None or terminal.get("terminal") != "completed":
            raise RuntimeError("Muse exec did not complete the requested model run")
        text = terminal.get("text")
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("Muse exec returned no final text")
        return text


def main():
    cwd = None
    for line in sys.stdin:
        message = json.loads(line)
        method = message.get("method")
        request_id = message.get("id")
        if method == "initialize":
            emit({"id": request_id, "result": {"protocolVersion": 1, "agentCapabilities": {}}})
        elif method == "session/new":
            cwd = message["params"]["cwd"]
            emit({"id": request_id, "result": {"sessionId": "muse-eval"}})
        elif method == "session/prompt":
            try:
                if cwd is None:
                    raise RuntimeError("session/new is required before session/prompt")
                prompt = "".join(part["text"] for part in message["params"]["prompt"])
                text = run_prompt(prompt, cwd)
                emit({"method": "session/update", "params": {
                    "sessionId": "muse-eval", "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": text},
                    },
                }})
                emit({"id": request_id, "result": {"stopReason": "end_turn"}})
            except Exception as error:
                emit({"id": request_id, "error": {"code": -32000, "message": str(error)}})
                return 1
            return 0
        elif request_id is not None:
            emit({"id": request_id, "error": {"code": -32601, "message": "Unsupported method"}})
    return 1


if __name__ == "__main__":
    sys.exit(main())
