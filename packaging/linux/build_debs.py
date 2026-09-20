#!/usr/bin/env python3
"""Assemble versioned arm64 Debian artifacts from a target-built Electron app and reviewed session graph."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent


def write(root, relative, content, executable=False):
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(content)
    destination.chmod(0o755 if executable else 0o644)


def control(root, name, version, depends, description):
    write(root, 'DEBIAN/control', '\n'.join([
        'Package: ' + name, 'Version: ' + version, 'Architecture: arm64',
        'Maintainer: Eve Project <maintainer@localhost>', 'Section: x11', 'Priority: optional',
        'Depends: ' + depends, 'Description: ' + description, '',
    ]))


def finish(root, output, package, version):
    target = output / (package + '_' + version + '_arm64.deb')
    subprocess.run(['dpkg-deb', '--root-owner-group', '--build', str(root), str(target)], check=True)
    return {'file': target.name, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}


def build_app(app_directory, root, version):
    executable = app_directory / 'eve'
    if not executable.is_file() or not ((app_directory / 'resources/app.asar').exists() or (app_directory / 'resources/app/package.json').exists()):
        raise ValueError('Pass the unpacked Linux arm64 Electron app containing eve and resources/app(.asar).')
    result = subprocess.check_output(['file', str(executable)], text=True)
    if 'ELF' not in result or not any(value in result.lower() for value in ('aarch64', 'arm64')):
        raise ValueError('The application must be a Linux arm64 build, not copied Mac dependencies.')
    control(root, 'eve-app', version, 'python3, libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libxss1, libx11-xcb1', 'Eve task-centered desktop application')
    shutil.copytree(app_directory, root / 'opt/eve', symlinks=True)
    write(root, 'usr/bin/eve', '#!/bin/sh\nexec /opt/eve/eve "$@"\n', True)
    write(root, 'usr/share/applications/org.eve.Shell.desktop', '[Desktop Entry]\nName=Eve\nComment=A place to think\nExec=/usr/bin/eve --app\nTryExec=/usr/bin/eve\nType=Application\nCategories=Office;Development;\nStartupWMClass=eve\nTerminal=false\n')


def build_session(root, version, profile_path, graph_directory):
    profile = json.loads(profile_path.read_text())
    import sys
    sys.path.insert(0, str(HERE / 'session'))
    from qualification import validate_profile, reviewed_dependencies
    validate_profile(profile, profile.get('gnomeVersion', ''), profile.get('backend'), profile.get('status') == 'candidate')
    if profile['backend'] != 'wayland':
        raise ValueError('The X11 adapter must be separately implemented and qualified if the OEM installation supports it.')
    dependencies = reviewed_dependencies(profile)
    control(root, 'eve-session', version, 'eve-app (= ' + version + '), gnome-session, gnome-shell (>= 46), gnome-shell (<< 47), gnome-control-center, python3, python3-gi, gir1.2-gtk-3.0, zenity, dconf-cli, libglib2.0-bin, network-manager, wireplumber', 'Qualified GNOME session integration for Eve')
    destination = root / 'usr/lib/eve-session'
    destination.mkdir(parents=True)
    for filename in ('launch.py', 'qualification.py', 'session_evidence.py', 'supervise.py'):
        shutil.copy2(HERE / 'session' / filename, destination / filename)
        (destination / filename).chmod(0o755)
    shutil.copy2(HERE.parent.parent / 'packages/platform/scripts/session-bridge.py', destination / 'session-bridge.py')
    write(root, 'etc/eve-session/qualification.json', json.dumps(profile, indent=2) + '\n')
    write(root, 'DEBIAN/conffiles', '/etc/eve-session/qualification.json\n')
    for source, target in [('eve.json', 'usr/share/gnome-shell/modes/eve.json'), ('eve.session', 'usr/share/gnome-session/sessions/eve.session'), ('dconf-profile', 'etc/dconf/profile/eve'), ('dconf-defaults', 'etc/dconf/db/eve.d/00-eve')]:
        write(root, target, (HERE / 'session' / source).read_text())
    extension = root / 'usr/share/gnome-shell/extensions/eve-session@eve.desktop'
    shutil.copytree(HERE / 'session/extension', extension)
    subprocess.run(['glib-compile-schemas', str(extension / 'schemas')], check=True)
    units = root / 'usr/lib/systemd/user'
    shutil.copytree(HERE / 'session/systemd', units)
    # A reviewed override graph is required: upstream and OEM targets differ and must not be guessed.
    if not graph_directory.is_dir() or not any(graph_directory.iterdir()):
        raise ValueError('The recorded OEM session graph override directory is missing.')
    for source in graph_directory.rglob('*'):
        if source.is_dir():
            continue
        relative = source.relative_to(graph_directory)
        if source.is_symlink() or not ('eve' in str(relative) and source.suffix in ('.conf', '.target', '.service')):
            raise ValueError('Session graph overrides must be Eve-scoped regular unit files.')
        content = source.read_text()
        if 'import-environment' in content or 'set-environment' in content:
            raise ValueError('Do not export Eve configuration into the account-global user manager.')
        write(root, 'usr/lib/systemd/user/' + str(relative), content)
    write(root, 'usr/lib/systemd/user/gnome-session@eve.target.d/50-eve.conf',
          '[Unit]\nRequires=' + ' '.join(['org.eve.Shell@wayland.service', *dependencies['requires']]) + '\n' +
          ('Wants=' + ' '.join(dependencies['wants']) + '\n' if dependencies['wants'] else ''))
    desktop = (HERE / 'session/eve.desktop').read_text()
    if profile['status'] == 'candidate':
        desktop = desktop.replace('Name=Eve\n', 'Name=Eve (Qualification)\n').replace('Exec=/usr/lib/eve-session/launch.py', 'Exec=/usr/lib/eve-session/launch.py --qualification')
    write(root, 'usr/share/wayland-sessions/eve.desktop', desktop)
    write(root, 'DEBIAN/postinst', '#!/bin/sh\nset -eu\nif [ "$1" = configure ]; then\n  dconf update\nfi\n', True)
    write(root, 'DEBIAN/postrm', '#!/bin/sh\nset -eu\nif [ "$1" = remove ] || [ "$1" = purge ]; then\n  if command -v dconf >/dev/null 2>&1; then dconf update; fi\nfi\n', True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app-dir', type=pathlib.Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--session-profile', type=pathlib.Path)
    parser.add_argument('--session-graph', type=pathlib.Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9][A-Za-z0-9.+~-]*', args.version):
        raise SystemExit('Invalid Debian version.')
    if bool(args.session_profile) != bool(args.session_graph):
        raise SystemExit('Session packaging requires both --session-profile and --session-graph.')
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {'version': args.version, 'architecture': 'arm64', 'artifacts': [], 'hardwareQualified': False}
    with tempfile.TemporaryDirectory(prefix='eve-deb-') as temporary:
        app = pathlib.Path(temporary) / 'app'
        build_app(args.app_dir.resolve(), app, args.version)
        manifest['artifacts'].append(finish(app, args.output, 'eve-app', args.version))
        if args.session_profile:
            session = pathlib.Path(temporary) / 'session'
            build_session(session, args.version, args.session_profile.resolve(), args.session_graph.resolve())
            manifest['artifacts'].append(finish(session, args.output, 'eve-session', args.version))
            manifest['hardwareQualified'] = json.loads(args.session_profile.read_text())['status'] == 'qualified'
    (args.output / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
