#!/usr/bin/env python3
"""Own the workbench flock and process group; never signal a PID read from disk."""
import ctypes
import array
import select
import errno
import fcntl
import hmac
import json
import os
import platform
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid

MARKER = b'eve-workbench-supervisor-v1\n'
RECOVERY_MARKER = b'eve-workbench-recovery-v1\n'


def identity(pid):
    """A kernel birth identity, not wall-clock elapsed time or a command-name heuristic."""
    if not isinstance(pid, int) or pid <= 1:
        raise RuntimeError('Invalid process identity PID.')
    if platform.system() == 'Linux':
        try:
            with open('/proc/{}/stat'.format(pid)) as handle:
                fields = handle.read().rsplit(')', 1)[1].split()
            with open('/proc/sys/kernel/random/boot_id') as handle:
                boot = handle.read().strip()
            if fields[0] == 'Z':
                return None
            uid = os.stat('/proc/{}'.format(pid)).st_uid
            return dict(pid=pid, uid=uid, pgid=int(fields[2]), start='linux:{}:{}'.format(boot, fields[19]))
        except FileNotFoundError:
            return None
    if platform.system() == 'Darwin':
        class BsdInfo(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint32) for name in ('flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid', 'rgid', 'svuid', 'svgid', 'rfu')]
            _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
            _fields_ += [(name, ctypes.c_uint32) for name in ('nfiles', 'pgid', 'jobc', 'tdev', 'tpgid')]
            _fields_ += [('nice', ctypes.c_int32), ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]
        library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        info = BsdInfo()
        count = library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if count != ctypes.sizeof(info):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return None
            raise RuntimeError('Cannot establish the process birth identity.')
        if info.status == 5:  # SZOMB: an unreaped host cannot still own the profile.
            return None
        return dict(pid=pid, uid=info.uid, pgid=info.pgid, start='darwin:{}:{}'.format(info.start_sec, info.start_usec))
    raise RuntimeError('Safe workbench ownership is qualified only on Linux and macOS.')


def same_identity(expected, observed):
    return observed is not None and all(expected.get(key) == observed.get(key) for key in ('pid', 'uid', 'start', 'pgid'))


def owner_alive(expected, observed):
    if observed is None or expected['pid'] != observed['pid'] or expected['start'] != observed['start']:
        return False
    if expected['uid'] != observed['uid']:
        raise RuntimeError('The original host changed UID; ownership needs review.')
    # Process groups may change without ending the host process's lifetime.
    return True


def validate_identity(value):
    if not isinstance(value, dict) or set(value) != {'pid', 'uid', 'start', 'pgid'} or not isinstance(value['start'], str) or not value['start']:
        raise RuntimeError('Ambiguous process identity metadata.')
    if any(not isinstance(value[key], int) or value[key] < 0 for key in ('pid', 'uid', 'pgid')) or value['pid'] <= 1:
        raise RuntimeError('Ambiguous process identity metadata.')
    return value


def private(pathname, directory=False):
    info = os.lstat(pathname)
    if info.st_uid != os.getuid() or info.st_mode & 0o077 or (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode)):
        raise RuntimeError('Unsafe private workbench path: {}'.format(os.path.basename(pathname)))


def read_json(pathname):
    private(pathname)
    with open(pathname) as handle:
        data = handle.read(65537)
    if len(data) > 65536:
        raise RuntimeError('Workbench metadata exceeds its bound.')
    return json.loads(data)


def durable_json(pathname, value):
    temporary = pathname + '.' + uuid.uuid4().hex + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, pathname)
        directory = os.open(os.path.dirname(pathname), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_metadata(value, profile):
    if not isinstance(value, dict) or value.get('version') != 1 or value.get('profile') != profile or value.get('status') not in ('owned', 'running', 'stopped'):
        raise RuntimeError('Ambiguous workbench ownership metadata; no process was signalled.')
    validate_identity(value.get('owner'))
    guardian = validate_identity(value.get('guardian'))
    if guardian['uid'] != os.getuid() or value['owner']['uid'] != os.getuid() or guardian['pgid'] != guardian['pid']:
        raise RuntimeError('Workbench process-group ownership could not be established.')
    runtime = value.get('runtime')
    if not isinstance(runtime, str) or not os.path.basename(runtime).startswith('eve-wb-') or not os.path.isabs(runtime):
        raise RuntimeError('Ambiguous workbench runtime metadata.')
    if not isinstance(value.get('instance'), str) or len(value['instance']) > 100:
        raise RuntimeError('Invalid workbench instance metadata.')
    return value


def group_members(pgid):
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,pgid=,uid=,stat='], check=True, capture_output=True, text=True)
    members = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) != 4:
            raise RuntimeError('Cannot establish old process-group membership.')
        if int(fields[1]) == pgid and not fields[3].startswith('Z'):
            members.append(int(fields[0]))
    return members


