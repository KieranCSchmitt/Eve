import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkbenchService, type WorkbenchRecoveryBatch } from '../../apps/desktop/host/workbench';
import { WorkbenchRecoveryCoordinator } from '../../apps/desktop/host/workbench-recovery';
import type { RecoveryDocument, WorkbenchMethod } from '../../extensions/eve-workbench/src/protocol';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function draft(uri: string, text: string): RecoveryDocument { return { uri, text, hash: digest(text), languageId: 'plaintext', version: 1, dirty: true, untitled: uri.startsWith('untitled:'), bytes: Buffer.byteLength(text), diskHash: null }; }
let directory: string;
let project: string;
let profile: string;
const services: TestWorkbench[] = [];
beforeEach(async () => {
  directory = await mkdtemp('/tmp/eve-recovery-coordinator-'); project = path.join(directory, 'project'); profile = path.join(directory, 'profile');
  await mkdir(project); await mkdir(path.join(profile, 'recovery'), { recursive: true, mode: 0o700 });
});
afterEach(async () => { for (const service of services.splice(0)) await service.close(); await rm(directory, { recursive: true, force: true }); });
async function journal(name: string, documents: RecoveryDocument[]) { await writeFile(path.join(profile, 'recovery', name), JSON.stringify({ version: 1, projectRoot: project, capturedAt: 1, documents }), { mode: 0o600 }); }

/** Real journal/acknowledgment implementation; only the documented extension request boundary is simulated. */
class TestWorkbench extends WorkbenchService {
  live = true;
  buffers: RecoveryDocument[] = [];
  restoreCalls: string[] = [];
  captures = 0;
  acknowledgments = 0;
  failRestore?: number;
  beforeCapture?: (count: number) => Promise<void>;
  constructor() { super({ profileDirectory: profile, projectRoot: project, codeServerExecutable: '/unused', extensionDirectory: '/unused' }); services.push(this); }
  override get connected() { return this.live; }
  override get dirtyDocuments(): readonly RecoveryDocument[] { throw new Error('Coordinator must not consult the optimistic getter.'); }
  override async call<T>(method: WorkbenchMethod, params?: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
    options.signal?.throwIfAborted();
    if (!this.live) throw new Error('Disconnected');
    if (method === 'recovery.capture') { this.captures++; await this.beforeCapture?.(this.captures); options.signal?.throwIfAborted(); return structuredClone(this.buffers) as T; }
    if (method !== 'recovery.restore') throw new Error('No project-edit or original-file method is permitted.');
    const source = params as RecoveryDocument;
    this.restoreCalls.push(source.uri);
    if (this.failRestore === this.restoreCalls.length) throw new Error('Simulated partial restore error');
    const recoveredUri = `untitled:recovered-${this.buffers.length + 1}`;
    this.buffers.push({ ...structuredClone(source), uri: recoveredUri, untitled: true });
    return { recoveredUri, originalUri: source.uri, savedToDisk: false } as T;
  }
  override async acknowledgeRecovery(batch: WorkbenchRecoveryBatch) {
    const durable = JSON.parse(await readFile(path.join(profile, 'recovery', 'current.json'), 'utf8'));
    expect(this.buffers.every(buffer => durable.documents.some((document: RecoveryDocument) => document.uri === buffer.uri && document.text === buffer.text))).toBe(true);
    this.acknowledgments++;
    await super.acknowledgeRecovery(batch);
  }
}

