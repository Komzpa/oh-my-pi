"""A real interactive shell owns a PTY; observe its job across in-place exec."""
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import sys
import tempfile
import time

bun, fixture, wrapper, successor, shell, mode = sys.argv[1:]
# Fail at the missing prerequisite rather than hiding execv's error in the PTY.
assert os.access(shell, os.X_OK), f'required interactive shell is unavailable: {shell}'
with tempfile.TemporaryDirectory(prefix='omp-restart-tty-') as directory:
    report = Path(directory) / 'report.json'
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(HOME=directory, XDG_CONFIG_HOME=directory+'/config',
                          XDG_CACHE_HOME=directory+'/cache', XDG_DATA_HOME=directory+'/data',
                          XDG_STATE_HOME=directory+'/state', XDG_RUNTIME_DIR=directory+'/run',
                          PS1='probe> ', PROMPT='probe> ')
        os.execv(shell, [shell, '-f', '-i'] if shell.endswith('zsh') else [shell, '--norc', '--noprofile', '-i'])
    output = bytearray()
    job = None
    stopped = False
    def drain():
        if select.select([fd], [], [], .005)[0]:
            try: output.extend(os.read(fd, 65536))
            except OSError: pass
    try:
        for _ in range(20): drain()
        command = shlex.join([bun, fixture, mode, str(report), wrapper, sys.executable, successor])
        os.write(fd, ('set -m\n'+command+(' &' if mode == 'background' else '')+'\n').encode())
        deadline = time.monotonic()+8
        while time.monotonic() < deadline:
            drain()
            if report.exists() and job is None:
                try: job = json.loads(report.read_text())
                except ValueError: continue
            if job:
                try:
                    state = Path(f'/proc/{job["pid"]}/stat').read_text().split(') ')[1].split()[0]
                    stopped |= state in ('T', 't')
                except FileNotFoundError: pass
            if stopped or Path(str(report)+'.done').exists(): break
        os.write(fd, b'jobs -l\n')
        for _ in range(20): drain()
        text = output.decode(errors='replace')
        assert not stopped, 'job entered stopped state\n'+text
        assert 'suspended' not in text.lower() and 'stopped' not in text.lower(), text
        assert Path(str(report)+'.done').exists(), 'successor did not finish\n'+text
        done = json.loads(Path(str(report)+'.done').read_text())
        assert done['pid'] == job['pid'], (job, done)
        expected = pid if mode == 'background' else job['pgid']
        assert os.tcgetpgrp(fd) == expected, (expected, done, text)
        assert done['foreground'] == expected, done
        assert done['reaped'], 'pre-exec child remains a zombie: '+str(done)
        assert done['freshExit'] == 7, 'reaper stole a new Bun child status'
        print(json.dumps(dict(shell=shell, mode=mode, stopped=stopped, **done)))
    finally:
        if job:
            try: os.killpg(job['pgid'], signal.SIGKILL)
            except ProcessLookupError: pass
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(fd)
