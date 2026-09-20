import { describe, expect, it } from 'vitest';
import { LinuxSystemAdapter, splitNmcliRow } from '../../packages/platform/src/index';

describe('desktop controls preserve real OS and dirty-work boundaries', () => {
  it('parses saved names with escaped colons and backslashes', () => {
    expect(splitNmcliRow('id:Studio\\: WiFi:802-11-wireless:wlan0')).toEqual(['id', 'Studio: WiFi', '802-11-wireless', 'wlan0']);
    expect(splitNmcliRow('id:a\\\\b:ethernet:--')).toEqual(['id', 'a\\b', 'ethernet', '--']);
  });
  it('does not request logout if a save or untitled destination is unresolved', async () => {
    const calls: string[] = [];
    const adapter = new LinuxSystemAdapter({ platform: 'linux', prepareExit: async () => ({ ready: false, reason: 'Choose where to save your note.' }), run: async command => { calls.push(command); return ''; } });
    expect(await adapter.exit('logout')).toEqual({ performed: false, reason: 'Choose where to save your note.' });
    expect(calls).toEqual([]);
  });
  it('uses the normal GNOME session manager after work is ready, never forced loginctl termination', async () => {
    const calls: unknown[] = [];
    const adapter = new LinuxSystemAdapter({ platform: 'linux', prepareExit: async () => ({ ready: true }), run: async (command, args) => { calls.push([command, args]); return ''; } });
    await adapter.exit('logout');
    expect(calls).toEqual([['gdbus', ['call', '--session', '--dest', 'org.gnome.SessionManager', '--object-path', '/org/gnome/SessionManager', '--method', 'org.gnome.SessionManager.Logout', '0']]]);
  });
  it('never passes an arbitrary command as a saved network or volume', async () => {
    const calls: unknown[] = [];
    const adapter = new LinuxSystemAdapter({ platform: 'linux', prepareExit: async () => ({ ready: true }), run: async (command, args) => { calls.push([command, args]); return ''; } });
    await expect(adapter.connectSavedNetwork('wifi; reboot')).rejects.toThrow('saved network');
    await expect(adapter.setVolume(300)).rejects.toThrow('between');
    await adapter.setVolume(64);
    expect(calls).toEqual([['wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', '0.64']]]);
  });
  it('reports unavailable controls honestly on development hosts', async () => {
    const adapter = new LinuxSystemAdapter({ platform: 'darwin', prepareExit: async () => ({ ready: true }) });
    await expect(adapter.status()).rejects.toThrow('qualified Linux desktop');
  });
});