def request_stop(metadata):
    # A recycled guardian PID, missing guardian, or mismatched session is never signalled.
    if not same_identity(metadata['guardian'], identity(metadata['guardian']['pid'])):
        raise RuntimeError('The original supervisor identity is unavailable; ownership needs review.')
    private(metadata['runtime'], directory=True)
    old_spec = read_json(os.path.join(metadata['runtime'], 'supervisor.json'))
    if old_spec.get('instance') != metadata['instance'] or old_spec.get('profileDirectory') != metadata['profile']:
        raise RuntimeError('The original supervisor credential does not match its lock.')
    nonce = uuid.uuid4().hex
    request = dict(type='orphan-stop', token=old_spec['supervisorToken'], instance=metadata['instance'], owner=metadata['owner'], nonce=nonce)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(os.path.join(metadata['runtime'], 'supervisor.sock'))
        client.sendall(json.dumps(request).encode() + b'\n')
        reply = json.loads(client.makefile('rb').readline(8193))
    if reply.get('nonce') != nonce or not reply.get('ok') or reply.get('guardian') != metadata['guardian']:
        raise RuntimeError('The original supervisor refused orphan recovery; no PID fallback is permitted.')


def acquire(profile):
    lock_path = os.path.join(profile, 'workbench.lock')
    created = False
    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = True
    except FileExistsError:
        private(lock_path)
        fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    if created:
        os.write(fd, MARKER)
        os.fsync(fd)
    elif os.read(fd, 1024) != MARKER:
        os.close(fd)
        raise RuntimeError('Legacy or ambiguous workbench.lock preserved. Review its owner before migration; it was not deleted.')
    metadata_path = os.path.join(profile, 'workbench-owner.json')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        metadata = validate_metadata(read_json(metadata_path), profile)
        if owner_alive(metadata['owner'], identity(metadata['owner']['pid'])):
            raise RuntimeError('This workbench profile is already owned by a live host.')
        request_stop(metadata)
        deadline = time.monotonic() + 7
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('The orphan supervisor has not released its profile; no lock was removed.')
                time.sleep(0.04)
    if os.path.exists(metadata_path):
        metadata = validate_metadata(read_json(metadata_path), profile)
        if metadata['status'] != 'stopped' and owner_alive(metadata['owner'], identity(metadata['owner']['pid'])):
            raise RuntimeError('The recorded host is still alive; profile ownership needs review.')
        if group_members(metadata['guardian']['pgid']):
            raise RuntimeError('An old process group remains without a controllable supervisor. Profile and snapshots were preserved for review.')
    return fd


