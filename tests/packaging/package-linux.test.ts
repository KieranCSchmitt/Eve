import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Build tools are executable ES modules; dynamically load without changing the project's TS configuration.
const runtime = await import(new URL('../../scripts/package-runtime.mjs', import.meta.url).href);
const packager = await import(new URL('../../scripts/package-linux.mjs', import.meta.url).href);
const temporary: string[] = [];
async function fixture() { const value = await mkdtemp(path.join(os.tmpdir(), 'eve-package-test-')); temporary.push(value); return value; }
async function file(root: string, relative: string, value: string | Buffer) {
  const filename = path.join(root, relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, value); return filename;
}
function elf(machine = 183) { const value = Buffer.alloc(64); value.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); value.writeUInt16LE(machine, 18); return value; }
function managedDll() {
  const value = Buffer.alloc(1024); value.write('MZ'); value.writeUInt32LE(128, 0x3c); value.write('PE\0\0', 128);
  value.writeUInt16LE(0x14c, 132); value.writeUInt16LE(1, 134); value.writeUInt16LE(224, 148); value.writeUInt16LE(0x2000, 150);
  const optional = 152; value.writeUInt16LE(0x10b, optional); value.writeUInt32LE(16, optional + 92); value.writeUInt32LE(0x2000, optional + 208); value.writeUInt32LE(72, optional + 212);
  const section = optional + 224; value.writeUInt32LE(0x2000, section + 12); value.writeUInt32LE(256, section + 16); value.writeUInt32LE(512, section + 20);
  value.writeUInt32LE(72, 512); value.writeUInt32LE(9, 528); return value;
}
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('target-native release gates', () => {
  it('rejects Mac, x64, musl and old Node independently of binary filenames', () => {
    const candidate = { platform: 'linux', arch: 'arm64', versions: { node: '22.18.0' }, report: { getReport: () => ({ header: { glibcVersionRuntime: '2.39' } }) } };
    expect(() => runtime.requireNativeTarget(candidate)).not.toThrow();
    expect(() => runtime.requireNativeTarget({ ...candidate, platform: 'darwin' })).toThrow(/actual Linux arm64/);
    expect(() => runtime.requireNativeTarget({ ...candidate, arch: 'x64' })).toThrow(/actual Linux arm64/);
    expect(() => runtime.requireNativeTarget({ ...candidate, versions: { node: '22.11.0' } })).toThrow(/Node 22.12/);
    expect(() => runtime.requireNativeTarget({ ...candidate, report: { getReport: () => ({ header: {} }) } })).toThrow(/musl/);
  });
  it('requires actual ELF class, byte order and machine identity', () => {
    expect(() => runtime.assertArm64Elf(elf())).not.toThrow();
    expect(() => runtime.assertArm64Elf(elf(62))).toThrow(/AArch64/);
    const wrongClass = elf(); wrongClass[4] = 1;
    const wrongEndian = elf(); wrongEndian[5] = 2;
    for (const value of [wrongClass, wrongEndian, Buffer.from('#!/bin/sh'), Buffer.from('cffaedfe', 'hex')]) expect(() => runtime.assertArm64Elf(value)).toThrow(/AArch64/);
  });
  it.skipIf(process.platform === 'linux' && process.arch === 'arm64')('refuses the real CLI on this host before creating an output', async () => {
    const directory = await fixture();
    const output = path.join(directory, 'release');
    expect(() => execFileSync(process.execPath, ['scripts/package-linux.mjs', '--output', output, '--code-server-archive', path.join(directory, 'missing.tar.gz')], { cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'pipe' })).toThrow(/actual Linux arm64/);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires explicit absolute inputs, refusing unknown or duplicate options', () => {
    expect(packager.parseArguments(['--output', '/tmp/eve', '--code-server-archive', '/tmp/runtime.tar.gz'])).toEqual({ output: '/tmp/eve', archive: '/tmp/runtime.tar.gz' });
    for (const args of [[], ['--output', 'relative', '--code-server-archive', '/tmp/archive'], ['--output', '/tmp/a', '--output', '/tmp/b'], ['--platform', 'linux']]) expect(() => packager.parseArguments(args)).toThrow();
  });
});

