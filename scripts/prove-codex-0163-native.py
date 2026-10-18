#!/usr/bin/env python3
"""Check Codex 0.163.0 JSONL against a localhost-only mock Responses provider."""

import errno
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


POLICY = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))'
CASES = {
    "wrapped credits": ({"error": {"message": "insufficient credits"}}, "insufficient credits"),
    "wrapped funds": ({"error": {"message": "insufficient account funds"}}, "insufficient account funds"),
    "bare balance": ({"code": "payment_required", "message": "usage balance exhausted"}, "usage balance exhausted"),
}


class Provider(BaseHTTPRequestHandler):
    body = b""
    success = False

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.success:
            events = [
                {"type": "response.created", "response": {"id": "resp-proof"}},
                {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant", "id": "msg-proof", "content": [{"type": "output_text", "text": "PROOF_OK"}]}},
                {"type": "response.completed", "response": {"id": "resp-proof", "usage": {"input_tokens": 0, "input_tokens_details": None, "output_tokens": 0, "output_tokens_details": None, "total_tokens": 0}}},
            ]
            body = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
        else:
            body = self.body
        self.send_response(200 if self.success else 402)
        self.send_header("Content-Type", "text/event-stream" if self.success else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def sandbox_connect(host, port):
    code = "import socket,sys; s=socket.socket(); s.settimeout(1); print(s.connect_ex((sys.argv[1], int(sys.argv[2]))))"
    result = subprocess.run(["sandbox-exec", "-p", POLICY, "python3", "-c", code, host, str(port)], capture_output=True, text=True, check=True)
    return int(result.stdout.strip())


def sandbox_run(codex, args, root, prompt=None):
    home = root / "codex_home"
    home.mkdir()
    env = {"PATH": os.environ["PATH"], "HOME": str(root), "CODEX_HOME": str(home), "NF_PROOF_KEY": "local-placeholder", "LANG": "en_US.UTF-8"}
    command = ["sandbox-exec", "-p", POLICY, codex, *args]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    try:
        stdout, stderr = process.communicate(prompt, timeout=30)
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    return process.returncode, stdout, stderr


def native_run(codex, port, root):
    last_message = root / "missing_parent" / "out.txt"
    provider = f'model_providers.proof={{name="Local Proof",base_url="http://127.0.0.1:{port}/v1",env_key="NF_PROOF_KEY",wire_api="responses"}}'
    args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C", str(root), "-m", "proof-model", "-c", 'model_provider="proof"', "-c", provider, "-s", "read-only", "--output-last-message", str(last_message), "-"]
    exit_code, stdout, stderr = sandbox_run(codex, args, root, "Reply OK.\n")
    return exit_code, [json.loads(line) for line in stdout.splitlines()], stderr, last_message.exists()


def main():
    codex = shutil.which("codex")
    assert codex
    with HTTPServer(("127.0.0.1", 0), Provider) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            assert sandbox_connect("127.0.0.1", server.server_port) == 0
            assert sandbox_connect("1.1.1.1", 443) == errno.EPERM
            print("network: localhost allowed; external egress denied")
            with tempfile.TemporaryDirectory(prefix="codex-native-version-") as temp:
                exit_code, version, _ = sandbox_run(codex, ["--version"], pathlib.Path(temp))
            assert exit_code == 0 and version.strip() == "codex-cli 0.163.0"
            for name, (body, phrase) in CASES.items():
                Provider.success = False
                Provider.body = json.dumps(body).encode()
                with tempfile.TemporaryDirectory(prefix="codex-native-proof-") as temp:
                    exit_code, events, stderr, _ = native_run(codex, server.server_port, pathlib.Path(temp))
                failures = [event["error"]["message"] for event in events if event.get("type") == "turn.failed"]
                assert exit_code == 1 and len(failures) == 1 and events[-1]["type"] == "turn.failed" and phrase in failures[0] and stderr == ""
                print(f"{name}: exit 1; terminal turn.failed contains {phrase!r}; stderr empty")
            Provider.success = True
            with tempfile.TemporaryDirectory(prefix="codex-native-proof-") as temp:
                exit_code, events, _, last_file_exists = native_run(codex, server.server_port, pathlib.Path(temp))
            messages = [event["item"]["text"] for event in events if event.get("type") == "item.completed" and event.get("item", {}).get("type") == "agent_message"]
            completions = [event["usage"] for event in events if event.get("type") == "turn.completed"]
            fields = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens")
            assert exit_code == 0 and not last_file_exists and messages == ["PROOF_OK"] and events[-1]["type"] == "turn.completed"
            assert len(completions) == 1 and all(isinstance(completions[0].get(field), int) for field in fields)
            print("missing last-message success: exit 0; agent_message PROOF_OK; turn.completed has four integer usage fields")
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