def acquire_recovery(directory):
    """Independent profile roots must never share a writable recovery namespace.

    The original profile lock performs authenticated orphan retirement first. If a
    different profile still owns this namespace, refuse rather than adopt or kill it.
    The permanent inode contains no PID/credentials and is excluded from backup.
    """
    private(directory, directory=True)
    lock_path = os.path.join(directory, 'workbench.lock')
    created = False
    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = True
    except FileExistsError:
        private(lock_path)
        fd = os.open(lock_path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError('Unsafe recovery lock was preserved.')
        if created:
            os.write(fd, RECOVERY_MARKER)
            os.fsync(fd)
            parent = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        elif os.read(fd, 1024) != RECOVERY_MARKER:
            raise RuntimeError('Ambiguous recovery lock was preserved for review.')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('This recovery directory is already owned by another workbench profile.')
        # Confirm the pathname still designates our locked inode.
        current = os.lstat(lock_path)
        if current.st_dev != info.st_dev or current.st_ino != info.st_ino:
            raise RuntimeError('Recovery lock identity changed; no journal was written.')
        return fd
    except BaseException:
        os.close(fd)
        raise


def enable_pause_support():
    """Linux pidfds pin process lifetime; subreaping retains detached descendants."""
    if platform.system() != 'Linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        return False
    library = ctypes.CDLL(None, use_errno=True)
    if library.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return False
    probe = os.pidfd_open(os.getpid())
    os.close(probe)
    return True


def linux_process(pid):
    try:
        with open('/proc/{}/stat'.format(pid)) as handle:
            fields = handle.read().rsplit(')', 1)[1].split()
        return dict(pid=pid, ppid=int(fields[1]), pgid=int(fields[2]), state=fields[0],
                    uid=os.stat('/proc/{}'.format(pid)).st_uid, start=fields[19])
    except (FileNotFoundError, ProcessLookupError):
        return None


def descendant_inventory(excluded):
    processes = {}
    for name in os.listdir('/proc'):
        if name.isdigit():
            value = linux_process(int(name))
            if value is not None:
                processes[value['pid']] = value
    selected = {os.getpid()}
    previous = None
    while previous != selected:
        previous = set(selected)
        selected.update(pid for pid, value in processes.items() if value['ppid'] in selected and pid not in excluded)
    return {pid: processes[pid] for pid in selected if pid != os.getpid() and pid in processes and processes[pid]['state'] != 'Z'}


def threads_stopped(pid):
    try:
        threads = os.listdir('/proc/{}/task'.format(pid))
        if not threads:
            return False
        for tid in threads:
            with open('/proc/{}/task/{}/stat'.format(pid, tid)) as handle:
                state = handle.read().rsplit(')', 1)[1].split()[0]
            if state not in ('T', 't'):
                return False
        return True
    except (FileNotFoundError, ProcessLookupError):
        return False


def descriptor_pid(fd):
    with open('/proc/self/fdinfo/{}'.format(fd)) as handle:
        for line in handle:
            if line.startswith('Pid:'):
                return int(line.split(':', 1)[1])
    raise RuntimeError('Cannot establish the pidfd kernel identity.')


def pin_descendant(expected, excluded):
    fd = os.pidfd_open(expected['pid'])
    try:
        observed = descendant_inventory(excluded).get(expected['pid'])
        if descriptor_pid(fd) != expected['pid'] or observed is None or any(expected[key] != observed[key] for key in ('pid', 'uid', 'start')) or observed['uid'] != os.getuid():
            raise RuntimeError('Owned descendant identity changed before it could be pinned.')
        return fd, observed
    except BaseException:
        os.close(fd)
        raise


def resume_descriptors(targets):
    errors = []
    for value in targets.values():
        if value['stopped']:
            try:
                signal.pidfd_send_signal(value['fd'], signal.SIGCONT)
                value['stopped'] = False
            except ProcessLookupError:
                value['stopped'] = False
            except OSError as error:
                errors.append(str(error))
    return errors


def pause_watchdog(channel, guardian_fd, ttl):
    """Independent resumer. Never inherits the profile lock or participates in the frozen tree."""
    os.setsid()
    keep = {0, 1, 2, channel.fileno(), guardian_fd}
    for name in os.listdir('/proc/self/fd'):
        if int(name) not in keep:
            try:
                os.close(int(name))
            except OSError:
                pass
    targets = {}
    deadline = time.monotonic() + ttl
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([channel, guardian_fd], [], [], min(remaining, 0.2))
            if guardian_fd in ready:
                break
            if channel not in ready:
                continue
            data, ancillary, _flags, _address = channel.recvmsg(4096, socket.CMSG_SPACE(array.array('i').itemsize))
            if not data:
                break
            request = json.loads(data)
            received = []
            for level, kind, raw in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    values = array.array('i')
                    values.frombytes(raw[:len(raw) - len(raw) % values.itemsize])
                    received.extend(values)
            try:
                if request['type'] == 'pin':
                    if len(received) != 1 or request['key'] in targets:
                        raise RuntimeError('Invalid watchdog descriptor transfer.')
                    target = dict(fd=received.pop(), stopped=request['stop'] is True)
                    targets[request['key']] = target
                    # The guardian records this same authorized stop intent before dispatch.
                    # A process already stopped at acquisition is never signalled/resumed.
                    if target['stopped']:
                        signal.pidfd_send_signal(target['fd'], signal.SIGSTOP)
                elif request['type'] == 'renew':
                    deadline = time.monotonic() + ttl
                elif request['type'] == 'release':
                    errors = resume_descriptors(targets)
                    channel.send(json.dumps(dict(ok=not errors, errors=errors)).encode())
                    return
                else:
                    raise RuntimeError('Unknown watchdog command.')
                channel.send(b'{"ok":true}')
            finally:
                for fd in received:
                    os.close(fd)
    finally:
        resume_descriptors(targets)
        for value in targets.values():
            os.close(value['fd'])
        channel.close()
        os.close(guardian_fd)


class PauseLease:
    def __init__(self, lease_id, ttl):
        self.lease_id = lease_id
        self.ttl = ttl
        self.targets = {}
        self.deadline = time.monotonic() + ttl
        self.ended = None
        self.watchdog_pid = None
        self.channel = None

    def request(self, value, fd=None):
        ancillary = [] if fd is None else [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))]
        self.channel.sendmsg([json.dumps(value).encode()], ancillary)
        response = json.loads(self.channel.recv(4096))
        if not response.get('ok'):
            raise RuntimeError('The independent pause watchdog refused control.')

    def acquire(self):
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        guardian_fd = os.pidfd_open(os.getpid())
        self.watchdog_pid = os.fork()
        if self.watchdog_pid == 0:
            parent.close()
            try:
                pause_watchdog(child, guardian_fd, self.ttl)
            finally:
                os._exit(0)
        child.close()
        os.close(guardian_fd)
        self.channel = parent
        self.channel.settimeout(2)
        excluded = {self.watchdog_pid}
        deadline = time.monotonic() + 3
        try:
            while time.monotonic() < deadline:
                inventory = descendant_inventory(excluded)
                if not inventory:
                    raise RuntimeError('No live owned workbench descendants remain.')
                if len(inventory) > 4096:
                    raise RuntimeError('The owned process tree exceeds the bounded pause limit.')
                # Stop parents before children; subreaping keeps escaped/reparented descendants owned.
                for pid, expected in sorted(inventory.items(), key=lambda item: (item[1]['ppid'] != os.getpid(), item[0])):
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Owned writer discovery exceeded its pause bound.')
                    key = '{}:{}'.format(pid, expected['start'])
                    if key not in self.targets:
                        fd, observed = pin_descendant(expected, excluded)
                        self.targets[key] = dict(fd=fd, identity=observed, stopped=observed['state'] not in ('T', 't'))
                        self.request(dict(type='pin', key=key, stop=self.targets[key]['stopped']), fd)
                if self.all_stopped():
                    # A second inventory after all parents stop catches descendants forked during acquisition.
                    time.sleep(0.02)
                    if self.all_stopped():
                        return self.status()
                time.sleep(0.01)
            raise RuntimeError('Owned writers did not reach a stopped state before the pause bound.')
        except BaseException:
            self.release('acquisition-failed')
            raise

    def all_stopped(self):
        inventory = descendant_inventory({self.watchdog_pid})
        if not inventory:
            return False
        for pid, value in inventory.items():
            key = '{}:{}'.format(pid, value['start'])
            target = self.targets.get(key)
            if target is None or descriptor_pid(target['fd']) != pid or value['state'] not in ('T', 't') or not threads_stopped(pid):
                return False
        return True

    def check(self):
        if self.ended:
            raise RuntimeError('Pause lease ended: ' + self.ended)
        if time.monotonic() >= self.deadline:
            self.release('expired')
            raise RuntimeError('Pause lease expired.')
        observed, _ = os.waitpid(self.watchdog_pid, os.WNOHANG)
        if observed:
            self.watchdog_pid = None
            self.release('watchdog-ended')
            raise RuntimeError('The independent pause watchdog ended.')
        if not self.all_stopped():
            self.release('writer-state-changed')
            raise RuntimeError('Owned writer state changed during the pause lease.')
        return self.status()

    def renew(self):
        self.check()
        started = time.monotonic()
        self.request(dict(type='renew'))
        self.deadline = started + self.ttl
        return self.status()

    def status(self):
        return dict(leaseId=self.lease_id, remainingMs=max(0, int((self.deadline - time.monotonic()) * 1000)),
                    processes=len(self.targets), stoppedByLease=sum(1 for item in self.targets.values() if item['stopped']),
                    preStopped=sum(1 for item in self.targets.values() if not item['stopped']))

    def release(self, reason='released'):
        if self.ended:
            return
        self.ended = reason
        errors = []
        acknowledged = False
        if self.channel is not None:
            try:
                self.request(dict(type='release'))
                acknowledged = True
            except (OSError, ValueError, RuntimeError):
                pass  # The guardian retains the same descriptors as the independent fallback.
        if acknowledged:
            for value in self.targets.values():
                value['stopped'] = False
        else:
            errors.extend(resume_descriptors(self.targets))
        for value in self.targets.values():
            os.close(value['fd'])
        self.targets = {}
        if self.channel is not None:
            self.channel.close()
        if self.watchdog_pid is not None:
            # Closing the channel wakes the watchdog; never signal a numeric watchdog PID.
            deadline = time.monotonic() + 0.3
            while time.monotonic() < deadline:
                observed, _ = os.waitpid(self.watchdog_pid, os.WNOHANG)
                if observed:
                    break
                time.sleep(0.01)
        if errors:
            raise RuntimeError('Some owned writers did not acknowledge resume: ' + '; '.join(errors))


