import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetRegistrationSchema } from '../../packages/contracts/src/index';
import { ASSET_LIMITS, ImportError, ManagedImporter, ORBIT_STARTER_FILES, registerProjectFolder } from '../../packages/imports/src/index';
import { DEFAULT_ORBIT_CONFIG } from '../../adapters/orbit/src/index';

let root: string;
let storage: string;
let importer: ManagedImporter;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-import-test-')));
  storage = path.join(root, 'managed');
  importer = await ManagedImporter.open({ managedRoot: storage });
});
afterEach(async () => { await chmod(path.join(storage, 'assets'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
async function fixture(name: string, content: string | Buffer) { const file = path.join(root, name); await writeFile(file, content); return file; }
async function starter(): Promise<string> {
  const directory = path.join(root, 'starter'); await mkdir(path.join(directory, 'src'), { recursive: true });
  for (const relative of ORBIT_STARTER_FILES) await writeFile(path.join(directory, relative), relative === 'eve.project.json' ? JSON.stringify(DEFAULT_ORBIT_CONFIG) : `/* ${relative} */`);
  return directory;
}
async function assertEmptyAssets() { expect(await readdir(path.join(storage, 'assets'))).toEqual([]); }

describe('managed originals', () => {
  it('copies exact Markdown bytes durably with hash, private permissions and a recovery manifest', async () => {
    const bytes = Buffer.from('\ufeff# Original\r\nCafé 😀\r\n');
    const original = await fixture('Notes.markdown', bytes);
    const record = await importer.importAsset({ taskId: 'task-1', sourcePath: original });
    expect(assetRegistrationSchema.parse(record)).toEqual(record);
    expect(record.mediaType).toBe('text/markdown');
    expect(record.originalPath).toBe(original);
    expect(record.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(record.byteLength).toBe(bytes.length);
    expect(await readFile(record.managedPath)).toEqual(bytes);
    expect(await readFile(original)).toEqual(bytes);
    expect((await lstat(record.managedPath)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(path.join(path.dirname(record.managedPath), 'manifest.json'), 'utf8'));
    expect(manifest.registration).toEqual(record);
    await writeFile(original, 'changed externally');
    expect(await readFile(record.managedPath)).toEqual(bytes);
  });

  it('keeps concurrent imports independent and publishes complete originals', async () => {
    const original = await fixture('same.txt', 'copied concurrently');
    const records = await Promise.all(Array.from({ length: 8 }, () => importer.importAsset({ taskId: 't', sourcePath: original })));
    expect(new Set(records.map(r => r.id)).size).toBe(8);
    expect(new Set(records.map(r => r.sha256)).size).toBe(1);
    for (const record of records) expect(await readFile(record.managedPath, 'utf8')).toBe('copied concurrently');
    expect((await readdir(path.join(storage, 'assets'))).some(name => name.startsWith('.staging-'))).toBe(false);
  });

  it('rejects parent traversal, source symlinks and symlinked ancestors', async () => {
    const original = await fixture('a.txt', 'safe');
    await expect(importer.importAsset({ taskId: 't', sourcePath: `${root}/unused/../a.txt` })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    const link = path.join(root, 'link.txt'); await symlink(original, link);
    await expect(importer.importAsset({ taskId: 't', sourcePath: link })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    const directory = path.join(root, 'real'); await mkdir(directory); await writeFile(path.join(directory, 'a.txt'), 'safe');
    await symlink(directory, path.join(root, 'linked-directory'));
    await expect(importer.importAsset({ taskId: 't', sourcePath: path.join(root, 'linked-directory', 'a.txt') })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await assertEmptyAssets();
  });

  it('refuses replaced managed directories rather than following them outside storage', async () => {
    const original = await fixture('a.txt', 'safe'); const outside = path.join(root, 'outside'); await mkdir(outside);
    await rm(path.join(storage, 'assets'), { recursive: true }); await symlink(outside, path.join(storage, 'assets'));
    await expect(importer.importAsset({ taskId: 't', sourcePath: original })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('requires private managed storage and rejects missing parents without creating arbitrary trees', async () => {
    const publicDirectory = path.join(root, 'public'); await mkdir(publicDirectory, { mode: 0o755 });
    await expect(ManagedImporter.open({ managedRoot: publicDirectory })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(ManagedImporter.open({ managedRoot: path.join(root, 'absent', 'nested') })).rejects.toBeInstanceOf(ImportError);
    await expect(lstat(path.join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds bytes, requires UTF-8, and rejects active or mislabeled content types', async () => {
    const tooLarge = await fixture('large.txt', Buffer.alloc(ASSET_LIMITS.textBytes + 1, 65));
    await expect(importer.importAsset({ taskId: 't', sourcePath: tooLarge })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    for (const [name, content] of [['binary.txt', Buffer.from([0, 1, 2])], ['invalid.md', Buffer.from([0xc3, 0x28])], ['x.svg', '<svg/>'], ['x.html', '<script/>'], ['fake.png', '<svg/>']] as const) {
      const file = await fixture(name, content);
      await expect(importer.importAsset({ taskId: 't', sourcePath: file })).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    }
    await assertEmptyAssets();
  });

  it('accepts a real PNG and bounds raster dimensions before publication', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
    const original = await fixture('pixel.png', png);
    const record = await importer.importAsset({ taskId: 't', sourcePath: original });
    expect(record.mediaType).toBe('image/png'); expect(await readFile(record.managedPath)).toEqual(png);
    const huge = Buffer.from(png); huge.writeUInt32BE(100_000, 16);
    await expect(importer.importAsset({ taskId: 't', sourcePath: await fixture('huge.png', huge) })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect((await readdir(path.join(storage, 'assets'))).length).toBe(1);
  });

  it('cancels before publication and removes its partial stage without touching the original', async () => {
    const original = await fixture('cancel.txt', Buffer.alloc(ASSET_LIMITS.textBytes, 65));
    const controller = new AbortController(); controller.abort();
    await expect(importer.importAsset({ taskId: 't', sourcePath: original, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const during = new AbortController();
    const operation = importer.importAsset({ taskId: 't', sourcePath: original, signal: during.signal });
    void operation.catch(() => {});
    // Poll only our stage: abort after copying has started, before publication.
    const deadline = Date.now() + 2000;
    let stageSeen = false;
    while (!(stageSeen = (await readdir(path.join(storage, 'assets'))).some(name => name.startsWith('.staging-'))) && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    during.abort();
    expect(stageSeen).toBe(true);
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await lstat(original)).size).toBe(ASSET_LIMITS.textBytes);
    await assertEmptyAssets();
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('preserves originals and reports an actual unwritable destination', async () => {
    const original = await fixture('a.txt', 'original'); await chmod(path.join(storage, 'assets'), 0o500);
    await expect(importer.importAsset({ taskId: 't', sourcePath: original })).rejects.toMatchObject({ code: 'IO_ERROR' });
    expect(await readFile(original, 'utf8')).toBe('original');
    await assertEmptyAssets();
  });
});

describe('projects are references or explicit starter copies', () => {
  it('registers an external folder and detects only the known adapter without executing scripts', async () => {
    const directory = await starter();
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { prepare: `touch ${root}/executed` } }));
    const result = await registerProjectFolder({ sourcePath: directory });
    expect(result).toMatchObject({ projectPath: directory, originPath: directory, mode: 'external-folder', trusted: false, adapter: { id: 'eve.orbit', status: 'requires-review' } });
    await expect(lstat(path.join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(storage, 'projects'))).toEqual([]);
  });

  it('keeps unsupported or malformed adapter declarations as generic projects', async () => {
    const directory = await starter(); await writeFile(path.join(directory, 'eve.project.json'), '{"adapter":"run arbitrary code"}');
    const result = await registerProjectFolder({ sourcePath: directory });
    expect(result.adapter).toBeNull(); expect(result.adapterIssue).toBeTruthy(); expect(result.trusted).toBe(false);
  });

  it.each(['linked', 'oversized', 'directory'] as const)('keeps a %s adapter declaration inert while allowing generic folder selection', async (kind) => {
    const directory = await starter(), file = path.join(directory, 'eve.project.json');
    await rm(file);
    const original = JSON.stringify(DEFAULT_ORBIT_CONFIG);
    const outside = await fixture('outside-config.json', original);
    if (kind === 'linked') await symlink(outside, file);
    else if (kind === 'directory') await mkdir(file);
    else await writeFile(file, ' '.repeat(64 * 1024 + 1));
    const before = await lstat(file);
    const result = await registerProjectFolder({ sourcePath: directory });
    expect(result).toMatchObject({ projectPath: directory, trusted: false, adapter: null });
    expect(result.adapterIssue).toContain('could not read this project’s settings');
    expect((await lstat(file)).ino).toBe(before.ino);
    expect(await readFile(outside, 'utf8')).toBe(original);
    await expect(importer.copyStarter({ starterId: 'eve.orbit', starterPath: directory })).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    expect(await readdir(path.join(storage, 'projects'))).toEqual([]);
  });

  it('copies only the explicit reviewed starter files and records independent original hashes', async () => {
    const directory = await starter(); await writeFile(path.join(directory, '.env'), 'DO_NOT_COPY'); await writeFile(path.join(directory, 'unlisted.js'), 'doNotRun()');
    const result = await importer.copyStarter({ starterId: 'eve.orbit', starterPath: directory, title: 'My Orbit' });
    expect(result).toMatchObject({ mode: 'copied-starter', originPath: directory, trusted: false, title: 'My Orbit', adapter: { id: 'eve.orbit' } });
    expect(result.projectPath.startsWith(`${storage}/projects/`)).toBe(true);
    const manifest = JSON.parse(await readFile(result.manifestPath!, 'utf8'));
    expect(manifest.files.map((file: { relativePath: string }) => file.relativePath)).toEqual(ORBIT_STARTER_FILES);
    for (const file of manifest.files) expect(createHash('sha256').update(await readFile(path.join(result.projectPath, file.relativePath))).digest('hex')).toBe(file.sha256);
    await expect(lstat(path.join(result.projectPath, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(result.projectPath, 'unlisted.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(result.projectPath, 'src/app.mjs'), 'changed copy');
    expect(await readFile(path.join(directory, 'src/app.mjs'), 'utf8')).toBe('/* src/app.mjs */');
  });

  it('rejects a symlink hidden in starter content and removes the incomplete copy', async () => {
    const directory = await starter(); const source = path.join(directory, 'src/app.mjs'); await rm(source); await symlink(await fixture('outside.txt', 'not a starter'), source);
    await expect(importer.copyStarter({ starterId: 'eve.orbit', starterPath: directory })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(path.join(storage, 'projects'))).toEqual([]);
  });
});
