#!/usr/bin/env python3
"""Record native Muse transcripts; latch failures before another paid call."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).parent
ORIGINAL = ROOT.parent / 'needlefish-muse-wonder-high' / 'bridge.py'
STOP = ROOT / 'STOP'

def main():
    if STOP.exists():
        print('Muse quota/safety stop is latched', file=sys.stderr)
        return 1
    calls = ROOT / 'calls'
    calls.mkdir(mode=0o700, exist_ok=True)
    count = len(list(calls.glob('*.json')))
    if count >= 1275:
        STOP.write_text('Predeclared maximum 1275 CLI calls reached\n')
        return 1
    prefix = calls / f'{count + 1:04d}'
    start = time.time()
    prefix.with_suffix('.json').write_text(json.dumps({'call': count + 1, 'startedAt': start}))
    with prefix.with_suffix('.stdout').open('w') as out, prefix.with_suffix('.stderr').open('w') as err:
        child = subprocess.Popen([str(ORIGINAL)], stdin=sys.stdin, stdout=subprocess.PIPE,
                                 stderr=err, text=True)
        for line in child.stdout:
            out.write(line)
            out.flush()
            print(line, end='', flush=True)
        child.stdout.close()
        status = child.wait()
    prefix.with_suffix('.json').write_text(json.dumps({'call': count + 1, 'startedAt': start,
        'durationSeconds': time.time() - start, 'exitCode': status}))
    if status:
        STOP.write_text(f'Bridge call {count + 1} failed; exit {status}\n')
    return status

if __name__ == '__main__':
    sys.exit(main())
