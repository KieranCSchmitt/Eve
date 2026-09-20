import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { DEFAULT_ORBIT_CONFIG } from '../../adapters/orbit/src/index';
// @ts-expect-error Browser example is deliberately JavaScript.
import { startOrbitPreview } from '../../examples/orbit/server.mjs';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('real Orbit preview server', () => {
  it('closes active event streams and half-written requests without waiting for the browser', async () => {
    const preview = await startOrbitPreview();
    cleanup.push(() => preview.close());
    const url = new URL(preview.url);
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write(`GET ${url.pathname}events HTTP/1.1\r\n`);
    const events = await fetch(new URL('events', preview.url));
    const reader = events.body!.getReader();
    await reader.read();
    await Promise.race([preview.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('Preview did not close its owned connections')), 1000))]);
    await preview.close();
    await reader.cancel().catch(() => undefined);
    socket.destroy();
    await expect(fetch(preview.url)).rejects.toThrow();
  });
  it('serves only its authenticated route and streams ephemeral drafts', async () => {
    const preview = await startOrbitPreview();
    cleanup.push(() => preview.close());
    const address = new URL(preview.url);
    expect((await fetch(`${address.origin}/`)).status).toBe(404);
    expect((await fetch(new URL('index.html', preview.url))).headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await fetch(preview.url, { method: 'POST' })).status).toBe(404);
    expect(await (await fetch(new URL('eve.project.json', preview.url))).json()).toMatchObject(DEFAULT_ORBIT_CONFIG);
    preview.updateDraft({ ...DEFAULT_ORBIT_CONFIG, theme: '#998866' }, 'gesture', 1);
    expect(preview.updateDraft({ ...DEFAULT_ORBIT_CONFIG, theme: '#ffffff' }, 'gesture', 0)).toBe(false);
    expect(await (await fetch(new URL('eve.project.json', preview.url))).json()).toMatchObject({ theme: '#998866' });
    preview.clearDraft();
    expect(await (await fetch(new URL('eve.project.json', preview.url))).json()).toMatchObject(DEFAULT_ORBIT_CONFIG);
  });

  it('retains last valid configuration while the authored JSON is incomplete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eve-preview-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await cp(path.resolve('examples/orbit'), root, { recursive: true });
    const preview = await startOrbitPreview({ projectRoot: root });
    cleanup.push(() => preview.close());
    const events = await fetch(new URL('events', preview.url));
    const reader = events.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: config');
    await writeFile(path.join(root, 'eve.project.json'), '{"schemaVersion":');
    let invalid = '';
    while (!invalid.includes('config-error')) {
      const chunk = await reader.read();
      invalid += new TextDecoder().decode(chunk.value);
    }
    expect(await (await fetch(new URL('eve.project.json', preview.url))).json()).toMatchObject(DEFAULT_ORBIT_CONFIG);
    await reader.cancel();
  });
});
