import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { CoreStore } from '@eve/core';
import { ALL_CAPABILITIES } from '@eve/contracts';
import { ManagedImporter } from '../../packages/imports/src/index';
import { exportProfileBackup, restoreProfileBackup, verifyBackup } from '../../packages/backup/src/index';
import { relocateEveProfile } from '../../apps/desktop/host/profile-relocation';
import { WorkbenchService } from '../../apps/desktop/host/workbench';

const temporary: string[] = [];
const stores: CoreStore[] = [];
const auth = { actorId: 'test-user', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('complete offline Eve profile relocation', () => {
  it('exports from the real single writer and cold-opens an independent restored profile with material and checkpoints intact', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-real-profile-restore-'))); temporary.push(root);
    const profile = path.join(root, 'original'), destination = path.join(root, 'restored');
    const project = path.join(profile, 'workspaces/orbit');
    await mkdir(project, { recursive: true, mode: 0o700 });
    await writeFile(path.join(project, 'eve.project.json'), '{"author":"original project"}');
    const store = new CoreStore({ dbPath: path.join(profile, 'eve.db'), orbitProjectPath: project }); stores.push(store);
    const secondProject = path.join(profile, 'workspaces/study'); await mkdir(secondProject, { mode: 0o700 }); await writeFile(path.join(secondProject, 'study.txt'), 'second original');
    const secondTask = store.snapshot().tasks.find(item => item.id === 'photo-walk')!, identity = await stat(secondProject, { bigint: true });
    expect(store.registerProject({ requestId: 'register-study', taskId: secondTask.id, expectedEpoch: secondTask.epoch, expectedTaskRevision: secondTask.revision,
      project: { id: 'study-project', canonicalRoot: secondProject, rootIdentity: { device: String(identity.dev), inode: String(identity.ino) }, kind: 'managed', adapter: 'generic', preview: { kind: 'none' } } }, auth).ok).toBe(true);
    const originalDrafts = new Map<string, string>();
    for (const task of store.snapshot().tasks.filter(task => task.project)) {
      const source = task.project!, recovery = path.join(profile, 'workbench/recovery', source.id); await mkdir(recovery, { recursive: true, mode: 0o700 });
      const text = `${source.id}: dirty contents with authored reference ${profile}`; originalDrafts.set(source.id, text);
      const snapshot = { version: 1, capturedAt: 1234, projectRoot: source.canonicalRoot, documents: [{ uri: 'untitled:recovered', version: 1, text, bytes: Buffer.byteLength(text), hash: hash(text), languageId: 'plaintext', dirty: true, untitled: true, diskHash: null }] };
      const bytes = JSON.stringify(snapshot); await writeFile(path.join(recovery, 'orphan-abcd.json'), bytes); await writeFile(path.join(recovery, 'pending-222-abcd.json'), bytes);
      await writeFile(path.join(recovery, 'acknowledged.json'), JSON.stringify({ version: 1, projectRoot: source.canonicalRoot, files: [{ name: 'orphan-abcd.json', sha256: hash(bytes) }] }));
      await writeFile(path.join(recovery, 'future.journal'), 'future bytes stay inert');
    }
    const task = store.snapshot().tasks.find(item => item.id === 'orbit')!;
    const body = `A note referring to ${profile}; this authored text must not be rewritten.`;
    expect(store.dispatch({ type: 'UpdateNote', requestId: 'save-before-backup', taskId: task.id, expectedEpoch: task.epoch, expectedRevision: task.note.revision, body }, auth).ok).toBe(true);
    const current = store.snapshot().tasks.find(item => item.id === 'orbit')!;
    expect(store.dispatch({ type: 'SaveCheckpoint', requestId: 'place-before-backup', taskId: current.id, expectedEpoch: current.epoch, expectedRevision: current.checkpoint?.revision ?? 0,
      checkpoint: { layout: 'work', selectedActivity: 'code', selectedFile: pathToFileURL(path.join(project, 'eve.project.json')).href, topLine: 4, returnAnchors: [], noteView: { version: 1, noteId: current.note.id, noteRevision: current.note.revision, selection: { anchor: 10, head: 4 }, scrollTop: 200 } } }, auth).ok).toBe(true);
    const originalText = path.join(root, 'reference.txt'); await writeFile(originalText, 'A source worth keeping.');
    const importer = await ManagedImporter.open({ managedRoot: path.join(profile, 'storage') });
    const asset = await importer.importAsset({ taskId: 'orbit', sourcePath: originalText });
    expect(store.registerAsset(asset, auth).ok).toBe(true);
    const backup = path.join(root, 'backup'); let held = false;
    await exportProfileBackup({ profileRoot: profile, destination: backup, versions: { app: '0.1.0', schema: store.diagnostics().schemaVersion },
      entries: [{ path: 'storage/assets', kind: 'managed-originals' }, { path: 'workspaces', kind: 'project' }, { path: 'workbench/recovery', kind: 'recovery' }],
      quiesce: async () => { held = true; return { assertHeld: async () => { if (!held) throw new Error('not held'); }, release: async () => { held = false; } }; },
      backupDatabase: async (file, signal) => { expect(held).toBe(true); await store.backupDatabase(file, { signal }); },
    });
    const immutable = await verifyBackup(backup);
    const restored = await restoreProfileBackup({ backupDirectory: backup, destination, validateVersions: async versions => versions.app === '0.1.0' && versions.schema === store.diagnostics().schemaVersion, relocate: relocateEveProfile });
    expect(restored.receipt.validated).toBe(true);
    expect(restored.receipt.notes.join(' ')).not.toContain('host must compose');
    expect(await verifyBackup(backup)).toEqual(immutable);
    const cold = new CoreStore({ dbPath: path.join(destination, 'eve.db') }); stores.push(cold);
    const recalled = cold.snapshot().tasks.find(item => item.id === 'orbit')!;
    expect(recalled.projectPath).toBe(path.join(destination, 'workspaces/orbit'));
    expect(recalled.note.body).toBe(body);
    for (const restoredTask of cold.snapshot().tasks.filter(task => task.project)) {
      const restoredProject = restoredTask.project!, recoveryDirectory = path.join(destination, 'workbench/recovery', restoredProject.id);
      expect(restoredProject.verification).toBe('legacy-unverified'); expect(restoredProject.rootIdentity).toBeNull();
      const service = new WorkbenchService({ codeServerExecutable: '/unused', extensionDirectory: '/unused', projectRoot: restoredProject.canonicalRoot, profileDirectory: path.join(destination, 'workbench/instances', restoredProject.id), recoveryDirectory });
      const batch = await service.loadRecoveryBatch(); expect(batch.documents.map(document => document.text)).toEqual([originalDrafts.get(restoredProject.id)]);
      expect(batch.unrecognizedFiles).toEqual(['future.journal']);
      const journal = await readFile(path.join(recoveryDirectory, 'orphan-abcd.json'), 'utf8'), receipt = JSON.parse(await readFile(path.join(recoveryDirectory, 'acknowledged.json'), 'utf8'));
      expect(receipt.projectRoot).toBe(restoredProject.canonicalRoot); expect(receipt.files).toEqual([{ name: 'orphan-abcd.json', sha256: hash(journal) }]);
      await service.close();
    }
    expect(recalled.checkpoint).toMatchObject({ selectedFile: pathToFileURL(path.join(destination, 'workspaces/orbit/eve.project.json')).href, topLine: 4, noteView: { selection: { anchor: 10, head: 4 }, scrollTop: 200 } });
    const relocatedAsset = cold.listAssets('orbit')[0]!;
    expect(relocatedAsset.originalPath).toBe(originalText);
    expect(relocatedAsset.managedPath).toBe(path.join(destination, path.relative(profile, asset.managedPath)));
    expect(await readFile(relocatedAsset.managedPath, 'utf8')).toBe('A source worth keeping.');
    expect(store.snapshot().tasks.find(item => item.id === 'orbit')!.projectPath).toBe(project);
    const retry = cold.dispatch({ type: 'UpdateNote', requestId: 'save-before-backup', taskId: task.id, expectedEpoch: task.epoch, expectedRevision: task.note.revision, body }, auth);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.snapshot.tasks.find(item => item.id === 'orbit')!.projectPath).toBe(recalled.projectPath);
  });
});
