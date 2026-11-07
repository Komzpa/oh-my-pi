"""Private PTY + real job-control shell; never touches the caller's terminal."""
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import sys
import tempfile
import termios
import time

bun, fixture, shell, scenario, keyboard = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='omp-job-control-') as directory:
    report = Path(directory) / 'pid'
    pid, fd = pty.fork()
    if pid == 0:
        for key in list(os.environ):
            if key.startswith(('OMP_', 'PI_')): os.environ.pop(key)
        os.environ.update(HOME=directory, XDG_CONFIG_HOME=directory+'/config',
                          XDG_CACHE_HOME=directory+'/cache', XDG_DATA_HOME=directory+'/data',
                          XDG_STATE_HOME=directory+'/state', XDG_RUNTIME_DIR=directory+'/run',
                          PS1='probe> ', PROMPT='probe> ', TERM='xterm-256color',
                          PI_TUI_NATIVE='0')
        os.execv(shell, [shell, '-f', '-i'] if shell.endswith('zsh') else [shell, '--norc', '--noprofile', '-i'])
    output = bytearray()
    job = None
    def drain():
        if select.select([fd], [], [], .02)[0]:
            try: output.extend(os.read(fd, 65536))
            except OSError: pass
    def wait(predicate, message):
        deadline = time.monotonic()+12
        while time.monotonic() < deadline:
            drain()
            if predicate(): return
        raise AssertionError(message+repr((globals().get('initial'), termios.tcgetattr(fd)))+'\n'+output.decode(errors='replace')[-5000:])
    def state():
        return Path(f'/proc/{job}/stat').read_text().split(') ')[1].split()[0]
    def raw():
        a = termios.tcgetattr(fd)
        return not (a[3] & (termios.ICANON | termios.ECHO | termios.ISIG)) and not (a[0] & (termios.ICRNL | termios.IXON))
    try:
        wait(lambda: b'probe> ' in output, 'shell prompt missing')
        for _ in range(10): drain()
        output.clear()
        command = shlex.join([bun, fixture, str(report), 'overlay' if keyboard == 'kitty' else 'normal'])
        os.write(fd, ('set -m\n'+command+(' &' if scenario == 'background' else '')+'\n').encode())
        wait(report.exists, 'fixture did not start')
        job = int(report.read_text())
        if scenario == 'background':
            for _ in range(20): drain()
            assert os.tcgetpgrp(fd) == pid, 'background launch stole foreground'
            assert not raw(), 'background launch changed shell termios'
            assert b'\x1b[?2004h\x1b[?1l\x1b>' not in output, 'background launch enabled protocols'
            os.write(fd, b'fg\n')
        wait(raw, 'initial terminal not raw')
        initial = termios.tcgetattr(fd)
        if scenario == "background":
            wait(lambda: b"\x1b[?5522h" in output, "foreground startup lost queued enhanced-paste mode")
        # Supply a real terminal reply so both negotiated keyboard branches run.
        os.write(fd, b'\x1b[?0u' if keyboard == 'kitty' else b'\x1b[?1;2c')
        expected_key = b'\x1b[=5;1u' if keyboard == 'kitty' else b'\x1b[>4;2m'
        wait(lambda: (b'\x1b[>5u' if keyboard == 'kitty' else expected_key) in output, 'keyboard negotiation failed')
        if scenario != 'background':
            if scenario == 'TTIN':
                # Reproduce the actual incident: TTIN while backgrounded after
                # the shell has already restored its own termios.
                os.kill(job, signal.SIGSTOP)
                wait(lambda: state() in ('T', 't') and os.tcgetpgrp(fd) == pid, 'initial stop failed')
                os.write(fd, b'bg\n')
                for _ in range(10): drain()
            if scenario == 'TSTP':
                # Keep the shell from repairing termios on our behalf: the TUI
                # must hand back cooked mode before it actually stops.
                os.kill(pid, signal.SIGSTOP)
            os.kill(job, getattr(signal, 'SIG'+('TSTP' if scenario == 'bg-continue' else scenario)))
            wait(lambda: state() in ('T','t'), 'job did not stop')
            if scenario == 'TSTP':
                flags = termios.tcgetattr(fd)[3]
                assert flags & termios.ICANON and flags & termios.ECHO, 'TSTP left shell in raw mode'
                os.kill(pid, signal.SIGCONT)
            wait(lambda: os.tcgetpgrp(fd) == pid, 'shell did not regain foreground')
            # The shell restores its saved modes, as in the incident.
            for _ in range(10): drain()
            output.clear()
            if scenario == 'bg-continue':
                os.write(fd, b'bg\n')
                wait(lambda: state() not in ('T', 't'), 'bg did not continue job')
                for _ in range(20): drain()
                assert not raw(), 'background SIGCONT changed shell termios'
                assert b'\x1b[?2004h\x1b[?1l\x1b>' not in output, 'background SIGCONT enabled protocols'
                output.clear()
            os.write(fd, b'fg\n')
            wait(lambda: os.tcgetpgrp(fd) == job, 'fg did not foreground job')
            wait(lambda: termios.tcgetattr(fd) == initial, 'fg failed to restore exact initial raw termios')
            wait(lambda: b'\x1b[?2004h' in output and b'\x1b[?5522h' in output and expected_key in output, 'resume did not restore protocols')
            if keyboard == 'kitty':
                wait(lambda: b'\x1b[?1049h' in output and b'\x1b[?1006h' in output, 'overlay protocols missing')
            wait(lambda: b'bc' in output, 'full repaint missing unchanged editor content')
        os.write(fd, b'\x1b[3~')
        wait(lambda: Path(str(report)+'.text').exists(), 'Delete was not delivered to editor')
        assert Path(str(report)+'.text').read_text() == 'bc', 'Delete inserted escape text instead of editing'
        print(json.dumps(dict(shell=shell, scenario=scenario, keyboard=keyboard, raw_equal=True, delete='bc')))
    finally:
        if job:
            try: os.killpg(job, signal.SIGKILL)
            except ProcessLookupError: pass
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(fd)
