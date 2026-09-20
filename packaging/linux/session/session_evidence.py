"""Read-only OEM session evidence. Symlinks are recorded, never silently dereferenced."""
import hashlib
import json
import os
import pathlib
import stat

ALLOWED_ROOTS = ('/usr/lib/systemd/user', '/lib/systemd/user', '/etc/systemd/user',
                 '/usr/share/gnome-session/sessions')
SYSTEMD_PREFIXES = ('gnome-session', 'org.gnome.Shell', 'org.gnome.SettingsDaemon',
                    'graphical-session', 'gnome-keyring', 'dbus.', 'pipewire',
                    'wireplumber', 'xdg-desktop-portal')


def selected_name(name, scope):
    if scope == 'oem-systemd':
        # Our new instance/drop-ins are reviewed package inputs, not OEM baseline.
        return name.startswith(SYSTEMD_PREFIXES) and '@eve.' not in name
    if scope == 'oem-sessions':
        return name.endswith('.session') and name != 'eve.session'
    if scope is None:
        return True
    raise ValueError('Unknown session evidence directory scope.')


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


def fingerprint(source, scope=None):
    source = pathlib.Path(source)
    before = source.lstat()
    result = {'path': str(source)}
    if stat.S_ISLNK(before.st_mode):
        if scope is not None:
            raise ValueError('A scoped evidence directory must not be a link.')
        result.update(kind='symlink', target=os.readlink(source))
    elif stat.S_ISDIR(before.st_mode):
        entries = []
        for child in sorted(source.iterdir()):
            if not selected_name(child.name, scope):
                continue
            mode = child.lstat().st_mode
            kind = 'symlink' if stat.S_ISLNK(mode) else 'directory' if stat.S_ISDIR(mode) else 'file' if stat.S_ISREG(mode) else 'special'
            entries.append([child.name, kind])
        digest = hashlib.sha256(json.dumps(entries, separators=(',', ':')).encode()).hexdigest()
        result.update(kind='directory', sha256=digest)
        if scope is not None:
            result['scope'] = scope
    elif stat.S_ISREG(before.st_mode):
        if scope is not None:
            raise ValueError('Only directories can have an evidence scope.')
        handle = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(handle)
            if identity(opened) != identity(before):
                raise ValueError('Session evidence changed before reading: ' + str(source))
            digest = hashlib.sha256()
            with os.fdopen(os.dup(handle), 'rb') as content:
                while True:
                    chunk = content.read(65536)
                    if not chunk:
                        break
                    digest.update(chunk)
            if identity(os.fstat(handle)) != identity(before):
                raise ValueError('Session evidence changed during reading: ' + str(source))
            result.update(kind='file', sha256=digest.hexdigest())
        finally:
            os.close(handle)
    else:
        raise ValueError('Unsupported session evidence file type: ' + str(source))
    if identity(source.lstat()) != identity(before):
        raise ValueError('Session evidence changed during inspection: ' + str(source))
    return result


def inside(source, roots):
    return any(source == root or root in source.parents for root in roots)


def ordinary_ancestors(source, roots):
    """Allow known system-root aliases, but never descend a link inside a root."""
    for root in roots:
        if source == root:
            return True
        if root not in source.parents:
            continue
        ancestor = source.parent
        while ancestor != root:
            if not stat.S_ISDIR(ancestor.lstat().st_mode):
                return False
            ancestor = ancestor.parent
        return stat.S_ISDIR(root.lstat().st_mode)
    return False


def collect_evidence(systemd_roots=ALLOWED_ROOTS[:3], session_roots=ALLOWED_ROOTS[3:]):
    """Include nested drop-ins, dependency-directory membership and link targets.
    The target file of an in-scope dependency link is pinned as separate evidence.
    Canonical duplicate system roots (for example /lib -> /usr/lib) are visited once.
    """
    roots = [pathlib.Path(value) for value in (*systemd_roots, *session_roots)]
    evidence = {}
    visited_roots = set()

    def visit(source, scope=None):
        if str(source) in evidence:
            return
        item = fingerprint(source, scope)
        evidence[str(source)] = item
        if item['kind'] == 'directory':
            for child in sorted(source.iterdir()):
                if selected_name(child.name, scope):
                    visit(child)
        elif item['kind'] == 'symlink':
            # Do not follow directory links or an escaping target; its literal
            # link identity still participates in qualification.
            target = pathlib.Path(os.path.normpath(os.path.join(source.parent, item['target'])))
            if inside(target, roots):
                try:
                    if ordinary_ancestors(target, roots):
                        mode = target.lstat().st_mode
                        if stat.S_ISREG(mode) or stat.S_ISLNK(mode):
                            visit(target)
                except FileNotFoundError:
                    pass  # The literal broken link remains evidence; no inferred target.

    for root in roots:
        if not root.exists():
            continue
        canonical = root.resolve()
        if canonical in visited_roots:
            continue
        visited_roots.add(canonical)
        visit(root, 'oem-systemd' if root in [pathlib.Path(value) for value in systemd_roots] else 'oem-sessions')
    return sorted(evidence.values(), key=lambda item: item['path'])


def verify_fingerprints(items, allowed_roots=ALLOWED_ROOTS):
    roots = [pathlib.Path(value) for value in allowed_roots]
    seen = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('path'), str):
            raise ValueError('Invalid session fingerprint record.')
        source = pathlib.Path(item.get('path', ''))
        if not source.is_absolute() or '..' in source.parts or not inside(source, roots) or str(source) in seen:
            raise ValueError('Invalid or duplicate session fingerprint path.')
        seen.add(str(source))
        expected = dict(item)
        expected.setdefault('kind', 'file')  # Previously reviewed file-only records.
        try:
            if not ordinary_ancestors(source, roots):
                raise ValueError('Session evidence must not traverse a directory link.')
            if expected.get('scope') is not None and source not in roots:
                raise ValueError('Only a system evidence root can use a filtered scope.')
            actual = fingerprint(source, expected.get('scope'))
        except OSError as error:
            raise ValueError('The OEM session evidence is unavailable: ' + str(source)) from error
        if actual != expected:
            raise ValueError('The OEM session graph changed after review: ' + str(source))
