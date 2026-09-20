import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export const CODE_SERVER = Object.freeze({
  version: '4.138.0',
  name: 'code-server-4.138.0-linux-arm64',
  sha256: 'fbebf4b18e97a5a48b7b105be0161d411e54ccfb53a1ffb1673c16518024fa30',
  url: 'https://github.com/coder/code-server/releases/download/v4.138.0/code-server-4.138.0-linux-arm64.tar.gz',
});

export function requireNativeTarget(runtime = process) {
  if (runtime.platform !== 'linux' || runtime.arch !== 'arm64') {
    throw new Error('Packaging requires an actual Linux arm64 host; cross-platform assembly is refused.');
  }
  const [major, minor] = runtime.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node 22.12 or newer is required.');
  if (!runtime.report.getReport().header.glibcVersionRuntime) throw new Error('The pinned runtime requires glibc Linux; musl is unsupported.');
}

export function assertArm64Elf(header, label = 'binary') {
  if (header.length < 64 || header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 183) {
    throw new Error(`${label} must be a 64-bit little-endian AArch64 ELF binary.`);
  }
}

export async function readHeader(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function verifyArm64Elf(file) { assertArm64Elf(await readHeader(file), path.basename(file)); }

/** AnyCPU IL-only .NET DLLs are portable data for a CLR, not Windows native executables. */
export function isPortableManagedAssembly(bytes) {
  if (bytes.length < 64 || bytes.subarray(0, 2).toString() !== 'MZ') return false;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe > bytes.length - 24 || bytes.subarray(pe, pe + 4).toString('hex') !== '50450000') return false;
  // AnyCPU assemblies use the PE32/i386 container; IL-only flags below distinguish
  // them from native x86 and mixed-mode DLLs. Do not accept platform-specific CLR images.
  if (bytes.readUInt16LE(pe + 4) !== 0x14c || !(bytes.readUInt16LE(pe + 22) & 0x2000)) return false;
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  if (optionalSize < 216 || optional + optionalSize > bytes.length || bytes.readUInt16LE(optional) !== 0x10b || bytes.readUInt32LE(optional + 92) < 15) return false;
  const cliRva = bytes.readUInt32LE(optional + 208);
  const cliSize = bytes.readUInt32LE(optional + 212);
  if (!cliRva || cliSize < 72) return false;
  const sections = bytes.readUInt16LE(pe + 6);
  for (let index = 0; index < sections; index++) {
    const section = optional + optionalSize + index * 40;
    if (section > bytes.length - 40) return false;
    const virtualAddress = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16);
    const raw = bytes.readUInt32LE(section + 20);
    if (cliRva < virtualAddress || cliRva - virtualAddress > rawSize - 72) continue;
    const cli = raw + cliRva - virtualAddress;
    if (cli > bytes.length - 72 || bytes.readUInt32LE(cli) < 72) return false;
    const flags = bytes.readUInt32LE(cli + 16);
    return !!(flags & 1) && !(flags & (2 | 0x10)); // ILONLY, no 32BITREQUIRED or native entry point.
  }
  return false;
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// This policy applies to every selected input, including a trusted upstream archive.
// Private profiles are never selected; these checks also catch accidental contamination.
export function assertPublicPath(relative) {
  const segments = relative.split(/[\\/]/);
  const privateNames = /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.pnpmrc|\.yarnrc(?:\.yml)?|\.DS_Store|__pycache__|user-data|userData|profiles?|recovery|workbench\.lock|workbench-owner\.json|workbench\.token|code-server\.yaml|id_(?:rsa|ed25519)|credentials(?:\.json)?|secrets?(?:\.json)?)$/i;
  if (segments.some((part) => privateNames.test(part)) || /\.(?:db(?:-shm|-wal)?|sqlite(?:3)?|pem|p12|key|log|pyc)$/i.test(relative)) {
    throw new Error(`Private or generated state is not a package input: ${relative}`);
  }
}

