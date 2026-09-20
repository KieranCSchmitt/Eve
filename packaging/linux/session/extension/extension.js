import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

export default class EveSession extends Extension {
    enable() {
        if (!/^46(?:\.|$)/.test(Config.PACKAGE_VERSION))
            throw new Error('This Eve session adapter requires qualification for the installed GNOME version.');
        this._wasVisible = Main.layoutManager.panelBox.visible;
        this._windowConnections = [];
        this._sessionSignal = Main.sessionMode.connect('updated', () => this._sync());
        this._windowSignal = global.display.connect('window-created', (_display, window) => {
            const id = window.connect('notify::wm-class', () => this._sync());
            const unmanaged = window.connect('unmanaged', () => this._sync());
            this._windowConnections.push([window, id, unmanaged]);
            this._sync();
        });
        Main.wm.addKeybinding('eve-recall', this.getSettings(), Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => {
            if (Main.sessionMode.currentMode !== 'eve') return;
            Gio.Subprocess.new(['/usr/bin/eve', '--recall'], Gio.SubprocessFlags.NONE);
        });
        this._sync();
    }

    _sync() {
        // Never put Eve controls over GNOME's authentic lock or authentication UI.
        const active = Main.sessionMode.currentMode === 'eve' && !Main.sessionMode.isLocked;
        const windows = global.get_window_actors().map(actor => actor.meta_window);
        const eve = windows.find(window => window.get_gtk_application_id?.() === 'org.eve.Shell' || window.get_wm_class?.()?.toLowerCase() === 'eve');
        if (active && eve) {
            Main.layoutManager.panelBox.hide();
            if (!eve.is_fullscreen()) eve.make_fullscreen();
        } else {
            Main.layoutManager.panelBox.show();
        }
    }

    disable() {
        if (this._sessionSignal) Main.sessionMode.disconnect(this._sessionSignal);
        if (this._windowSignal) global.display.disconnect(this._windowSignal);
        this._sessionSignal = null;
        this._windowSignal = null;
        for (const [window, ...ids] of this._windowConnections ?? [])
            for (const id of ids) { try { window.disconnect(id); } catch {} }
        this._windowConnections = [];
        Main.wm.removeKeybinding('eve-recall');
        if (this._wasVisible !== false) Main.layoutManager.panelBox.show();
    }
}
