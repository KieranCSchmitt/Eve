import { describe, expect, it } from 'vitest';
import { parseAuthenticationCookie, workbenchEnvironment } from '../../apps/desktop/host/workbench';

describe('private workbench runtime', () => {
  it('passes display basics and bridge paths without inherited credentials or injection flags', () => {
    const environment = workbenchEnvironment({ HOME: '/home/eve', PATH: '/usr/bin', OPENAI_API_KEY: 'must-not-reach-project', DEEPGRAM_API_KEY: 'also-private', PASSWORD: 'hidden', NODE_OPTIONS: '--require malicious.js', EVE_RUNTIME_KEY: 'hidden', DISPLAY: ':1' }, '/run/eve/w.sock', '/run/eve/w.token');
    expect(environment).toMatchObject({ HOME: '/home/eve', PATH: '/usr/bin', DISPLAY: ':1', EVE_WORKBENCH_SOCKET: '/run/eve/w.sock' });
    expect(Object.keys(environment).some(key => /KEY|PASSWORD|NODE_OPTIONS/.test(key))).toBe(false);
  });
  it('uses only the server authentication cookie, preserving its encoded value', () => {
    expect(parseAuthenticationCookie(['other=discard', 'code-server-session=abc%2Fxyz%3D; Path=/; HttpOnly; SameSite=Lax'])).toEqual({ name: 'code-server-session', value: 'abc%2Fxyz%3D' });
    expect(() => parseAuthenticationCookie(['other=discard'])).toThrow('connect securely to the code editor');
  });
});
