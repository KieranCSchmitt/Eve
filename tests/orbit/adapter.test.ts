import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ORBIT_CONFIG, OrbitDraft, commitOrbitConfig, contentHash, parseOrbitConfig, readOrbitConfig, serializeOrbitConfig } from '../../adapters/orbit/src/index';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eve-orbit-'));
  roots.push(root);
  await writeFile(path.join(root, 'eve.project.json'), serializeOrbitConfig(DEFAULT_ORBIT_CONFIG));
  return root;
}

describe('Orbit authoring invariants', () => {
  it('rejects invalid easing, unsupported fields, and fractional session duration', () => {
    expect(() => parseOrbitConfig({ ...DEFAULT_ORBIT_CONFIG, easing: [-0.1, 0, 1, 1] })).toThrow();
    expect(() => parseOrbitConfig({ ...DEFAULT_ORBIT_CONFIG, durationMinutes: 1.5 })).toThrow();
    expect(() => parseOrbitConfig({ ...DEFAULT_ORBIT_CONFIG, javascript: 'alert(1)' })).toThrow();
    expect(parseOrbitConfig({ ...DEFAULT_ORBIT_CONFIG, transitionMs: 3000 }).transitionMs).toBe(3000);
  });

  it('writes a real atomic replacement and returns a reversible receipt', async () => {
    const root = await project();
    const before = await readOrbitConfig(root);
    const next = { ...before.config, theme: '#448866' };
    const receipt = await commitOrbitConfig({ projectRoot: root, expectedHash: before.hash, next, operationId: 'color-1', editorFreeLease: true });
    expect((await readOrbitConfig(root)).config.theme).toBe('#448866');
    expect(receipt.beforeText).toBe(before.text);
    expect(receipt.afterHash).toBe(contentHash(await readFile(before.file, 'utf8')));
    expect(receipt.location).toBe('file');
  });

  it('never overwrites a newer disk revision', async () => {
    const root = await project();
    const before = await readOrbitConfig(root);
    const newer = serializeOrbitConfig({ ...before.config, durationMinutes: 45 });
    await writeFile(before.file, newer);
    await expect(commitOrbitConfig({ projectRoot: root, expectedHash: before.hash, next: { ...before.config, theme: '#448866' }, operationId: 'stale', editorFreeLease: true })).rejects.toThrow('changed on disk');
    expect(await readFile(before.file, 'utf8')).toBe(newer);
  });

  it('refuses a disk write when the editor state is unknown', async () => {
    const root = await project();
    const before = await readOrbitConfig(root);
    await expect(commitOrbitConfig({ projectRoot: root, expectedHash: before.hash, next: before.config, operationId: 'unknown' })).rejects.toThrow('editor connection');
  });

  it('routes a dirty hidden buffer through one versioned editor edit, preserving disk', async () => {
    const root = await project();
    const disk = await readOrbitConfig(root);
    const dirty = serializeOrbitConfig({ ...disk.config, durationMinutes: 35 });
    let replacements = 0;
    const next = { ...parseOrbitConfig(dirty), transitionMs: 400 };
    const receipt = await commitOrbitConfig({
      projectRoot: root, expectedHash: contentHash(dirty), next, operationId: 'buffer',
      editor: {
        async inspect() { return { uri: `file://${disk.file}`, version: 8, hash: contentHash(dirty), text: dirty }; },
        async replace(revision, text, id) {
          expect(revision.version).toBe(8); expect(id).toBe('buffer'); replacements++;
          return { ...revision, version: 9, hash: contentHash(text), text };
        },
      },
    });
    expect(replacements).toBe(1);
    expect(receipt.location).toBe('buffer');
    expect(receipt.documentVersion).toBe(9);
    expect(await readFile(disk.file, 'utf8')).toBe(disk.text);
  });

  it('detects an editor opening during a disk commit and leaves disk untouched', async () => {
    const root = await project();
    const before = await readOrbitConfig(root);
    let inspections = 0;
    await expect(commitOrbitConfig({ projectRoot: root, expectedHash: before.hash, next: { ...before.config, transitionMs: 0 }, operationId: 'race', editor: {
      async inspect() { return ++inspections === 1 ? null : { uri: `file://${before.file}`, version: 1, hash: before.hash, text: before.text }; },
      async replace() { throw new Error('Should not replace a newly discovered buffer with a stale disk operation.'); },
    } })).rejects.toThrow('opened in the editor');
    expect(await readFile(before.file, 'utf8')).toBe(before.text);
  });

  it('keeps direct manipulation draft-only and assigns monotonic gesture sequence', () => {
    const original = structuredClone(DEFAULT_ORBIT_CONFIG);
    const draft = new OrbitDraft('drag-1', 'original-hash', original);
    expect(draft.update({ transitionMs: 300 }).sequence).toBe(1);
    expect(draft.update({ transitionMs: 400 }).sequence).toBe(2);
    expect(original.transitionMs).toBe(260);
    expect(draft.current().transitionMs).toBe(400);
  });
});