def supervise(spec_path):
    spec = read_json(spec_path)
    profile = os.path.realpath(spec['profileDirectory'])
    private(profile, directory=True)
    private(spec['runtimeDirectory'], directory=True)
    owner = identity(spec['hostPid'])
    if owner is None or owner['uid'] != os.getuid():
        raise RuntimeError('The launching host identity is unavailable.')
    guardian = identity(os.getpid())
    if guardian['pgid'] != os.getpid() or os.getsid(0) != os.getpid():
        raise RuntimeError('The supervisor must start in its own isolated session and process group.')
    lock_fd = acquire(profile)
    # Older host specs used the flat default. Both descriptors live until owned-group teardown.
    recovery_directory = spec.get('recoveryDirectory', os.path.join(profile, 'recovery'))
    if 'recoveryDirectory' not in spec:
        try:
            os.mkdir(recovery_directory, 0o700)
        except FileExistsError:
            pass
    if not os.path.isabs(recovery_directory) or os.path.realpath(recovery_directory) != recovery_directory:
        raise RuntimeError('Recovery storage must use its canonical directory.')
    recovery_lock_fd = acquire_recovery(recovery_directory)
    metadata_path = os.path.join(profile, 'workbench-owner.json')
    metadata = dict(version=1, profile=profile, owner=owner, guardian=guardian, instance=spec['instance'], runtime=spec['runtimeDirectory'], status='owned', createdAt=int(time.time() * 1000))
    durable_json(metadata_path, metadata)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(os.path.join(spec['runtimeDirectory'], 'supervisor.sock'))
    os.chmod(os.path.join(spec['runtimeDirectory'], 'supervisor.sock'), 0o600)
    listener.listen(4)
    listener.settimeout(0.2)
    child = None
    stopping = False
    pause = None
    pause_supported = False
    try:
        pause_supported = enable_pause_support()
    except OSError:
        pass  # Ordinary app mode remains usable; backup pause refuses this kernel.

    def stop(_signal=None, _frame=None):
        nonlocal stopping
        if stopping:
            return
        stopping = True
        # The main loop releases a pause before sending TERM to its own group.

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print('EVE_SUPERVISOR ' + json.dumps(dict(state='owned', guardian=guardian, instance=spec['instance'])), flush=True)
    while not stopping:
        if pause is not None:
            try:
                if not owner_alive(owner, identity(owner['pid'])):
                    pause.release('host-ended')
                else:
                    pause.check()
            except Exception:
                if not pause.ended:
                    pause.release('lease-check-failed')
            if pause.ended:
                print('EVE_SUPERVISOR ' + json.dumps(dict(state='resumed', leaseId=pause.lease_id, reason=pause.ended)), flush=True)
                pause = None
        if child is not None and child.poll() is not None:
            stop()
            break
        try:
            connection, _ = listener.accept()
        except socket.timeout:
            continue
        with connection:
            connection.settimeout(2)
            try:
                request = json.loads(connection.makefile('rb').readline(8193))
                if not isinstance(request, dict) or not isinstance(request.get('token'), str) or not hmac.compare_digest(request['token'], spec['supervisorToken']) or request.get('instance') != spec['instance']:
                    raise RuntimeError('Supervisor authentication rejected.')
                result = None
                if request.get('type', '').startswith('pause-') and not owner_alive(owner, identity(owner['pid'])):
                    raise RuntimeError('The original host no longer owns this pause control.')
                if request.get('type') == 'pause-status':
                    result = dict(supported=pause_supported, active=pause.status() if pause is not None else None)
                elif request.get('type') == 'pause-acquire':
                    if not pause_supported or child is None:
                        raise RuntimeError('Safe writer pause requires Linux pidfds and a running owned workbench.')
                    if pause is not None:
                        raise RuntimeError('A workbench pause lease is already active.')
                    lease_id = request.get('leaseId')
                    ttl_ms = request.get('ttlMs')
                    if not isinstance(lease_id, str) or len(lease_id) != 36 or not isinstance(ttl_ms, int) or isinstance(ttl_ms, bool) or not 5000 <= ttl_ms <= 120000:
                        raise RuntimeError('Invalid bounded pause lease.')
                    candidate = PauseLease(lease_id, ttl_ms / 1000.0)
                    result = candidate.acquire()
                    pause = candidate
                elif request.get('type') in ('pause-renew', 'pause-assert', 'pause-release'):
                    if pause is None or request.get('leaseId') != pause.lease_id:
                        raise RuntimeError('The pause lease is stale or expired.')
                    if request['type'] == 'pause-renew':
                        result = pause.renew()
                    elif request['type'] == 'pause-assert':
                        result = pause.check()
                    else:
                        pause.release()
                        result = dict(leaseId=pause.lease_id, released=True)
                        pause = None
                elif request.get('type') == 'launch':
                    if child is not None or not owner_alive(owner, identity(owner['pid'])):
                        raise RuntimeError('Launch ownership changed.')
                    child = subprocess.Popen(spec['command'], cwd=spec['projectRoot'], env=spec['environment'], stdin=subprocess.DEVNULL)
                    metadata.update(status='running', child=identity(child.pid))
                    durable_json(metadata_path, metadata)
                elif request.get('type') == 'orphan-stop':
                    if request.get('owner') != owner or owner_alive(owner, identity(owner['pid'])):
                        raise RuntimeError('Original host is alive or ownership proof changed.')
                    stopping = True
                elif request.get('type') == 'stop':
                    if not owner_alive(owner, identity(owner['pid'])):
                        raise RuntimeError('Only the current live host may stop this runtime.')
                    stopping = True
                else:
                    raise RuntimeError('Unsupported supervisor request.')
                connection.sendall(json.dumps(dict(ok=True, nonce=request.get('nonce'), guardian=guardian, result=result)).encode() + b'\n')
            except Exception as error:
                connection.sendall(json.dumps(dict(ok=False, message=str(error))).encode() + b'\n')
    # Retain the flock until every member receives SIGKILL; never unlink the lock inode.
    if pause is not None:
        pause.release('supervisor-stopping')
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.killpg(0, signal.SIGTERM)
    deadline = time.monotonic() + 2
    while child is not None and child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.04)
    metadata['status'] = 'stopped'
    durable_json(metadata_path, metadata)
    listener.close()
    os.killpg(0, signal.SIGKILL)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--identity':
            print(json.dumps(identity(int(sys.argv[2]))))
        else:
            supervise(sys.argv[1])
    except Exception as error:
        print('EVE_SUPERVISOR ' + json.dumps(dict(state='failed', message=str(error))), flush=True)
        sys.exit(1)