describe('cold workbench draft recovery coordinator', () => {
  it('restores duplicate content once, preserves all original identities, then acknowledges after durable capture', async () => {
    const original = path.join(project, 'note.txt'); await writeFile(original, 'Original on disk');
    const first = draft(`file://${original}`, 'A recoverable draft.'); const second = draft('untitled:earlier', first.text);
    await journal('pending-123-aaaa.json', [first, second]);
    const service = new TestWorkbench(); let chooseCount = 0;
    const recovery = new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: async drafts => { chooseCount++; expect(drafts).toHaveLength(2); return 'recover'; } });
    const result = await recovery.run();
    expect(result).toMatchObject({ status: 'recovered', restored: 1, pending: 0, canReconcileOriginals: true });
    expect(result.recovered[0].originalUris).toEqual([first.uri, second.uri]);
    expect(result.recovered[0].recoveredUri).toMatch(/^untitled:/);
    expect(service.restoreCalls).toHaveLength(1);
    expect(service.acknowledgments).toBe(1);
    expect(await readFile(original, 'utf8')).toBe('Original on disk');
    expect(await readFile(path.join(profile, 'recovery', 'pending-123-aaaa.json'), 'utf8')).toContain('A recoverable draft.');
    expect((await recovery.run()).status).toBe('empty');
    expect(chooseCount).toBe(1);
  });

  it('waits for fsync acknowledgement rather than a restore response or the optimistic dirty getter', async () => {
    await journal('pending-123-bbbb.json', [draft('untitled:old', 'Save me')]);
    const service = new TestWorkbench(); let release!: () => void;
    service.beforeCapture = async count => { if (count === 2) await new Promise<void>(resolve => { release = resolve; }); };
    const recovery = new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: async () => 'recover' });
    const running = recovery.run();
    await expect.poll(() => service.captures).toBe(2);
    expect(service.buffers).toHaveLength(1);
    expect(service.acknowledgments).toBe(0);
    expect((await readdir(path.join(profile, 'recovery')))).not.toContain('acknowledged.json');
    release();
    expect((await running).status).toBe('recovered');
    expect(service.acknowledgments).toBe(1);
  });

  it('keeps later/cancelled choices pending without restoring, acknowledging or changing files', async () => {
    await journal('pending-123-cccc.json', [draft('untitled:old', 'Keep me pending')]);
    const service = new TestWorkbench();
    const later = new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: async () => 'later' });
    expect(await later.run()).toMatchObject({ status: 'later', pending: 1, restored: 0, canReconcileOriginals: false });
    const abort = new AbortController();
    const cancelled = new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: () => new Promise(() => {}) });
    const running = cancelled.run({ signal: abort.signal }); abort.abort();
    expect((await running).status).toBe('cancelled');
    expect(service.restoreCalls).toHaveLength(0);
    expect(service.acknowledgments).toBe(0);
    expect((await service.loadRecoveryBatch()).documents).toHaveLength(1);
  });

  it('retries partial failures without duplicating acknowledged restores or repeating the approved dialog', async () => {
    await journal('pending-123-dddd.json', [draft('untitled:first', 'First'), draft('untitled:second', 'Second')]);
    const service = new TestWorkbench(); service.failRestore = 2; let choices = 0;
    const recovery = new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: async () => { choices++; return 'recover'; } });
    expect(await recovery.run()).toMatchObject({ status: 'partial', restored: 1, pending: 2, canReconcileOriginals: false });
    expect(service.acknowledgments).toBe(0);
    service.failRestore = undefined;
    expect(await recovery.run()).toMatchObject({ status: 'recovered', restored: 2, pending: 0 });
    expect(service.restoreCalls).toEqual(['untitled:first', 'untitled:second', 'untitled:second']);
    expect(service.buffers).toHaveLength(2);
    expect(choices).toBe(1);
  });

  it('preserves drafts added or replaced during the recovery decision instead of sweeping them into acknowledgement', async () => {
    await journal('pending-123-eeee.json', [draft('untitled:old', 'Chosen content')]);
    const service = new TestWorkbench();
    const recovery = new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: async () => {
      await journal('pending-123-eeee.json', [draft('untitled:new-version', 'Changed after choice began')]);
      await journal('pending-124-ffff.json', [draft('untitled:arriving', 'New pending draft')]);
      return 'recover';
    } });
    expect(await recovery.run()).toMatchObject({ status: 'pending', restored: 1, pending: 2, canReconcileOriginals: false });
    expect(service.buffers[0].text).toBe('Chosen content');
    expect((await service.loadRecoveryBatch()).documents.map(document => document.text)).toEqual(['Changed after choice began', 'New pending draft']);
  });

  it('preserves unknown journal material and reports review even when known drafts are recovered', async () => {
    await journal('pending-123-abcd.json', [draft('untitled:known', 'Known draft')]);
    await writeFile(path.join(profile, 'recovery', 'unknown-journal.json'), 'DO NOT DELETE');
    const service = new TestWorkbench();
    const result = await new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: async () => 'recover' }).run();
    expect(result).toMatchObject({ status: 'pending', restored: 1, pending: 0, unknownFiles: ['unknown-journal.json'], canReconcileOriginals: false });
    expect(await readFile(path.join(profile, 'recovery', 'unknown-journal.json'), 'utf8')).toBe('DO NOT DELETE');
  });

  it('does not acknowledge disconnected or modified recovered buffers, and allows restart from preserved journals', async () => {
    await journal('pending-123-bcde.json', [draft('untitled:before', 'Before crash')]);
    const service = new TestWorkbench(); service.beforeCapture = async count => { if (count === 2) service.live = false; };
    const result = await new WorkbenchRecoveryCoordinator({ workbench: service, chooseRecovery: async () => 'recover' }).run();
    expect(result).toMatchObject({ status: 'partial', pending: 1, canReconcileOriginals: false });
    expect(service.acknowledgments).toBe(0);
    const restarted = new TestWorkbench();
    const coordinator = new WorkbenchRecoveryCoordinator({ workbench: restarted, chooseRecovery: async () => 'recover' });
    restarted.beforeCapture = async count => { if (count === 2) { restarted.buffers[0].text = 'Edited before snapshot'; restarted.buffers[0].hash = digest('Edited before snapshot'); } };
    expect((await coordinator.run()).status).toBe('partial');
    expect(restarted.acknowledgments).toBe(0);
    expect((await restarted.loadRecoveryBatch()).documents[0].text).toBe('Before crash');
  });

  it('defers an approved recovery when its owning editor leaves attention before restore, then resumes explicitly', async () => {
    await journal('pending-123-cdef.json', [draft('untitled:owner', 'This belongs to Alpha')]);
    const service = new TestWorkbench(); let active = true; let choices = 0;
    service.beforeCapture = async count => { if (count === 1) active = false; };
    const coordinator = new WorkbenchRecoveryCoordinator({
      workbench: service,
      chooseRecovery: async () => { choices++; return 'recover'; },
      assertActive: async () => { if (!active) throw new Error('Owner no longer active'); },
    });
    expect(await coordinator.run()).toMatchObject({ status: 'pending', pending: 1, restored: 0 });
    expect(service.restoreCalls).toHaveLength(0);
    expect(service.acknowledgments).toBe(0);
    active = true;
    expect(await coordinator.run()).toMatchObject({ status: 'recovered', pending: 0, restored: 1 });
    expect(choices).toBe(1);
  });

  it('preserves the old batch when attention changes during durable capture, and retries acknowledgement without duplicate buffers', async () => {
    await journal('pending-123-defa.json', [draft('untitled:owner', 'Retain this draft')]);
    const service = new TestWorkbench(); let active = true;
    service.beforeCapture = async count => { if (count === 2) active = false; };
    const coordinator = new WorkbenchRecoveryCoordinator({
      workbench: service,
      chooseRecovery: async () => 'recover',
      assertActive: async () => { if (!active) throw new Error('Owner no longer active'); },
    });
    expect(await coordinator.run()).toMatchObject({ status: 'partial', pending: 1, restored: 1 });
    expect(service.acknowledgments).toBe(0);
    expect((await service.loadRecoveryBatch()).documents).toHaveLength(1);
    active = true;
    expect(await coordinator.run()).toMatchObject({ status: 'recovered', pending: 0, restored: 1 });
    expect(service.restoreCalls).toHaveLength(1);
    expect(service.acknowledgments).toBe(1);
  });
});
