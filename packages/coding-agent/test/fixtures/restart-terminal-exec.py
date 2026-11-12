"""Model a late foreground change beyond the predecessor's final reclaim."""
import os
import signal
import sys
if sys.argv[3] == 'foreground':
    # A tty-owning child/cleanup path changes the pgrp after the old guard ended.
    # No stop signal is injected: any stop comes from a real tty operation.
    saved = signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    os.tcsetpgrp(0, os.getppid())
    # Restore the inherited disposition, so this wrapper doesn't fix the bug.
    signal.signal(signal.SIGTTOU, saved)
os.execv(sys.argv[1], sys.argv[1:])