describe('clean, auditable artifact contents', () => {
  it('rejects credentials, dirty profiles, database state and private runtime files', async () => {
    for (const relative of ['.env', '.env.production', 'nested/.npmrc', 'profile/Untitled-1', 'recovery/pending.json', 'workbench.token', 'workbench-owner.json', 'eve.db-wal', 'secret.pem', 'id_ed25519']) expect(() => runtime.assertPublicPath(relative)).toThrow(/package input/);
    const root = await fixture();
    const source = path.join(root, 'source');
    await file(source, 'index.html', '<main>Eve</main>');
    await file(source, '.env', 'PRIVATE_TEST_VALUE');
    await expect(runtime.copyPublicTree(source, path.join(root, 'release'))).rejects.toThrow(/package input/);
  });
  it('copies public files while stripping privileged modes and preserves safe relative links', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); const output = path.join(root, 'release');
    const executable = await file(source, 'eve', elf()); await chmod(executable, 0o4755);
    await file(source, 'resources/data.txt', 'known payload');
    await symlink('data.txt', path.join(source, 'resources/alias.txt'));
    await runtime.copyPublicTree(source, output);
    expect((await lstat(path.join(output, 'eve'))).mode & 0o7777).toBe(0o755);
    expect(await readFile(path.join(output, 'resources/alias.txt'), 'utf8')).toBe('known payload');
    const inventory = await runtime.inventoryTree(output);
    expect(inventory.find((entry: { path: string }) => entry.path === 'resources/data.txt')).toMatchObject({ type: 'file', sha256: createHash('sha256').update('known payload').digest('hex') });
    expect(inventory.find((entry: { path: string }) => entry.path === 'resources/alias.txt')).toMatchObject({ type: 'symlink', target: 'data.txt' });
  });
  it('refuses escaping and absolute symlinks rather than following private files', async () => {
    const root = await fixture(); const source = path.join(root, 'source');
    await mkdir(source); await file(root, 'outside.txt', 'private');
    await symlink('../outside.txt', path.join(source, 'leak'));
    await expect(runtime.copyPublicTree(source, path.join(root, 'release'))).rejects.toThrow(/Unsafe package symlink/);
    await rm(path.join(source, 'leak'));
    await file(source, 'inside.txt', 'public'); await symlink(path.join(source, 'inside.txt'), path.join(source, 'absolute'));
    await expect(runtime.copyPublicTree(source, path.join(root, 'release2'))).rejects.toThrow(/Unsafe package symlink/);
  });
  it('rejects foreign or invalid native addons even inside a nested runtime dependency', async () => {
    for (const contents of [elf(62), Buffer.from('cffaedfe00000000', 'hex'), Buffer.from('not a native object')]) {
      const root = await fixture(); await file(root, 'resources/app/node_modules/native/addon.node', contents);
      await expect(runtime.inventoryTree(root)).rejects.toThrow(/AArch64|Foreign native/);
    }
  });
  it('retains portable PowerShell-style managed DLLs but rejects native and platform-bound PE images', async () => {
    const portable = managedDll(); expect(runtime.isPortableManagedAssembly(portable)).toBe(true);
    const native = managedDll(); native.writeUInt32LE(0, 528);
    const x86Only = managedDll(); x86Only.writeUInt32LE(3, 528);
    const armWindows = managedDll(); armWindows.writeUInt16LE(0xaa64, 132);
    for (const data of [native, x86Only, armWindows, Buffer.from('MZ')]) expect(runtime.isPortableManagedAssembly(data)).toBe(false);
    const root = await fixture(); await file(root, 'portable.dll', portable);
    await expect(runtime.inventoryTree(root)).resolves.toHaveLength(1);
    await file(root, 'native.dll', native);
    await expect(runtime.inventoryTree(root)).rejects.toThrow(/Foreign native/);
  });
  it('collects actual recursive production notices across pnpm-style links', async () => {
    const root = await fixture();
    await file(root, 'package.json', '{"name":"fixture"}');
    const a = path.join(root, 'node_modules/.pnpm/a/node_modules/a');
    const b = path.join(root, 'node_modules/.pnpm/a/node_modules/b');
    await file(a, 'package.json', JSON.stringify({ name: 'a', version: '1.0.0', license: 'MIT', dependencies: { b: '1.0.0' } }));
    await file(a, 'LICENSE', 'License A');
    await file(b, 'package.json', JSON.stringify({ name: 'b', version: '1.0.0', license: 'MIT' }));
    await file(b, 'LICENSE', 'License B');
    await symlink('.pnpm/a/node_modules/a', path.join(root, 'node_modules/a'));
    const notices = await runtime.dependencyNotices(root, ['a'], path.join(root, 'notices'));
    expect(notices.map((notice: { name: string }) => notice.name)).toEqual(['a', 'b']);
    expect(await readFile(path.join(root, 'notices/b@1.0.0/LICENSE'), 'utf8')).toBe('License B');
    await rm(path.join(b, 'LICENSE'));
    await expect(runtime.dependencyNotices(root, ['a'], path.join(root, 'notices2'))).rejects.toThrow(/No license notice/);
  });
});
