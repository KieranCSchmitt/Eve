#!/usr/bin/env python3
"""GDM session entry. Eve-only variables are scoped to Eve units, never imported globally."""
import argparse
import os
import pathlib
import shutil
import signal
import subprocess
import time
import uuid
from qualification import check_installed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', default='/etc/eve-session/qualification.json')
    parser.add_argument('--qualification', action='store_true')
    args = parser.parse_args()
    try:
        check_installed(args.profile, args.qualification, os.environ.get('XDG_SESSION_TYPE'))
    except Exception as error:
        if shutil.which('zenity'):
            subprocess.run(['zenity', '--error', '--title=Eve session unavailable', '--text=' + str(error) + '\nSelect the stock desktop from the login screen.'], check=False)
        raise SystemExit(str(error))
    runtime = pathlib.Path(os.environ['XDG_RUNTIME_DIR']) / 'eve-session'
    runtime.mkdir(mode=0o700, exist_ok=True)
    instance = uuid.uuid4().hex
    environment_file = runtime / (instance + '.env')
    with environment_file.open('x') as file:
        os.chmod(environment_file, 0o600)
        file.write('EVE_SESSION_ID=' + instance + '\nEVE_SESSION=1\nDCONF_PROFILE=eve\n')
    unit = 'eve-session@' + instance + '.target'
    environment = dict(os.environ)
    # gnome-session publishes its own environment to the user manager. Do not put Eve-only state there.
    for key in ('DCONF_PROFILE', 'GNOME_SHELL_SESSION_MODE', 'EVE_SESSION', 'EVE_SESSION_ID'):
        environment.pop(key, None)
    session = subprocess.Popen(['gnome-session', '--session=eve'], env=environment)
    stopping = False

    def terminate(_signal, _frame):
        nonlocal stopping
        stopping = True
        # Ask the real session manager. It negotiates dirty work and never force-kills the shell here.
        subprocess.run(['gnome-session-quit', '--logout', '--no-prompt'], check=False)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        deadline = time.monotonic() + 35
        while session.poll() is None and not stopping:
            ready = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.gnome.SessionManager', '--object-path', '/org/gnome/SessionManager', '--method', 'org.gnome.SessionManager.IsSessionRunning'], capture_output=True, text=True, check=False)
            if ready.returncode == 0 and 'true' in ready.stdout.lower():
                subprocess.run(['systemctl', '--user', 'start', unit], check=True)
                break
            if time.monotonic() > deadline:
                raise RuntimeError('GNOME did not reach a usable session state. Return to the stock desktop.')
            time.sleep(0.15)
        return session.wait()
    finally:
        subprocess.run(['systemctl', '--user', 'stop', unit], check=False)
        environment_file.unlink(missing_ok=True)


if __name__ == '__main__':
    raise SystemExit(main())
