import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'packaging/linux/session'))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


qualification = module('qualification', ROOT / 'packaging/linux/session/qualification.py')
supervisor = module('supervise', ROOT / 'packaging/linux/session/supervise.py')
evidence = module('session_evidence', ROOT / 'packaging/linux/session/session_evidence.py')
builder = module('build_debs', ROOT / 'packaging/linux/build_debs.py')


class QualificationChecks(unittest.TestCase):
    def profile(self):
        return {'schemaVersion': 1, 'status': 'candidate', 'gnomeVersion': 'GNOME Shell 46.2', 'backend': 'wayland', 'unitFingerprints': [{'path': '/usr/lib/systemd/user/test.target', 'sha256': 'test'}], 'oemDependencies': {'wants': ['org.gnome.SettingsDaemon.Power.target'], 'requires': ['gnome-keyring-daemon.service']}, 'retainsUserServices': True, 'stockSessionPreserved': True}

    def test_candidate_needs_explicit_qualification_entry(self):
        with self.assertRaisesRegex(ValueError, 'candidate'):
            qualification.validate_profile(self.profile(), 'GNOME Shell 46.2', 'wayland')
        qualification.validate_profile(self.profile(), 'GNOME Shell 46.2', 'wayland', True)

    def test_unknown_version_and_changed_backend_refuse(self):
        with self.assertRaisesRegex(ValueError, 'no reviewed'):
            qualification.validate_profile(self.profile(), 'GNOME Shell 50.1', 'wayland', True)
        with self.assertRaisesRegex(ValueError, 'differs'):
            qualification.validate_profile(self.profile(), 'GNOME Shell 46.2', 'x11', True)

    def test_qualified_requires_every_gate_and_evidence(self):
        profile = self.profile()
        profile['status'] = 'qualified'
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            qualification.validate_profile(profile, 'GNOME Shell 46.2', 'wayland')
        profile['gates'] = {name: True for name in qualification.REQUIRED_GATES}
        with self.assertRaisesRegex(ValueError, 'evidence'):
            qualification.validate_profile(profile, 'GNOME Shell 46.2', 'wayland')
        profile['evidenceDirectory'] = '/opt/eve/qualification'
        qualification.validate_profile(profile, 'GNOME Shell 46.2', 'wayland')

    def test_restarts_are_bounded_and_expire(self):
        self.assertTrue(supervisor.restart_allowed([1, 2], 3))
        self.assertFalse(supervisor.restart_allowed([1, 2, 3], 4))
        self.assertTrue(supervisor.restart_allowed([1, 2, 3], 65))

    def test_ambiguous_or_conflicting_dependency_strength_is_refused(self):
        for dependencies in (['a.target'], {'wants': ['a.target'], 'requires': ['a.target']}, {'wants': [], 'requires': []}, {'wants': ['org.gnome.Shell.target'], 'requires': []}):
            profile = self.profile()
            profile['oemDependencies'] = dependencies
            with self.subTest(dependencies=dependencies), self.assertRaises(ValueError):
                qualification.validate_profile(profile, 'GNOME Shell 46.2', 'wayland', True)

    def test_builder_preserves_wants_and_requires_and_installs_verifier(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            profile = directory / 'profile.json'
            profile.write_text(json.dumps(self.profile()))
            graph = directory / 'graph'
            graph.mkdir()
            (graph / 'eve-reviewed.target').write_text('[Unit]\nDescription=Reviewed test graph\n')
            destination = directory / 'package'
            with patch.object(builder.subprocess, 'run') as run:
                builder.build_session(destination, '0.1.0', profile, graph)
            run.assert_called_once()  # Schema compilation only; no install/service operations.
            dropin = (destination / 'usr/lib/systemd/user/gnome-session@eve.target.d/50-eve.conf').read_text()
            self.assertEqual(dropin, '[Unit]\nRequires=org.eve.Shell@wayland.service gnome-keyring-daemon.service\nWants=org.gnome.SettingsDaemon.Power.target\n')
            self.assertTrue((destination / 'usr/lib/eve-session/session_evidence.py').is_file())

    def test_builder_still_refuses_x11_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            profile = self.profile()
            profile['backend'] = 'x11'
            source = directory / 'profile.json'
            source.write_text(json.dumps(profile))
            with self.assertRaisesRegex(ValueError, 'X11 adapter'):
                builder.build_session(directory / 'output', '0.1.0', source, directory)


class ForwardGraphChecks(unittest.TestCase):
    profile = QualificationChecks.profile

    def graph(self):
        graph = {
            'gnome-session-wayland@eve.target': {'Requires': 'gnome-session@eve.target'},
            'gnome-session@eve.target': {'Requires': 'org.eve.Shell@wayland.service gnome-keyring-daemon.service', 'Wants': 'org.gnome.SettingsDaemon.Power.target', 'Requisite': 'gnome-session.target'},
            'org.eve.Shell@wayland.service': {'Requisite': 'gnome-session-initialized.target'},
            'gnome-session.target': {'ConsistsOf': 'org.gnome.Shell@x11.service org.gnome.Shell@wayland.service'},
            'gnome-session-initialized.target': {'ConsistsOf': 'org.gnome.Shell@x11.service org.gnome.Shell@wayland.service'},
            'gnome-keyring-daemon.service': {},
            'org.gnome.SettingsDaemon.Power.target': {},
        }
        return {name: {'Id': name, 'LoadState': 'loaded', **props} for name, props in graph.items()}

    def test_inverse_containment_does_not_start_stock_compositor(self):
        graph = self.graph()
        graph['gnome-session@eve.target']['Requires'] += ' gnome-session-initialized.target'
        result = qualification.validate_session_graph(self.profile(), graph.__getitem__)
        self.assertIn('gnome-session-initialized.target', result)
        self.assertNotIn('org.gnome.Shell@x11.service', result)

    def test_each_forward_relation_detects_indirect_stock_compositor(self):
        for relation in qualification.PULL_IN:
            graph = self.graph()
            graph['gnome-keyring-daemon.service'][relation] = 'intermediate.target'
            graph['intermediate.target'] = {'Id': 'intermediate.target', 'LoadState': 'loaded', 'Wants': 'org.gnome.Shell@wayland.service'}
            with self.subTest(relation=relation), self.assertRaisesRegex(ValueError, 'stock compositor'):
                qualification.validate_session_graph(self.profile(), graph.__getitem__)

    def test_alias_cannot_hide_stock_compositor(self):
        for relation in ('Requires', 'Requisite'):
            graph = self.graph()
            graph['gnome-keyring-daemon.service'][relation] = 'innocent.service'
            graph['innocent.service'] = {'Id': 'org.gnome.Shell@x11.service', 'LoadState': 'loaded'}
            with self.subTest(relation=relation), self.assertRaisesRegex(ValueError, 'stock compositor'):
                qualification.validate_session_graph(self.profile(), graph.__getitem__)

    def test_requisite_alone_does_not_start_eve_compositor(self):
        graph = self.graph()
        owner = graph['gnome-session@eve.target']
        owner['Requires'] = 'gnome-keyring-daemon.service'
        owner['Requisite'] += ' org.eve.Shell@wayland.service'
        with self.assertRaisesRegex(ValueError, 'lacks the Eve-scoped'):
            qualification.validate_session_graph(self.profile(), graph.__getitem__)

    def test_missing_or_promoted_dependencies_refuse(self):
        for action in ('missing', 'promoted'):
            graph = self.graph()
            owner = graph['gnome-session@eve.target']
            if action == 'missing':
                owner['Wants'] = ''
            else:
                owner['Requires'] += ' ' + owner['Wants']
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'strength|promoted'):
                qualification.validate_session_graph(self.profile(), graph.__getitem__)

    def test_unavailable_and_oversized_graphs_refuse(self):
        graph = self.graph()
        graph['gnome-keyring-daemon.service']['LoadState'] = 'not-found'
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            qualification.validate_session_graph(self.profile(), graph.__getitem__)
        graph = self.graph()
        with self.assertRaisesRegex(ValueError, 'oversized'):
            qualification.inspect_forward_graph('gnome-session-wayland@eve.target', graph.__getitem__, limit=2)

    def test_slow_inspection_cannot_pass_after_time_budget(self):
        graph = self.graph()
        with patch.object(qualification.time, 'monotonic', side_effect=[0, 1, 16]):
            with self.assertRaisesRegex(ValueError, 'time budget'):
                qualification.validate_session_graph(self.profile(), graph.__getitem__)


class EvidenceChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name) / 'units'
        self.root.mkdir()
        self.dropins = self.root / 'gnome-session@ubuntu.target.d'
        self.dropins.mkdir()
        self.dropin = self.dropins / 'ubuntu.session.conf'
        self.dropin.write_text('[Unit]\nWants=org.gnome.SettingsDaemon.Power.target\n')

    def collect(self):
        return evidence.collect_evidence((str(self.root),), ())

    def verify(self, records):
        evidence.verify_fingerprints(records, (str(self.root),))

    def test_nested_dropin_content_and_membership_are_pinned(self):
        original = self.collect()
        self.verify(original)
        self.assertIn(str(self.dropin), [item['path'] for item in original])
        self.dropin.write_text('[Unit]\nRequires=org.gnome.SettingsDaemon.Power.target\n')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(original)
        original = self.collect()
        (self.dropins / '90-oem.conf').write_text('[Unit]\nWants=extra.target\n')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(original)

    def test_symlink_retarget_with_same_content_and_target_change_refuse(self):
        wanted = self.root / 'gnome-session.target.wants'
        wanted.mkdir()
        a, b = self.root / 'helper-a.service', self.root / 'helper-b.service'
        a.write_text('[Service]\nExecStart=/usr/bin/true\n')
        b.write_text(a.read_text())
        link = wanted / 'helper.service'
        link.symlink_to('../helper-a.service')
        original = self.collect()
        self.verify(original)
        self.assertIn(str(a), [item['path'] for item in original])
        link.unlink()
        link.symlink_to('../helper-b.service')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(original)
        original = self.collect()
        b.write_text('[Service]\nExecStart=/usr/bin/false\n')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(original)

    def test_escaping_and_directory_links_are_recorded_without_reading_targets(self):
        outside = pathlib.Path(self.temporary.name) / 'outside'
        outside.mkdir()
        private = outside / 'private.service'
        private.write_text('not session evidence')
        (self.root / 'gnome-session-external.service').symlink_to(private)
        alias = self.root / 'gnome-session-linked'
        alias.symlink_to(outside, target_is_directory=True)
        (self.root / 'gnome-session-via-directory.service').symlink_to('gnome-session-linked/private.service')
        records = self.collect()
        self.verify(records)
        self.assertEqual(len([item for item in records if item['kind'] == 'symlink']), 3)
        self.assertNotIn(str(private), [item['path'] for item in records])
        self.assertNotIn(str(alias / 'private.service'), [item['path'] for item in records])

    def test_in_scope_link_chains_pin_every_hop_and_stop_at_cycles(self):
        target = self.root / 'helper.service'
        target.write_text('[Service]\nExecStart=/usr/bin/true\n')
        middle = self.root / 'middle.service'
        middle.symlink_to('helper.service')
        (self.root / 'gnome-session-alias.service').symlink_to('middle.service')
        (self.root / 'gnome-session-cycle.service').symlink_to('cycle-hop.service')
        (self.root / 'cycle-hop.service').symlink_to('gnome-session-cycle.service')
        records = self.collect()
        self.verify(records)
        self.assertIn(str(target), [item['path'] for item in records])
        self.assertIn(str(middle), [item['path'] for item in records])
        middle.unlink()
        middle.symlink_to('gnome-session-cycle.service')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(records)

    def test_scoped_oem_baseline_ignores_only_unrelated_and_eve_additions(self):
        original = self.collect()
        (self.root / 'unrelated.service').write_text('unrelated')
        (self.root / 'org.eve.Shell@wayland.service').write_text('Eve compositor')
        (self.root / 'gnome-session@eve.target.d').mkdir()
        self.verify(original)
        (self.root / 'gnome-session@ubuntu.target.wants').mkdir()
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(original)

    def test_file_replaced_by_link_and_directory_replaced_by_link_refuse(self):
        original = self.collect()
        target = self.root / 'same-content'
        target.write_text(self.dropin.read_text())
        self.dropin.unlink()
        self.dropin.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(original)
        self.dropin.unlink()
        self.dropins.rmdir()
        self.dropins.symlink_to(pathlib.Path(self.temporary.name), target_is_directory=True)
        with self.assertRaises(ValueError):
            self.verify(original)

    def test_duplicate_escaping_and_malformed_records_refuse(self):
        records = self.collect()
        for malformed in ([*records, records[0]], [{'path': '/etc/passwd', 'sha256': 'ignored'}], ['invalid']):
            with self.subTest(records=malformed), self.assertRaises(ValueError):
                self.verify(malformed)


if __name__ == '__main__':
    unittest.main()
