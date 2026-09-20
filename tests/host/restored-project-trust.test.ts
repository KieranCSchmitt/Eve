import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoreStore } from '@eve/core';
import { exportProfileBackup, restoreProfileBackup } from '../../packages/backup/src/index';
import { relocateEveProfile } from '../../apps/desktop/host/profile-relocation';
import { approveRestoredProjects, inspectRestoredProjectTrust, RESTORE_RECEIPT_FILE, RESTORED_PROJECT_TRUST_FILE } from '../../apps/desktop/host/restored-project-trust';

let root: string, profile: string;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const receipt = () => ({ version: 1, backupId: '94d41eb3-93b4-4d9b-b86c-cac6a06cab0a', versions: { app: '0.1.0', schema: 3 }, requiresApplicationQualification: true,
  relocation: { validated: true, changedFiles: ['eve.db'], notes: ['Original content preserved.'] }, files: [{ path: 'eve.db', bytes: 12, sha256: hash('database snapshot') }] });
async function putReceipt(value: unknown = receipt(), destination = profile) {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(destination, RESTORE_RECEIPT_FILE), text, { mode: 0o600 });
  return hash(text);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-project-trust-')));
  profile = path.join(root, 'profile'); await mkdir(profile, { mode: 0o700 });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it('recognizes ordinary profiles but leaves restored project execution untrusted', async () => {
  expect(await inspectRestoredProjectTrust(profile)).toEqual({ restored: false, trusted: true });
  const receiptHash = await putReceipt();
  expect(await inspectRestoredProjectTrust(profile)).toEqual({ restored: true, trusted: false, receiptHash });
  expect(await readdir(profile)).toEqual([RESTORE_RECEIPT_FILE]);
});

it('writes private atomic approval for the exact receipt and profile, preserving the receipt bytes', async () => {
  const receiptHash = await putReceipt();
  const before = await readFile(path.join(profile, RESTORE_RECEIPT_FILE));
  expect(await approveRestoredProjects(profile, receiptHash)).toEqual({ restored: true, trusted: true, receiptHash });
  expect(await inspectRestoredProjectTrust(profile)).toEqual({ restored: true, trusted: true, receiptHash });
  const approvalFile = path.join(profile, RESTORED_PROJECT_TRUST_FILE), approval = await readFile(approvalFile, 'utf8');
  expect(JSON.parse(approval)).toMatchObject({ version: 1, kind: 'eve-restored-project-approval', profileRoot: profile, restoreReceiptSha256: receiptHash, scope: 'restored-project-content' });
  expect((await stat(approvalFile)).mode & 0o777).toBe(0o600);
  expect((await readdir(profile)).sort()).toEqual([RESTORE_RECEIPT_FILE, RESTORED_PROJECT_TRUST_FILE].sort());
  expect(await readFile(path.join(profile, RESTORE_RECEIPT_FILE))).toEqual(before);
  await approveRestoredProjects(profile, receiptHash);
  expect(await readFile(approvalFile, 'utf8')).toBe(approval);
});

it('invalidates a previous approval when the receipt changes and rejects an outdated dialog decision', async () => {
  const originalHash = await putReceipt(); await approveRestoredProjects(profile, originalHash);
  const priorApproval = await readFile(path.join(profile, RESTORED_PROJECT_TRUST_FILE), 'utf8');
  const updated = receipt(); updated.relocation.notes.push('A different restore qualification.');
  const receiptHash = await putReceipt(updated);
  expect(await inspectRestoredProjectTrust(profile)).toEqual({ restored: true, trusted: false, receiptHash });
  await expect(approveRestoredProjects(profile, originalHash)).rejects.toMatchObject({ code: 'RECEIPT_CHANGED' });
  expect(await readFile(path.join(profile, RESTORED_PROJECT_TRUST_FILE), 'utf8')).toBe(priorApproval);
  expect(await approveRestoredProjects(profile, receiptHash)).toMatchObject({ trusted: true });
});

it('does not transfer approval to another profile or infer trust from malformed or broader permission records', async () => {
  const receiptHash = await putReceipt(); await approveRestoredProjects(profile, receiptHash);
  const second = path.join(root, 'second'); await mkdir(second, { mode: 0o700 });
  await copyFile(path.join(profile, RESTORE_RECEIPT_FILE), path.join(second, RESTORE_RECEIPT_FILE));
  await copyFile(path.join(profile, RESTORED_PROJECT_TRUST_FILE), path.join(second, RESTORED_PROJECT_TRUST_FILE));
  expect(await inspectRestoredProjectTrust(second)).toEqual({ restored: true, trusted: false, receiptHash });
  await writeFile(path.join(second, RESTORED_PROJECT_TRUST_FILE), '{invalid JSON');
  expect(await inspectRestoredProjectTrust(second)).toMatchObject({ trusted: false });
  const existing = JSON.parse(await readFile(path.join(profile, RESTORED_PROJECT_TRUST_FILE), 'utf8'));
  await writeFile(path.join(second, RESTORED_PROJECT_TRUST_FILE), JSON.stringify({ ...existing, profileRoot: second, scope: 'all-projects-on-this-computer' }));
  expect(await inspectRestoredProjectTrust(second)).toMatchObject({ trusted: false });
  expect(await approveRestoredProjects(second, receiptHash)).toMatchObject({ trusted: true });
});

