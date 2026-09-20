import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ syncPath: '', syncExact: '', readPath: '', changed: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const file = String(args[0]);
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync' && ((fault.syncPath && file.includes(fault.syncPath)) || (fault.syncExact && file === fault.syncExact))) return async () => { throw Object.assign(new Error('Injected storage failure'), { code: 'EIO' }); };
        if (property === 'read' && file === fault.readPath) return async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await target.read(...readArgs);
          if (!fault.changed) { fault.changed = true; await actual.writeFile(file, 'changed externally during copy'); }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
});
import { ImportError, ManagedImporter } from '../../packages/imports/src/index';

let root: string | undefined;
afterEach(async () => { fault.syncPath = ''; fault.syncExact = ''; fault.readPath = ''; fault.changed = false; if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
async function fixture() {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-import-failure-')));
  const importer = await ManagedImporter.open({ managedRoot: path.join(root, 'managed') });
  const source = path.join(root, 'original.txt'); await writeFile(source, 'the original bytes');
  return { importer, source, assets: path.join(root, 'managed/assets') };
}

describe('copy failure boundaries', () => {
  it('discards a source snapshot that changed during its copy', async () => {
    const { importer, source, assets } = await fixture(); fault.readPath = source;
    await expect(importer.importAsset({ taskId: 't', sourcePath: source })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await readFile(source, 'utf8')).toBe('changed externally during copy');
    expect(await readdir(assets)).toEqual([]);
  });
  it('cleans an unpublished stage when the copied file cannot be synced', async () => {
    const { importer, source, assets } = await fixture(); fault.syncPath = '.staging-';
    await expect(importer.importAsset({ taskId: 't', sourcePath: source })).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(await readdir(assets)).toEqual([]);
    expect(await readFile(source, 'utf8')).toBe('the original bytes');
  });
  it('retains a published copy and manifest when the final directory sync fails', async () => {
    const { importer, source, assets } = await fixture();
    // Exact parent match: stages and copied files sync normally before publication.
    fault.syncExact = assets;
    let failure: unknown;
    try { await importer.importAsset({ taskId: 't', sourcePath: source }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ImportError);
    expect(failure).toMatchObject({ code: 'DURABILITY_UNCERTAIN' });
    const retainedPath = (failure as ImportError).retainedPath!;
    const manifest = JSON.parse(await readFile(path.join(retainedPath, 'manifest.json'), 'utf8'));
    expect(await readFile(manifest.registration.managedPath, 'utf8')).toBe('the original bytes');
    expect(await readdir(assets)).toEqual([path.basename(retainedPath)]);
    expect(await readFile(source, 'utf8')).toBe('the original bytes');
  });
});
