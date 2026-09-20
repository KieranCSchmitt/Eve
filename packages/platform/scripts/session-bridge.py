#!/usr/bin/env python3
"""Persistent GNOME session registration/inhibitor; JSON stdin/stdout, no credentials."""
import json
import os
import sys

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

BUS = 'org.gnome.SessionManager'
PATH = '/org/gnome/SessionManager'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
loop = GLib.MainLoop()
client = None
inhibitor = None
# Treat startup state as unsettled until the host explicitly reports the current save state.
dirty = True


def emit(event):
    print(json.dumps(event), flush=True)


def call(method, arguments, reply=None, object_path=PATH, interface=BUS):
    return bus.call_sync(BUS, object_path, interface, method, arguments, reply,
                         Gio.DBusCallFlags.NONE, 5000, None)


def respond(ok, reason):
    if client:
        call('EndSessionResponse', GLib.Variant('(bs)', (ok, reason)),
             object_path=client, interface=BUS + '.ClientPrivate')


def on_client_signal(_bus, _sender, _path, _interface, signal, parameters, _data):
    if signal in ('QueryEndSession', 'EndSession'):
        # Respond within the session manager's short query deadline; dirty work stays inhibited.
        respond(not dirty, 'Eve has unsaved work. Return to Eve to save or discard it.' if dirty else '')
        emit({'type': 'exit-request', 'phase': signal, 'dirty': dirty,
              'flags': parameters.unpack()[0] if parameters else 0})
    elif signal == 'CancelEndSession':
        emit({'type': 'exit-cancelled'})
    elif signal == 'Stop':
        emit({'type': 'stop'})


def on_lock(_bus, _sender, _path, _interface, _signal, parameters, _data):
    emit({'type': 'lock', 'locked': bool(parameters.unpack()[0])})


def stdin_ready(_source, condition):
    global inhibitor, dirty
    if condition & GLib.IO_HUP:
        loop.quit()
        return False
    line = sys.stdin.readline(65537)
    if not line:
        loop.quit()
        return False
    request = {}
    try:
        if len(line) > 65536 or not line.endswith('\n'):
            raise ValueError('Session message exceeds its limit.')
        request = json.loads(line)
        if request.get('type') == 'dirty' and isinstance(request.get('dirty'), bool):
            dirty = request['dirty']
            if dirty and inhibitor is None:
                inhibitor = call('Inhibit', GLib.Variant('(susu)', ('org.eve.Shell', 0, 'Unsaved work in Eve', 1))).unpack()[0]
            elif not dirty and inhibitor is not None:
                call('Uninhibit', GLib.Variant('(u)', (inhibitor,)))
                inhibitor = None
        elif request.get('type') == 'end-session-response' and isinstance(request.get('ok'), bool):
            respond(request['ok'], str(request.get('reason', ''))[:1000])
        else:
            raise ValueError('Unsupported session command.')
        emit({'type': 'result', 'id': request.get('id'), 'ok': True})
    except Exception as error:
        emit({'type': 'result', 'id': request.get('id'), 'ok': False, 'error': str(error)[:1000]})
    return True


try:
    client = call('RegisterClient', GLib.Variant('(ss)', ('org.eve.Shell', os.environ.get('DESKTOP_AUTOSTART_ID', '')))).unpack()[0]
    inhibitor = call('Inhibit', GLib.Variant('(susu)', ('org.eve.Shell', 0, 'Checking Eve work state', 1))).unpack()[0]
    bus.signal_subscribe(BUS, BUS + '.ClientPrivate', None, client, None,
                         Gio.DBusSignalFlags.NONE, on_client_signal, None)
    bus.signal_subscribe('org.gnome.ScreenSaver', 'org.gnome.ScreenSaver', 'ActiveChanged',
                         '/org/gnome/ScreenSaver', None, Gio.DBusSignalFlags.NONE, on_lock, None)
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, stdin_ready)
    emit({'type': 'ready', 'client': client})
    loop.run()
finally:
    if inhibitor is not None:
        try:
            call('Uninhibit', GLib.Variant('(u)', (inhibitor,)))
        except Exception:
            pass
    if client:
        try:
            call('UnregisterClient', GLib.Variant('(o)', (client,)))
        except Exception:
            pass
