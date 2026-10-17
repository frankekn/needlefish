# Codex 0.163.0 native JSONL proof for PR #268

Run `python3 scripts/prove-codex-0163-native.py` on macOS with `codex-cli 0.163.0`. The script uses an empty temporary `CODEX_HOME`, a dummy provider key, and a local Responses mock. A macOS sandbox permits localhost and denies other outbound connections. The script checks both rules before starting Codex, then removes its temporary files and stops the server. It makes no paid model request and sends no request to a remote provider.

Observed output on 2026-10-16:

```text
network: localhost allowed; external egress denied
wrapped credits: exit 1; terminal turn.failed contains 'insufficient credits'; stderr empty
wrapped funds: exit 1; terminal turn.failed contains 'insufficient account funds'; stderr empty
bare balance: exit 1; terminal turn.failed contains 'usage balance exhausted'; stderr empty
missing last-message success: exit 0; agent_message PROOF_OK; turn.completed has four integer usage fields
```

The success case points `--output-last-message` at a nonexistent parent directory. Codex cannot create the file, but emits a completed `agent_message` and `turn.completed`. The four checked usage fields are `input_tokens`, `cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens`.

The exact 0.163.0 source explains the observed path:

- [`UnexpectedResponseError`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/protocol/src/error.rs) extracts a wrapped `error.message` or retains a bare body. `CodexErr::to_error_event` uses its displayed text.
- [App-server event handling](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/bespoke_event_handling.rs) puts that error text into the failed turn.
- [JSONL event processing](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs) emits `turn.failed.error.message` and, on success, the final `agent_message`.
- [The 0.163.0 event schema](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/exec_events.rs) requires `reasoning_output_tokens` in `turn.completed.usage`.

This proof covers the installed version and these controlled provider responses. It does not replace Needlefish's full Class R model evaluation, which remains pending.
