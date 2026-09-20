#!/usr/bin/env python3
"""Session-owned Eve supervisor with independent recovery; never touches stock desktop units."""
import collections
import os
import shutil
import signal
import subprocess
import time


def restart_allowed(previous_exits, now):
    recent = [value for value in previous_exits if now - value < 60]
    return len(recent) < 3


def main():
    if os.environ.get('EVE_SESSION') != '1' or not os.environ.get('EVE_SESSION_ID'):
        raise SystemExit('The session supervisor requires its own session identity.')
    if not shutil.which('zenity'):
        raise SystemExit('The independent recovery UI is unavailable; do not enter this session.')
    exits = collections.deque(maxlen=3)
    child = None
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
        if child and child.poll() is None:
            child.send_signal(signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping:
        child = subprocess.Popen(['/usr/bin/eve', '--session', '--session-id', os.environ['EVE_SESSION_ID']])
        code = child.wait()
        if stopping:
            return code
        if code == 0:
            subprocess.run(['gnome-session-quit', '--logout', '--no-prompt'], check=False)
            return 0
        exits.append(time.monotonic())
        if restart_allowed(exits, time.monotonic()):
            continue
        recovery = subprocess.run(['zenity', '--question', '--title=Eve needs a moment', '--text=Eve has stopped repeatedly. Your recovery snapshots remain on this computer.', '--ok-label=Restart Eve', '--cancel-label=Log Out'], check=False)
        if recovery.returncode == 0:
            exits.clear()
        else:
            subprocess.run(['gnome-session-quit', '--logout', '--no-prompt'], check=False)
            return 0


if __name__ == '__main__':
    raise SystemExit(main())