/** Copy selected public trees without following links outside that input tree. */
export async function copyPublicTree(source, destination, { exclude = () => false } = {}) {
  const base = await realpath(source);
  async function copy(from, to, relative) {
    if (exclude(relative)) return;
    assertPublicPath(relative);
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) {
      const link = await readlink(from);
      // Absolute links make a release machine-dependent even if they resolve locally.
      if (path.isAbsolute(link) || !inside(base, await realpath(from))) throw new Error(`Unsafe package symlink: ${relative}`);
      await mkdir(path.dirname(to), { recursive: true });
      await symlink(link, to);
    } else if (stat.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o755 });
      for (const name of (await readdir(from)).sort()) await copy(path.join(from, name), path.join(to, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      // Never copy setuid/setgid bits from a developer's Electron install.
      await chmod(to, stat.mode & 0o111 ? 0o755 : 0o644);
    } else throw new Error(`Unsupported package file type: ${relative}`);
  }
  await copy(base, destination, '');
}

export async function resolvePackage(name, from) {
  const require = createRequire(path.join(await realpath(from), 'package.json'));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    try { await access(path.join(candidate, 'package.json')); return await realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  throw new Error(`Required installed dependency is missing: ${name}`);
}

/** Installed production dependency graph, used for bundled JS/font license notices. */
export async function dependencyNotices(root, names, destination) {
  const found = new Map();
  async function visit(name, from) {
    const directory = await resolvePackage(name, from);
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const key = `${metadata.name}@${metadata.version}`;
    if (found.has(key)) return;
    const files = [];
    for (const filename of (await readdir(directory)).sort()) {
      if (/^(?:licen[sc]e|copying|notice|ofl|thirdparty)/i.test(filename) && (await lstat(path.join(directory, filename))).isFile()) files.push(filename);
    }
    if (files.length === 0) throw new Error(`No license notice found for bundled dependency ${key}; review it before packaging.`);
    const noticeDirectory = path.join(destination, key.replaceAll('/', '__'));
    await mkdir(noticeDirectory, { recursive: true });
    for (const filename of files) await copyPublicTree(path.join(directory, filename), path.join(noticeDirectory, filename));
    found.set(key, { name: metadata.name, version: metadata.version, license: metadata.license ?? 'SEE INCLUDED NOTICE', notices: files });
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) await visit(dependency, directory);
  }
  for (const name of [...names].sort()) await visit(name, root);
  return [...found.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

/** Every distributed byte is hashed; foreign native objects are rejected, not hidden. */
export async function inventoryTree(root) {
  root = await realpath(root);
  const records = [];
  const binaryFormats = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      assertPublicPath(relative);
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await readlink(file);
        if (path.isAbsolute(target) || !inside(root, await realpath(file))) throw new Error(`Package link escapes artifact: ${relative}`);
        records.push({ path: relative, type: 'symlink', target, sha256: createHash('sha256').update(target).digest('hex') });
      } else if (stat.isDirectory()) await walk(file, relative);
      else if (stat.isFile()) {
        const header = await readHeader(file);
        const magic = header.subarray(0, 4).toString('hex');
        if (magic === '7f454c46') assertArm64Elf(header, relative);
        else if (binaryFormats.has(magic)) throw new Error(`Foreign native binary in Linux artifact: ${relative}`);
        else if (header.length >= 64 && header.subarray(0, 2).toString() === 'MZ') {
          if (!relative.endsWith('.dll') || stat.size > 16 * 1024 * 1024 || !isPortableManagedAssembly(await readFile(file))) throw new Error(`Foreign native binary in Linux artifact: ${relative}`);
        }
        else if (/\.node$/i.test(relative)) throw new Error(`Native addon is not AArch64 ELF: ${relative}`);
        records.push({ path: relative, type: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: await sha256(file) });
      } else throw new Error(`Unsupported package entry: ${relative}`);
    }
  }
  await walk(root);
  return records;
}
