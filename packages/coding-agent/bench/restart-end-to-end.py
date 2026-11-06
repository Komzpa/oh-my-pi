#!/usr/bin/env python3
"""Run ten offline real-exec restarts against a generated restart-pipeline fixture."""
import json
import hashlib
import stat
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if sys.argv[1] == '--generate':
    sandbox = Path(tempfile.mkdtemp(prefix='omp-e2e-'))
    (sandbox / 'tmp').mkdir()
    generated = subprocess.check_output(['bun', str(Path(__file__).with_name('restart-pipeline.ts').resolve())],
        env=dict(os.environ, HOME=str(sandbox), TMPDIR=str(sandbox / 'tmp'), OMP_RESTART_FIXTURE_ONLY='1'), text=True)
    fixture = Path(json.loads(generated.splitlines()[0])['root'])
    print(f'fixture={fixture}', flush=True)
else:
    fixture = Path(sys.argv[1]).resolve()
label = sys.argv[2]
runs = int(sys.argv[3]) if len(sys.argv) > 3 else 10
journal = fixture / 'sessions/large.jsonl'
backup = fixture / 'journal.e2e-baseline'
if not backup.exists():
    subprocess.run(['cp', '--reflink=auto', str(journal), str(backup)], check=True)
(fixture / 'tmp').mkdir(exist_ok=True)
env = dict(os.environ, HOME=str(fixture), USERPROFILE=str(fixture), TMPDIR=str(fixture / 'tmp'),
           PI_CODING_AGENT_DIR=str(fixture / 'agent'), PI_CONFIG_DIR='.omp', OMP_RESTART_BENCH_FIXTURE=str(fixture))
for key in ['OMP_RESTART_SESSION_ID', 'OMP_RESTART_INSTANCE_ID', 'OMP_PROFILE', 'PI_PROFILE', 'XDG_RUNTIME_DIR']:
    env.pop(key, None)
def fingerprint(directory):
    rows = []
    for item in sorted(directory.rglob('*')):
        mode = item.lstat().st_mode
        if item.is_symlink(): value = os.readlink(item)
        elif stat.S_ISREG(mode): value = hashlib.sha256(item.read_bytes()).hexdigest()
        else: value = 'directory'
        rows.append((str(item.relative_to(directory)), mode, value))
    return rows

expected = [fingerprint(fixture / f'worker-{i}') for i in range(4)]
all_rows = []
for run in range(runs):
    subprocess.run(['cp', '--reflink=auto', str(backup), str(journal)], check=True)
    for suffix in ['.index-handoff', '.index-handoff-tail']:
        Path(str(journal) + suffix).unlink(missing_ok=True)
    # Each run owns fresh worker transcripts and recovery markers.
    for item in (fixture / 'sessions/large').glob('bench-worker-*'):
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()
    events = fixture / 'e2e.jsonl'
    events.unlink(missing_ok=True)
    with (fixture / f'{label}-{run}.log').open('w') as log:
        result = subprocess.run(['bun', str(Path(__file__).with_suffix('.ts').resolve())], env=env,
                                stdout=log, stderr=log, timeout=60)
    for i in range(4):
        assert fingerprint(fixture / f'worker-{i}') == expected[i], f'worker-{i} changed bytes/index/history'
    rows = [json.loads(line) for line in events.read_text().splitlines()]
    (fixture / f'{label}-{run}.jsonl').write_text(events.read_text())
    if result.returncode:
        raise RuntimeError(f'run {run} failed; {fixture}/{label}-{run}.log')
    def at(event):
        return next(row['at'] for row in rows if row['event'] == event)
    request, exited, frame = (at(event) for event in ['request_accepted', 'old_runtime_exit', 'first_frame_input_accepted'])
    workers = [row['at'] for row in rows if row['event'] == 'worker_continuing']
    assert len(workers) == 4
    sample = dict(run=run, request_to_exit=exited-request, exec_to_module_ready=next(row['at'] for row in rows if row['event']=='module_ready' and row['at']>exited)-exited,
                  request_to_frame=frame-request, frame_to_workers=max(workers)-frame)
    starts = {}
    for row in rows:
        if row['event'] == 'Restart stage started': starts[row['stage']] = row['at']
        if row['event'] == 'Restart stage finished': sample[row['stage']] = row['durationMs']
    if 'replace_runtime' in starts: sample['replace_runtime_to_frame'] = frame-starts['replace_runtime']
    all_rows.append(sample)
    print(json.dumps(sample), flush=True)
report = {key: dict(p50=sorted(row[key] for row in all_rows)[(runs-1)//2], p95=sorted(row[key] for row in all_rows)[-1]) for key in all_rows[0] if key!='run'}
(fixture / f'{label}-report.json').write_text(json.dumps(dict(samples=all_rows, summary=report), indent=2))
print(json.dumps(report, indent=2))
