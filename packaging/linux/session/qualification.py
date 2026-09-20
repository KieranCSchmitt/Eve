#!/usr/bin/env python3
"""Checks exact platform evidence before permitting Eve's login session."""
import json
import pathlib
import re
import subprocess
import time
from session_evidence import verify_fingerprints

# API implementation target, not an assertion of GX10 qualification.
REVIEWED_GNOME_MAJORS = (46,)
REQUIRED_GATES = ('sessionLogin', 'lockUnlock', 'normalLogout', 'stockDesktopReturn',
                  'appModeIsolation', 'environmentIsolation', 'dirtyWork', 'recovery',
                  'gpuMedia', 'display', 'audio', 'network', 'power')
PULL_IN = ('Requires', 'Wants', 'BindsTo', 'Upholds')
GRAPH_PROPERTIES = ('Id', 'LoadState', *PULL_IN, 'Requisite')
UNIT_NAME = re.compile(r'[a-zA-Z0-9_.@:\\\\-]+\.(?:service|target|socket|path|timer|mount|automount|slice|scope|device|swap)')


def stock_compositor(unit):
    return unit == 'org.gnome.Shell.target' or unit.startswith('org.gnome.Shell@')


def reviewed_dependencies(profile):
    dependencies = profile.get('oemDependencies')
    if not isinstance(dependencies, dict) or set(dependencies) != {'wants', 'requires'}:
        raise ValueError('Record OEM dependencies separately as wants and requires; ambiguous lists must be reviewed again.')
    all_units = []
    for kind in ('wants', 'requires'):
        units = dependencies[kind]
        if not isinstance(units, list) or any(not isinstance(unit, str) or not re.fullmatch(r'[a-zA-Z0-9_.@:-]+\.(?:service|target)', unit) for unit in units):
            raise ValueError('Provide the reviewed OEM desktop-service dependencies.')
        all_units.extend(units)
    if not all_units or len(set(all_units)) != len(all_units):
        raise ValueError('OEM dependencies must be nonempty and have one unambiguous dependency strength each.')
    if any(stock_compositor(unit) for unit in all_units):
        raise ValueError('OEM dependencies must not pull in a stock compositor.')
    return dependencies


def inspect_unit(unit):
    command = ['systemctl', '--user', 'show', '--no-pager']
    for name in GRAPH_PROPERTIES:
        command.extend(['--property', name])
    result = subprocess.check_output([*command, '--', unit], text=True, timeout=5)
    return dict(line.split('=', 1) for line in result.splitlines() if '=' in line)


def inspect_forward_graph(start, inspect=inspect_unit, limit=512):
    """Follow start/pull-in edges only, never inverse ConsistsOf/RequiredBy.

    Requisite requires a unit to be already active; it does not start that unit.
    Its direct references are still checked for an incompatible compositor.
    """
    pending = [start]
    graph = {}
    inspected = {}
    deadline = time.monotonic() + 15

    def load(unit):
        if time.monotonic() >= deadline:
            raise ValueError('Forward session graph inspection exceeded its time budget.')
        if unit in inspected:
            return inspected[unit]
        if not UNIT_NAME.fullmatch(unit) or len(inspected) >= limit:
            raise ValueError('Invalid or oversized forward session graph; review is required.')
        properties = inspect(unit)
        if time.monotonic() >= deadline:
            raise ValueError('Forward session graph inspection exceeded its time budget.')
        canonical = properties.get('Id', '')
        if properties.get('LoadState') != 'loaded' or not UNIT_NAME.fullmatch(canonical):
            raise ValueError('A forward session dependency is unavailable: ' + unit)
        if stock_compositor(unit) or stock_compositor(canonical):
            raise ValueError('The forward session graph contains a stock compositor: ' + unit)
        inspected[unit] = properties
        return properties

    while pending:
        unit = pending.pop()
        if unit in graph:
            continue
        properties = load(unit)
        canonical = properties.get('Id', '')
        edges = {name: properties.get(name, '').split() for name in (*PULL_IN, 'Requisite')}
        for children in edges.values():
            if any(not UNIT_NAME.fullmatch(child) for child in children):
                raise ValueError('Invalid forward session dependency name.')
            if any(stock_compositor(child) for child in children):
                raise ValueError('The forward session graph references a stock compositor: ' + unit)
        graph[unit] = {'Id': canonical, **edges}
        for requisite in edges['Requisite']:
            load(requisite)  # Resolve aliases without traversing their start edges.
        for relation in PULL_IN:
            pending.extend(edges[relation])
    return graph


def validate_session_graph(profile, inspect=inspect_unit):
    dependencies = reviewed_dependencies(profile)
    graph = inspect_forward_graph('gnome-session-' + profile['backend'] + '@eve.target', inspect)
    compositor = 'org.eve.Shell@' + profile['backend'] + '.service'
    if not any(node['Id'] == compositor for node in graph.values()):
        raise ValueError('The forward session graph lacks the Eve-scoped compositor.')
    owner = graph.get('gnome-session@eve.target')
    if owner is None:
        raise ValueError('The forward session graph lacks the Eve session instance.')
    if not set(dependencies['requires']).issubset(owner['Requires']) or not set(dependencies['wants']).issubset(owner['Wants']):
        raise ValueError('The installed OEM dependency strength differs from the reviewed profile.')
    if set(dependencies['wants']).intersection((*owner['Requires'], *owner['BindsTo'], *owner['Requisite'])):
        raise ValueError('An OEM Wants dependency was promoted to a hard requirement.')
    return graph


def validate_profile(profile, actual_version, backend, qualification_mode=False):
    if profile.get('schemaVersion') != 1:
        raise ValueError('Unsupported qualification profile schema.')
    match = re.search(r'(\d+)(?:\.\d+)*', actual_version)
    if not match or int(match.group(1)) not in REVIEWED_GNOME_MAJORS:
        raise ValueError('This GNOME version has no reviewed Eve session adapter. Keep the stock session.')
    if profile.get('gnomeVersion') != actual_version.strip() or profile.get('backend') != backend:
        raise ValueError('The installed GNOME version or display backend differs from the recorded profile.')
    if backend not in ('wayland', 'x11'):
        raise ValueError('Unsupported display backend.')
    if profile.get('status') == 'candidate':
        if not qualification_mode:
            raise ValueError('This session is a qualification candidate, not a qualified desktop.')
    elif profile.get('status') == 'qualified':
        gates = profile.get('gates', {})
        if not all(gates.get(key) is True for key in REQUIRED_GATES):
            raise ValueError('The platform acceptance evidence is incomplete.')
        if not profile.get('evidenceDirectory'):
            raise ValueError('Qualification evidence must be recorded.')
    else:
        raise ValueError('A recorded candidate or qualified platform profile is required.')
    fingerprints = profile.get('unitFingerprints')
    if not isinstance(fingerprints, list) or not fingerprints:
        raise ValueError('The OEM session dependency graph has not been pinned.')
    if profile.get('retainsUserServices') is not True or profile.get('stockSessionPreserved') is not True:
        raise ValueError('The reviewed graph must retain desktop services and stock-session recovery.')
    reviewed_dependencies(profile)
    return profile


def check_installed(profile_path, qualification_mode=False, backend=None):
    profile = json.loads(pathlib.Path(profile_path).read_text())
    version = subprocess.check_output(['gnome-shell', '--version'], text=True, timeout=5).strip()
    validate_profile(profile, version, backend or profile.get('backend'), qualification_mode)
    verify_fingerprints(profile['unitFingerprints'])
    validate_session_graph(profile)
    return profile
