import json
import os
import pathlib
import shlex
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
pending = sys.argv[2]
repo = pathlib.Path(__file__).resolve().parents[4]
root.mkdir(parents=True, exist_ok=True)
(root / 'runtime').mkdir(mode=0o700, exist_ok=True)
(root / 'home').mkdir(exist_ok=True)
env = dict(os.environ, HOME=str(root / 'home'), PI_CODING_AGENT_DIR=str(root / 'agent'),
           XDG_RUNTIME_DIR=str(root / 'runtime'), RESTART_FIXTURE_ROOT=str(root),
           RESTART_FIXTURE_PENDING=pending, PI_CONFIG_DIR='.omp',
           XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'),
           XDG_STATE_HOME=str(root / 'state'), XDG_CACHE_HOME=str(root / 'cache'))
for key in ['OMP_RESTART_SESSION_ID', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_SESSION_DIR']:
    env.pop(key, None)
socket = 'restartdone2-' + str(os.getpid())
cli = [sys.argv[3], str(repo / 'packages/coding-agent/src/cli.ts'), 'restart']
def run(args):
    return subprocess.check_output(args, env=env, text=True, stderr=subprocess.STDOUT)
def wait_file(name):
    until = time.monotonic() + 40
    while time.monotonic() < until:
        if (root / name).exists():
            return
        time.sleep(.1)
    raise RuntimeError('timeout: ' + name + '\n' + run(['tmux', '-L', socket, 'capture-pane', '-p', '-S', '-100']))
try:
    run(['tmux', '-L', socket, 'new-session', '-d', '-s', 'fixture', '-x', '120', '-y', '40',
         shlex.join([sys.argv[3], str(pathlib.Path(__file__).with_suffix('.ts'))])])
    wait_file('ready')
    before = json.loads(run(cli + ['list', '--json']))
    assert len(before) == 1, before
    request = 'fixture-pending-' + pending
    ack = json.loads(run(cli + ['request', '--instance', before[0]['identity']['instanceId'], '--request-id', request, '--json']))
    wait_file('successor-ready')
    wait_file('provider.jsonl')
    time.sleep(2)
    after = json.loads(run(cli + ['list', '--json']))
    calls = [json.loads(line) for line in (root / 'provider.jsonl').read_text().splitlines()]
    result = dict(before=before, ack=ack, after=after, calls=[call for call in calls if call["successor"]])
    (root / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
finally:
    subprocess.run(['tmux', '-L', socket, 'kill-server'], env=env, capture_output=True)
