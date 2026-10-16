#!/usr/bin/env python3
"""Run the frozen leaderboard lane and retain every checkpoint and transcript."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).parent
WORKTREE = ROOT.parent / 'needlefish-muse-ranked-x3'
REPORT = ROOT / '2026-10-13-muse-code-wonder-1.0-high-ranked-x3.json'

def main():
    os.umask(0o077)
    if REPORT.exists() or (ROOT / 'calls').exists():
        raise RuntimeError('Refusing to replace existing ranking-run evidence')
    credential = json.loads(subprocess.check_output(
        ['security', 'find-generic-password', '-s', 'ai.meta.dev.credentials', '-a', 'meta', '-w'],
        text=True))['api_key']
    if not isinstance(credential, str) or not credential:
        raise RuntimeError('Muse Keychain API credential missing')
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('NEEDLEFISH_', 'CODEX_', 'PI_', 'OPENCODE_'))}
    env.update({'META_API_KEY': credential, 'NEEDLEFISH_ACP_BIN': str(ROOT / 'bridge.py'),
                'NEEDLEFISH_ACP_AUTH_ENV_VARS': 'META_API_KEY',
                'NEEDLEFISH_RUNNER_ENV_PASSTHROUGH': 'META_API_KEY',
                'TMPDIR': str(ROOT.parent)})
    command = ['corepack', 'pnpm', 'exec', 'tsx', 'eval/run.ts', '--runner', 'acp',
               '--model', 'muse-wonder-1.0', '--effort', 'high', '--provider', 'Meta',
               '--route', 'Native Muse Code via ACP bridge, Meta account',
               '--runner-version', 'Muse Code 1.4.7 (1.4.7-R6101.1)',
               '--draws', '3', '--concurrency', '1', '--holdout', 'include', '--gate-class', 'R',
               '--env', 'NEEDLEFISH_EPHEMERAL_HOME=1', '--env', 'NEEDLEFISH_EVAL_TRACE=1',
               '--env', 'NEEDLEFISH_NO_RETRY=1', '--report', str(REPORT)]
    with (ROOT / 'harness.log').open('w') as log:
        child = subprocess.Popen(command, cwd=WORKTREE, env=env, stdout=log, stderr=log,
                                 start_new_session=True)
        seen = -1
        last_heartbeat = 0
        reason = None
        state = {'pid': child.pid, 'completed': 0, 'total': 261, 'cliCalls': 0,
                 'lastFixture': None, 'updatedAt': time.time(), 'state': 'running'}
        while child.poll() is None:
            time.sleep(1)
            report = json.loads(REPORT.read_text()) if REPORT.exists() else None
            results = report['results'] if report else []
            calls = len(list((ROOT / 'calls').glob('*.json'))) if (ROOT / 'calls').exists() else 0
            state = {'pid': child.pid, 'completed': len(results), 'total': 261, 'cliCalls': calls,
                     'lastFixture': results[-1]['fixtureId'] if results else None,
                     'updatedAt': time.time(), 'state': 'running'}
            (ROOT / 'status.json').write_text(json.dumps(state, indent=2) + '\n')
            if len(results) != seen or time.time() - last_heartbeat >= 60:
                print(f"progress {len(results)}/261; Muse CLI calls {calls}; last {state['lastFixture']}", flush=True)
                seen = len(results)
                last_heartbeat = time.time()
            invalid = any(not r['score']['formatOk'] or r.get('operationalFailure') for r in results)
            cheat = report and report['aggregates']['cheatDetectedCount'] > 0
            if invalid or cheat:
                reason = 'anti-cheat detection' if cheat else 'invalid/operational draw failure'
                (ROOT / 'STOP').write_text(reason + '\n')
                os.killpg(child.pid, signal.SIGTERM)
                break
            if (ROOT / 'STOP').exists() and not invalid:
                # Allow the unmodified harness to save the failed draw first.
                reason = (ROOT / 'STOP').read_text().strip()
        try:
            status = child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            status = child.wait()
    state['state'] = 'stopped' if reason or status else 'completed'
    state['exitCode'] = status
    state['reason'] = reason
    if REPORT.exists():
        final = json.loads(REPORT.read_text())
        state['completed'] = len(final['results'])
        state['aggregates'] = final['aggregates']
    (ROOT / 'status.json').write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps(state, indent=2), flush=True)
    return 1 if reason else status

if __name__ == '__main__':
    sys.exit(main())
