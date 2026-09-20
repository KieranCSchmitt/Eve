import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'extensions/eve-workbench/scripts/supervisor.py'
spec = importlib.util.spec_from_file_location('supervisor', SOURCE)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class OwnershipTests(unittest.TestCase):
    def test_recovery_namespace_has_its_own_kernel_lock_and_no_pid_takeover(self):
        with tempfile.TemporaryDirectory(prefix='eve-recovery-lock-') as recovery:
            first = supervisor.acquire_recovery(recovery)
            original = (pathlib.Path(recovery) / 'workbench.lock').read_bytes()
            with patch.object(supervisor.os, 'kill') as signal_pid, patch.object(supervisor.os, 'killpg') as signal_group:
                with self.assertRaisesRegex(RuntimeError, 'already owned by another'):
                    supervisor.acquire_recovery(recovery)
                signal_pid.assert_not_called()
                signal_group.assert_not_called()
            self.assertEqual((pathlib.Path(recovery) / 'workbench.lock').read_bytes(), original)
            os.close(first)
            next_owner = supervisor.acquire_recovery(recovery)
            os.close(next_owner)

    def test_recovery_lock_link_or_ambiguous_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='eve-recovery-lock-') as recovery:
            marker = pathlib.Path(recovery) / 'workbench.lock'
            marker.write_bytes(b'unknown historical ownership')
            marker.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'Ambiguous recovery lock'):
                supervisor.acquire_recovery(recovery)
            self.assertEqual(marker.read_bytes(), b'unknown historical ownership')
            marker.unlink()
            target = pathlib.Path(recovery) / 'original'
            target.write_bytes(supervisor.RECOVERY_MARKER)
            target.chmod(0o600)
            marker.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, 'Unsafe private'):
                supervisor.acquire_recovery(recovery)
            self.assertTrue(marker.is_symlink())

    def test_birth_identity_distinguishes_reused_pid_and_uid(self):
        observed = supervisor.identity(os.getpid())
        self.assertTrue(supervisor.same_identity(observed, supervisor.identity(os.getpid())))
        self.assertFalse(supervisor.same_identity(dict(observed, start='reused-pid'), observed))
        self.assertFalse(supervisor.same_identity(dict(observed, uid=observed['uid'] + 1), observed))
        self.assertTrue(supervisor.owner_alive(dict(observed, pgid=observed['pgid'] + 1), observed))
        with self.assertRaisesRegex(RuntimeError, 'changed UID'):
            supervisor.owner_alive(dict(observed, uid=observed['uid'] + 1), observed)

    def test_recycled_supervisor_pid_never_receives_a_socket_request_or_signal(self):
        observed = supervisor.identity(os.getpid())
        metadata = dict(guardian=dict(observed, start='previous-birth'), runtime='/tmp/eve-wb-fake')
        with patch.object(supervisor, 'identity', return_value=observed), patch.object(supervisor.socket, 'socket') as socket_factory, patch.object(supervisor.os, 'killpg') as signal_group:
            with self.assertRaisesRegex(RuntimeError, 'identity is unavailable'):
                supervisor.request_stop(metadata)
            socket_factory.assert_not_called()
            signal_group.assert_not_called()

    def test_legacy_and_ambiguous_locks_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='eve-ownership-') as profile:
            path = pathlib.Path(profile) / 'workbench.lock'
            original = json.dumps(dict(pid=os.getpid(), instance='old-format'))
            path.write_text(original)
            path.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'Legacy or ambiguous'):
                supervisor.acquire(profile)
            self.assertEqual(path.read_text(), original)

    def test_remaining_group_without_supervisor_is_quarantined_without_signal(self):
        with tempfile.TemporaryDirectory(prefix='eve-ownership-') as profile:
            (pathlib.Path(profile) / 'workbench.lock').write_bytes(supervisor.MARKER)
            (pathlib.Path(profile) / 'workbench.lock').chmod(0o600)
            owner = dict(pid=12345, uid=os.getuid(), pgid=12345, start='old-host-birth')
            metadata = dict(version=1, profile=profile, owner=owner, guardian=owner, runtime='/tmp/eve-wb-original', instance='original', status='running')
            supervisor.durable_json(os.path.join(profile, 'workbench-owner.json'), metadata)
            with patch.object(supervisor, 'identity', return_value=None), patch.object(supervisor, 'group_members', return_value=[23456]), patch.object(supervisor.os, 'killpg') as signal_group:
                with self.assertRaisesRegex(RuntimeError, 'old process group remains'):
                    supervisor.acquire(profile)
                signal_group.assert_not_called()
            self.assertEqual(json.loads((pathlib.Path(profile) / 'workbench-owner.json').read_text()), metadata)


if __name__ == '__main__':
    unittest.main()