it.each([
  ['malformed JSON', '{invalid'],
  ['unknown format', { ...receipt(), version: 2 }],
  ['invalid digest', { ...receipt(), files: [{ path: 'eve.db', bytes: 12, sha256: 'not-a-hash' }] }],
  ['unsafe namespace', { ...receipt(), files: [{ path: '../eve.db', bytes: 12, sha256: '0'.repeat(64) }] }],
  ['unknown changed file', { ...receipt(), relocation: { validated: true, changedFiles: ['unknown.json'], notes: [] } }],
  ['unvalidated relocation', { ...receipt(), relocation: { validated: false, changedFiles: ['eve.db'], notes: [] } }],
  ['unexpected authority', { ...receipt(), trusted: true }],
])('refuses present receipt with %s without treating the profile as ordinary', async (_name, input) => {
  const receiptHash = await putReceipt(input);
  await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  await expect(approveRestoredProjects(profile, receiptHash)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  expect(await readdir(profile)).toEqual([RESTORE_RECEIPT_FILE]);
});

it('refuses receipt disappearance beneath an existing restore approval', async () => {
  const receiptHash = await putReceipt(); await approveRestoredProjects(profile, receiptHash);
  await rm(path.join(profile, RESTORE_RECEIPT_FILE));
  await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
});

it('rejects symlinked receipts, approvals, and profile ancestors without altering their targets', async () => {
  const external = path.join(root, 'external'); await mkdir(external, { mode: 0o700 });
  const receiptHash = await putReceipt(receipt(), external);
  await symlink(path.join(external, RESTORE_RECEIPT_FILE), path.join(profile, RESTORE_RECEIPT_FILE));
  await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await rm(path.join(profile, RESTORE_RECEIPT_FILE)); await putReceipt();
  const target = path.join(external, 'approval'); await writeFile(target, 'untouched', { mode: 0o600 });
  await symlink(target, path.join(profile, RESTORED_PROJECT_TRUST_FILE));
  await expect(approveRestoredProjects(profile, receiptHash)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  expect(await readFile(target, 'utf8')).toBe('untouched');
  await symlink(root, path.join(root, 'alias'));
  await expect(inspectRestoredProjectTrust(path.join(root, 'alias/profile'))).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});

it('refuses public metadata, public profile directories, hardlinks and wrong ownership', async () => {
  const receiptHash = await putReceipt();
  await chmod(path.join(profile, RESTORE_RECEIPT_FILE), 0o644);
  await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await chmod(path.join(profile, RESTORE_RECEIPT_FILE), 0o600);
  await chmod(profile, 0o755);
  await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await chmod(profile, 0o700);
  await link(path.join(profile, RESTORE_RECEIPT_FILE), path.join(root, 'linked-receipt'));
  await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await rm(path.join(root, 'linked-receipt'));
  if (process.getuid) {
    const current = process.getuid(); const mock = vi.spyOn(process, 'getuid').mockReturnValue(current + 1);
    await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'UNSAFE_PATH' }); mock.mockRestore();
  }
  await approveRestoredProjects(profile, receiptHash);
  await chmod(path.join(profile, RESTORED_PROJECT_TRUST_FILE), 0o644);
  await expect(inspectRestoredProjectTrust(profile)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});

it('accepts the actual production restore receipt and requires a fresh explicit project decision', async () => {
  const source = path.join(root, 'source'); await mkdir(source, { mode: 0o700 });
  const store = new CoreStore({ dbPath: path.join(source, 'eve.db') });
  try {
    const backup = path.join(root, 'backup');
    await exportProfileBackup({ profileRoot: source, destination: backup, versions: { app: '0.1.0', schema: store.diagnostics().schemaVersion }, entries: [],
      quiesce: async () => ({ assertHeld: async () => {}, release: async () => {} }),
      backupDatabase: async (destination, signal) => { await store.backupDatabase(destination, { signal }); },
    });
    const restored = path.join(root, 'restored');
    await restoreProfileBackup({ backupDirectory: backup, destination: restored, validateVersions: async () => true, relocate: relocateEveProfile });
    const observed = await inspectRestoredProjectTrust(restored);
    expect(observed).toMatchObject({ restored: true, trusted: false }); expect(observed.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await approveRestoredProjects(restored, observed.receiptHash!)).toEqual({ ...observed, trusted: true });
  } finally { store.close(); }
});
