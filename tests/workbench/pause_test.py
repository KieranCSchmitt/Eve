import importlib.util
import json
import os
import pathlib
import signal
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'extensions/eve-workbench/scripts/supervisor.py'
spec = importlib.util.spec_from_file_location('eve_supervisor_pause', SOURCE)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class PauseOwnershipTests(unittest.TestCase):
    def test_resume_only_targets_lease_stopped_descriptors(self):
        targets = {'pre-stopped': dict(fd=10, stopped=False), 'ours': dict(fd=11, stopped=True)}
        with patch.object(supervisor.signal, 'pidfd_send_signal', create=True) as send, patch.object(supervisor.os, 'kill') as numeric:
            self.assertEqual(supervisor.resume_descriptors(targets), [])
            send.assert_called_once_with(11, signal.SIGCONT)
            numeric.assert_not_called()

    def test_reused_identity_or_dead_pinned_object_never_receives_a_signal(self):
        expected = dict(pid=123, uid=os.getuid(), start='old', state='S', ppid=os.getpid())
        for observed, pinned_pid in [(dict(expected, start='new'), 123), (expected, -1)]:
            with patch.object(supervisor.os, 'pidfd_open', return_value=45, create=True), patch.object(supervisor.os, 'close') as close, patch.object(supervisor, 'descriptor_pid', return_value=pinned_pid), patch.object(supervisor, 'descendant_inventory', return_value={123: observed}), patch.object(supervisor.signal, 'pidfd_send_signal', create=True) as send:
                with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                    supervisor.pin_descendant(expected, set())
                close.assert_called_once_with(45)
                send.assert_not_called()

    def test_failed_watchdog_control_uses_only_guardian_owned_descriptors(self):
        lease = supervisor.PauseLease('lease', 30)
        lease.channel = object()
        lease.targets = {'ours': dict(fd=11, stopped=True), 'external-stop': dict(fd=12, stopped=False)}
        with patch.object(lease, 'request', side_effect=OSError('watchdog disconnected')), patch.object(supervisor.signal, 'pidfd_send_signal', create=True) as send, patch.object(supervisor.os, 'close'), patch.object(supervisor.os, 'kill') as numeric:
            class Channel:
                def close(self):
                    pass
            lease.channel = Channel()
            lease.release('watchdog-ended')
            send.assert_called_once_with(11, signal.SIGCONT)
            numeric.assert_not_called()
            lease.release()  # idempotent
            self.assertEqual(send.call_count, 1)

    def test_new_or_not_fully_stopped_writer_invalidates_assertion(self):
        lease = supervisor.PauseLease('lease', 30)
        lease.targets = {'123:birth': dict(fd=44, stopped=True)}
        target = dict(pid=123, start='birth', state='T')
        with patch.object(supervisor, 'descendant_inventory', return_value={123: target}), patch.object(supervisor, 'descriptor_pid', return_value=123), patch.object(supervisor, 'threads_stopped', return_value=False):
            self.assertFalse(lease.all_stopped())
        with patch.object(supervisor, 'descendant_inventory', return_value={456: dict(pid=456, start='new', state='S')}):
            self.assertFalse(lease.all_stopped())

    def test_expired_lease_is_not_renewed_or_reported_held(self):
        lease = supervisor.PauseLease('lease', 30)
        lease.deadline = 0
        with self.assertRaisesRegex(RuntimeError, 'expired'):
            lease.check()
        self.assertEqual(lease.ended, 'expired')
        with self.assertRaisesRegex(RuntimeError, 'ended'):
            lease.renew()

    def test_mac_refuses_without_enabling_a_subreaper_or_signalling(self):
        with patch.object(supervisor.platform, 'system', return_value='Darwin'), patch.object(supervisor.ctypes, 'CDLL') as library:
            self.assertFalse(supervisor.enable_pause_support())
            library.assert_not_called()


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'Requires actual Linux pidfds; not a Mac simulation.')
class NativeLinuxPauseTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(supervisor.enable_pause_support())
        self.temporary = tempfile.TemporaryDirectory(prefix='eve-pause-native-')
        self.writer = None
        self.fd = None
        self.lease = None

    def tearDown(self):
        if self.lease is not None:
            self.lease.release()
        if self.fd is not None:
            try:
                signal.pidfd_send_signal(self.fd, signal.SIGCONT)
                signal.pidfd_send_signal(self.fd, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.close(self.fd)
        if self.writer is not None:
            self.writer.wait(timeout=3)
        self.temporary.cleanup()

    def writer_start(self):
        self.output = pathlib.Path(self.temporary.name) / 'ticks'
        source = "import time,sys\nwhile True:\n with open(sys.argv[1],'a') as f: f.write('tick\\n'); f.flush()\n time.sleep(.01)\n"
        self.writer = subprocess.Popen([sys.executable, '-u', '-c', source, str(self.output)], start_new_session=True)
        self.fd = os.pidfd_open(self.writer.pid)
        deadline = time.monotonic() + 3
        while not self.output.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(self.output.exists())

    def test_real_detached_session_writer_freezes_and_resumes(self):
        self.writer_start()
        self.lease = supervisor.PauseLease('native', 5)
        self.lease.acquire()
        before = self.output.read_bytes()
        time.sleep(.1)
        self.lease.check()
        self.assertEqual(self.output.read_bytes(), before)
        self.lease.release()
        time.sleep(.1)
        self.assertGreater(len(self.output.read_bytes()), len(before))

    def test_existing_external_stop_remains_stopped_after_release(self):
        self.writer_start()
        signal.pidfd_send_signal(self.fd, signal.SIGSTOP)
        deadline = time.monotonic() + 2
        while not supervisor.threads_stopped(self.writer.pid) and time.monotonic() < deadline:
            time.sleep(.01)
        self.lease = supervisor.PauseLease('pre-stopped', 5)
        status = self.lease.acquire()
        self.assertEqual(status['preStopped'], 1)
        self.lease.release()
        self.assertTrue(supervisor.threads_stopped(self.writer.pid))

    def test_independent_watchdog_resumes_on_expiry_without_guardian_polling(self):
        self.writer_start()
        self.lease = supervisor.PauseLease('expires', .35)
        self.lease.acquire()
        before = self.output.read_bytes()
        time.sleep(.5)  # Deliberately do not call guardian check; watchdog owns expiry.
        self.assertGreater(len(self.output.read_bytes()), len(before))
        with self.assertRaisesRegex(RuntimeError, 'expired'):
            self.lease.check()

    def test_guardian_resumes_if_independent_watchdog_is_killed(self):
        self.writer_start()
        self.lease = supervisor.PauseLease('watchdog-crash', 5)
        self.lease.acquire()
        before = self.output.read_bytes()
        fd = os.pidfd_open(self.lease.watchdog_pid)
        try:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        finally:
            os.close(fd)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                self.lease.check()
            except RuntimeError:
                break
            time.sleep(.01)
        self.assertEqual(self.lease.ended, 'watchdog-ended')
        time.sleep(.1)
        self.assertGreater(len(self.output.read_bytes()), len(before))

    def test_watchdog_resumes_after_actual_guardian_sigkill(self):
        output = pathlib.Path(self.temporary.name) / 'orphan-ticks'
        source = """
import importlib.util,json,os,subprocess,sys,time
spec=importlib.util.spec_from_file_location('pause',sys.argv[1])
pause=importlib.util.module_from_spec(spec); spec.loader.exec_module(pause)
assert pause.enable_pause_support()
writer=subprocess.Popen([sys.executable,'-u','-c',"import time,sys\\nwhile True:\\n with open(sys.argv[1],'a') as f: f.write('x'); f.flush()\\n time.sleep(.01)",sys.argv[2]],start_new_session=True)
while not os.path.exists(sys.argv[2]): time.sleep(.01)
lease=pause.PauseLease('guardian-crash',5); lease.acquire()
print(json.dumps(dict(writer=writer.pid,watchdog=lease.watchdog_pid)),flush=True)
while True: time.sleep(1)
"""
        guardian = subprocess.Popen([sys.executable, '-I', '-B', '-u', '-c', source, str(SOURCE), str(output)], stdout=subprocess.PIPE, start_new_session=True)
        guardian_fd = os.pidfd_open(guardian.pid)
        writer_fd = None
        watcher_pid = None
        try:
            ready, _, _ = select.select([guardian.stdout], [], [], 8)
            self.assertTrue(ready, 'Guardian did not acquire its pause lease.')
            metadata = json.loads(guardian.stdout.readline())
            writer_fd = os.pidfd_open(metadata['writer'])
            watcher_pid = metadata['watchdog']
            before = output.read_bytes()
            signal.pidfd_send_signal(guardian_fd, signal.SIGKILL)
            guardian.wait(timeout=3)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and output.read_bytes() == before:
                time.sleep(.01)
            self.assertGreater(len(output.read_bytes()), len(before))
        finally:
            if guardian.poll() is None:
                signal.pidfd_send_signal(guardian_fd, signal.SIGKILL)
                guardian.wait(timeout=3)
            os.close(guardian_fd)
            if writer_fd is not None:
                signal.pidfd_send_signal(writer_fd, signal.SIGCONT)
                signal.pidfd_send_signal(writer_fd, signal.SIGKILL)
                os.close(writer_fd)
                os.waitpid(metadata['writer'], 0)
            if watcher_pid is not None:
                os.waitpid(watcher_pid, 0)


if __name__ == '__main__':
    unittest.main()
