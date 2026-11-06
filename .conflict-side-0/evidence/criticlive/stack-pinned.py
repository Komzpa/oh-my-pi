"""Canonical stack checker, with only its upstream-base lookup pinned for comparison."""
import importlib.util
import subprocess
import sys
from pathlib import Path

checker = Path('/home/kom/Dropbox/Reemxy/tasks-loop/tools/omp/stack_check.py')
spec = importlib.util.spec_from_file_location('canonical_stack', checker)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_git = module.git
base = '9370e7bfe26e948d72f53f918e681b402e600383'

def pinned_git(repo, *args, **kwargs):
    if args == ('rev-parse', 'FETCH_HEAD'):
        return subprocess.CompletedProcess(args, 0, base + '\n', '')
    return original_git(repo, *args, **kwargs)

module.git = pinned_git
print('Rehearsal only: upstream base pinned to', base, flush=True)
sys.argv = [str(checker), '--repo', '.', '--no-fetch', '--candidate', 'topic/rt-agent-runtime-core=' + sys.argv[1]]
raise SystemExit(module.main())
