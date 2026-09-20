import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableEditAcknowledgements, type PreparedDurableEdit } from '../../extensions/eve-workbench/src/durable-edits';
import { OrphanRecoveryWriter } from '../../extensions/eve-workbench/src/recovery-journal';
import type { DocumentState, RecoveryDocument } from '../../extensions/eve-workbench/src/protocol';

const faults = vi.hoisted(() => ({ sync: undefined as undefined | ((file: string, directory: boolean) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => {
            await faults.sync?.(String(args[0]), (await target.stat()).isDirectory());
            return target.sync();
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

const directories: string[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function state(text: string, version: number): DocumentState {
  return { uri: 'file:///project/app.ts', version, text, hash: sha(text), languageId: 'typescript', dirty: true, untitled: false, bytes: Buffer.byteLength(text) };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'eve-edit-durable-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const journal = path.join(directory, 'orphan-abcd-1234.json');
  const writer = new OrphanRecoveryWriter(journal);
  await writer.initialize();
  let current = state('before', 1);
  let closed = false;
  const apply = vi.fn(async () => { current = state('after', current.version + 1); return true; });
  const recover = vi.fn(async (fallback: readonly DocumentState[]) => {
    const captured = (closed ? fallback : [current]).map(document => ({ ...document, text: document.text!, diskHash: sha('before') }));
    await writer.persist(directory, captured);
    return captured;
  });
  const prepare = vi.fn(async (): Promise<PreparedDurableEdit> => ({
    apply, inspect: () => closed ? [] : [{ ...current }], intended: [{ uri: current.uri, hash: sha('after') }], maximumRecoveryBytes: 4096, recover,
  }));
  return { directory, journal, writer, apply, recover, prepare, change: (text: string) => { current = state(text, current.version + 1); }, close: () => { closed = true; } };
}
afterEach(async () => {
  faults.sync = undefined;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('durable native edit acknowledgements', () => {
  it('waits for the actual recovery file and parent directory sync before acknowledgement', async () => {
    const f = await fixture();
    const entered = gate(); const release = gate();
    const synced: string[] = [];
    faults.sync = async (file, directory) => {
      synced.push(directory ? 'directory' : 'file');
      if (!directory) { entered.resolve(); await release.promise; }
    };
    const acknowledgements = new DurableEditAcknowledgements();
    let settled = false;
    const pending = acknowledgements.run('operation', 'same-input', f.prepare).finally(() => { settled = true; });
    await entered.promise;
    expect(settled).toBe(false);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(await readdir(f.directory)).toEqual([expect.stringMatching(/\.tmp$/)]);
    release.resolve();
    const result = await pending;
    expect(result.synchronized).toBe(true);
    expect(synced).toEqual(['file', 'directory']);
    const saved = JSON.parse(await readFile(f.journal, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.documents).toEqual(result.documents);
    expect(saved.documents[0]).toMatchObject({ text: 'after', version: 2, hash: sha('after') });
    expect((await stat(f.journal)).mode & 0o777).toBe(0o600);
  });

  it.each(['file', 'directory'])('never acknowledges a failed %s sync; retry persists without another native edit', async failing => {
    const f = await fixture();
    const acknowledgements = new DurableEditAcknowledgements();
    faults.sync = async (_file, directory) => { if (directory === (failing === 'directory')) throw new Error('injected fsync failure'); };
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_APPLIED_RECOVERY_FAILED');
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect((await readdir(f.directory)).some(name => name.endsWith('.tmp'))).toBe(false);
    faults.sync = undefined;
    expect((await acknowledgements.run('operation', 'same-input', f.prepare)).synchronized).toBe(true);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(f.journal, 'utf8')).documents[0].text).toBe('after');
  });

  it('does not claim the captured version is current when the user types during persistence', async () => {
    const f = await fixture(); const entered = gate(); const release = gate();
    faults.sync = async (_file, directory) => { if (!directory) { entered.resolve(); await release.promise; } };
    const acknowledgements = new DurableEditAcknowledgements();
    const pending = acknowledgements.run('operation', 'same-input', f.prepare);
    await entered.promise;
    f.change('after plus my typing');
    release.resolve();
    const result = await pending;
    expect(result.synchronized).toBe(false);
    expect(result.documents[0]).toMatchObject({ text: 'after', version: 2 });
    faults.sync = undefined;
    const retry = await acknowledgements.run('operation', 'same-input', f.prepare);
    expect(retry.synchronized).toBe(false);
    expect(retry.documents[0]).toMatchObject({ text: 'after plus my typing', version: 3 });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('does not return a cached synchronized success after an undo/redo changed the version', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements();
    expect((await acknowledgements.run('operation', 'same-input', f.prepare)).synchronized).toBe(true);
    f.change('before'); f.change('after');
    const retry = await acknowledgements.run('operation', 'same-input', f.prepare);
    expect(retry.synchronized).toBe(false);
    expect(retry.documents[0]).toMatchObject({ text: 'after', version: 4 });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('preserves an applied document that closed after persistence failed as a recovery copy', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements();
    faults.sync = async () => { throw new Error('disk unavailable'); };
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_APPLIED_RECOVERY_FAILED');
    f.close(); faults.sync = undefined;
    const retry = await acknowledgements.run('operation', 'same-input', f.prepare);
    expect(retry.synchronized).toBe(false);
    expect(JSON.parse(await readFile(f.journal, 'utf8')).documents[0]).toMatchObject({ text: 'after', version: 2 });
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent retries and refuses an operation ID with changed input', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements();
    const results = await Promise.all([acknowledgements.run('operation', 'same-input', f.prepare), acknowledgements.run('operation', 'same-input', f.prepare)]);
    expect(results.every(result => result.synchronized)).toBe(true);
    expect(f.apply).toHaveBeenCalledTimes(1);
    await expect(acknowledgements.run('operation', 'other-input', f.prepare)).rejects.toThrow('cannot be reused');
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('captures available buffers but never retries a native edit with uncertain outcome', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements();
    f.apply.mockImplementationOnce(async () => { f.change('after'); throw new Error('native dispatch lost its reply'); });
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_OUTCOME_UNCERTAIN');
    expect(JSON.parse(await readFile(f.journal, 'utf8')).documents[0].text).toBe('after');
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_OUTCOME_UNCERTAIN');
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('refuses new attempts at its bound without evicting an uncertain operation ID', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements(1);
    f.apply.mockResolvedValueOnce(false);
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_OUTCOME_UNCERTAIN');
    await expect(acknowledgements.run('new-operation', 'new-input', f.prepare)).rejects.toThrow('receipt limit');
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_OUTCOME_UNCERTAIN');
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('refuses an edit before native dispatch when its recovery byte reservation exceeds the budget', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements(10, 1024);
    await expect(acknowledgements.run('too-large', 'same-input', f.prepare)).rejects.toThrow('recovery byte limit');
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('compacts durable payloads under byte pressure but retains no-reapply operation tombstones', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements(10, 5000);
    expect((await acknowledgements.run('first', 'input-one', f.prepare)).synchronized).toBe(true);
    expect((await acknowledgements.run('second', 'input-two', f.prepare)).synchronized).toBe(true);
    expect(f.apply).toHaveBeenCalledTimes(2);
    await expect(acknowledgements.run('first', 'input-one', f.prepare)).rejects.toThrow('EDIT_RECEIPT_COMPACTED');
    await expect(acknowledgements.run('first', 'different-input', f.prepare)).rejects.toThrow('cannot be reused');
    expect(f.apply).toHaveBeenCalledTimes(2);
  });

  it('retains failed recovery payloads under pressure, then frees capacity after their persistence retry', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements(10, 5000);
    faults.sync = async () => { throw new Error('disk unavailable'); };
    await expect(acknowledgements.run('first', 'input-one', f.prepare)).rejects.toThrow('EDIT_APPLIED_RECOVERY_FAILED');
    await expect(acknowledgements.run('second', 'input-two', f.prepare)).rejects.toThrow('occupied by unconfirmed edits');
    expect(f.apply).toHaveBeenCalledTimes(1);
    faults.sync = undefined;
    expect((await acknowledgements.run('first', 'input-one', f.prepare)).synchronized).toBe(true);
    expect((await acknowledgements.run('second', 'input-two', f.prepare)).synchronized).toBe(true);
    expect(f.apply).toHaveBeenCalledTimes(2);
  });

  it.each(['file', 'directory'])('refuses acknowledgement when the recovery directory is replaced during %s sync and leaves replacement files untouched', async phase => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements();
    const moved = `${f.directory}-original`; directories.push(moved);
    let replaced = false;
    let replacementStage: string | undefined;
    faults.sync = async (file, directory) => {
      if (replaced || directory !== (phase === 'directory')) return;
      replaced = true;
      await rename(f.directory, moved);
      await mkdir(f.directory, { mode: 0o700 });
      await writeFile(f.journal, 'replacement journal must remain', { mode: 0o600 });
      if (!directory) {
        replacementStage = file;
        await writeFile(file, 'replacement stage must remain', { mode: 0o600 });
      }
    };
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_APPLIED_RECOVERY_FAILED');
    expect(await readFile(f.journal, 'utf8')).toBe('replacement journal must remain');
    if (replacementStage) expect(await readFile(replacementStage, 'utf8')).toBe('replacement stage must remain');
    const preserved = await readdir(moved);
    expect(preserved).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(moved, preserved[0]!), 'utf8')).documents[0].text).toBe('after');
    expect(f.apply).toHaveBeenCalledTimes(1);
    faults.sync = undefined;
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_APPLIED_RECOVERY_FAILED');
    expect(await readFile(f.journal, 'utf8')).toBe('replacement journal must remain');
    expect(f.apply).toHaveBeenCalledTimes(1);
  });

  it('refuses a linked recovery journal without following or replacing its target', async () => {
    const f = await fixture(); const acknowledgements = new DurableEditAcknowledgements();
    const outside = path.join(f.directory, 'outside.txt');
    await writeFile(outside, 'untouched', { mode: 0o600 });
    await symlink(outside, f.journal);
    await expect(acknowledgements.run('operation', 'same-input', f.prepare)).rejects.toThrow('EDIT_APPLIED_RECOVERY_FAILED');
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect((await readdir(f.directory)).sort()).toEqual(['orphan-abcd-1234.json', 'outside.txt']);
  });

  it('durably records explicit clean capture while preserving older and unknown journals', async () => {
    const f = await fixture();
    await new DurableEditAcknowledgements().run('operation', 'input', f.prepare);
    const original = await readFile(f.journal, 'utf8');
    const preserved = ['pending-123-abcd.json', 'orphan-dead-beef.json', 'unknown.snapshot'];
    for (const name of preserved) await writeFile(path.join(f.directory, name), `Original ${name}`, { mode: 0o600 });
    // An ordinary empty timer capture is still conservative.
    await f.writer.persist(f.directory, []);
    expect(await readFile(f.journal, 'utf8')).toBe(original);
    const entered = gate(); const release = gate();
    faults.sync = async (_file, directory) => { if (!directory) { entered.resolve(); await release.promise; } };
    let complete = false;
    const pending = f.writer.persist(f.directory, [], { writeEmpty: true }).then(() => { complete = true; });
    await entered.promise;
    expect(complete).toBe(false);
    expect(await readFile(f.journal, 'utf8')).toBe(original);
    release.resolve(); await pending;
    expect(JSON.parse(await readFile(f.journal, 'utf8')).documents).toEqual([]);
    for (const name of preserved) expect(await readFile(path.join(f.directory, name), 'utf8')).toBe(`Original ${name}`);
  });
});
