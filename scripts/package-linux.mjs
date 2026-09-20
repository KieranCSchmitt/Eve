#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CODE_SERVER, copyPublicTree, dependencyNotices, inside, inventoryTree,
  requireNativeTarget, resolvePackage, sha256, verifyArm64Elf,
} from './package-runtime.mjs';

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostEntries = ['main', 'preload', 'overlay-preload', 'core', 'model'];
const orbitFiles = ['index.html', 'server.mjs', 'eve.project.json', 'package.json', 'src/app.mjs', 'src/styles.css', 'src/timer.mjs'];
const extensionFiles = ['package.json', 'dist/extension.cjs', 'themes/eve-light.json', 'scripts/supervisor.py'];
export const codeServerOmissions = [
  'lib/vscode/extensions/css-language-features/server/.npmrc',
  'lib/vscode/extensions/html-language-features/server/.npmrc',
  'lib/vscode/extensions/json-language-features/server/.npmrc',
  'node_modules/httpolyglot/test',
  'lib/vscode/extensions/copilot/node_modules/@github/copilot/sdk/ripgrep/bin/linux-x64',
  'lib/vscode/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.win32-arm64-msvc-4ZJZ3U55.node',
  'lib/vscode/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.win32-x64-msvc-VCQE7GJP.node',
  'lib/vscode/node_modules/@github/copilot-linux-arm64/ripgrep/bin/linux-x64',
  'lib/vscode/node_modules/@github/copilot-linux-arm64/tgrep/bin/linux-x64',
  'lib/vscode/node_modules/@vscode/sandbox-runtime/vendor/seccomp/x64',
  ...['mxc-diagnostic-console.exe', 'mxc-exec-mac', 'plm.exe', 'unix-test-proxy', 'winhttp-proxy-shim.exe', 'wslcsdk.dll', 'wxc-exec.exe', 'wxc-host-prep.exe', 'wxc-test-proxy.exe', 'wxc-windows-sandbox-daemon.exe', 'wxc-windows-sandbox-guest.exe', 'wxc-wslc-daemon.exe']
    .map((name) => `lib/vscode/node_modules/@microsoft/mxc-sdk/bin/arm64/${name}`),
];

export function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--output', '--code-server-archive'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--') || parsed[key]) throw new Error('Usage: node scripts/package-linux.mjs --output /absolute/new/app-dir --code-server-archive /absolute/code-server-4.138.0-linux-arm64.tar.gz');
    parsed[key] = args[++index];
  }
  if (!parsed['--output'] || !parsed['--code-server-archive']) throw new Error('Both --output and --code-server-archive are required.');
  for (const value of Object.values(parsed)) if (!path.isAbsolute(value)) throw new Error('Use absolute paths for package output and the runtime archive.');
  return { output: path.resolve(parsed['--output']), archive: path.resolve(parsed['--code-server-archive']) };
}

async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function requiredFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing, empty or non-regular package input: ${path.basename(file)}`);
}
async function doesExist(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function copyFiles(root, target, files) {
  for (const file of files) {
    await requiredFile(path.join(root, file));
    await copyPublicTree(path.join(root, file), path.join(target, file));
  }
}

export async function packageLinux({ output, archive }) {
  requireNativeTarget();
  await verifyArm64Elf(process.execPath);
  if (!path.isAbsolute(output) || !path.isAbsolute(archive)) throw new Error('Package paths must be absolute.');
  if (inside(output, repository) || inside(output, archive)) throw new Error('Output must not contain the repository or its input archive.');
  if (await doesExist(output)) throw new Error('Output already exists. Choose a new directory; existing releases are never overwritten.');
  if (inside(path.join(repository, 'node_modules'), output) || inside(path.join(repository, 'dist'), output)) throw new Error('Output cannot be placed inside package inputs.');
  await requiredFile(archive);
  if (await sha256(archive) !== CODE_SERVER.sha256) throw new Error('code-server archive does not match the pinned official Linux arm64 SHA-256.');

  const project = await json(path.join(repository, 'package.json'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(project.version)) throw new Error('Package version must be a plain semantic version.');
  const electronDirectory = await resolvePackage('electron', repository);
  const electron = await json(path.join(electronDirectory, 'package.json'));
  if (electron.version !== project.devDependencies.electron) throw new Error('Installed Electron does not match the exact root pin.');
  const electronDist = path.join(electronDirectory, 'dist');
  await verifyArm64Elf(path.join(electronDist, 'electron'));
  await access(path.join(electronDist, 'electron'), constants.X_OK);
  if ((await readFile(path.join(electronDist, 'version'), 'utf8')).trim() !== electron.version) throw new Error('Electron distribution version differs from its installed package.');
  for (const filename of ['LICENSE', 'LICENSES.chromium.html', 'resources/default_app.asar']) await requiredFile(path.join(electronDist, filename));
  if ((await readdir(path.join(electronDist, 'resources'))).some((name) => name !== 'default_app.asar')) throw new Error('Electron resources contain unexpected application data; use a fresh pinned installation.');

  const sqliteDirectory = await resolvePackage('better-sqlite3', repository);
  const sqlite = await json(path.join(sqliteDirectory, 'package.json'));
  // Its audited v13 loader uses only Node built-ins and the chosen native addon.
  // node-addon-api is build-time headers, not a runtime JS dependency.
  if (sqlite.version !== '13.0.3' || sqlite.version !== project.dependencies['better-sqlite3']) throw new Error('SQLite runtime layout must be reviewed when its exact pin changes.');
  let binding;
  for (const candidate of ['prebuilds/linux-arm64.node', 'build/Debug/better_sqlite3.node', 'build/Release/better_sqlite3.node']) {
    if (await doesExist(path.join(sqliteDirectory, candidate))) { binding = candidate; break; }
  }
  if (!binding) throw new Error('No Linux SQLite addon is available; rebuild it with the pinned Electron on this host.');
  await verifyArm64Elf(path.join(sqliteDirectory, binding));
  for (const entry of hostEntries) await requiredFile(path.join(repository, 'dist/host', `${entry}.cjs`));
  const expectedHostFiles = new Set(hostEntries.flatMap((entry) => [`${entry}.cjs`, `${entry}.cjs.map`]));
  if ((await readdir(path.join(repository, 'dist/host'))).some((name) => !expectedHostFiles.has(name))) throw new Error('Unexpected host build output; clean and rebuild dist/host before packaging.');
  await requiredFile(path.join(repository, 'dist/renderer/index.html'));

  await mkdir(path.dirname(output), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(output), '.eve-package-'));
  const staged = path.join(temporary, 'app');
  try {
    await copyPublicTree(electronDist, staged, { exclude: (name) => name === 'resources/default_app.asar' });
    await rename(path.join(staged, 'electron'), path.join(staged, 'eve'));
    await chmod(path.join(staged, 'eve'), 0o755);
    const app = path.join(staged, 'resources/app');
    await mkdir(app, { recursive: true });
    await writeFile(path.join(app, 'package.json'), `${JSON.stringify({ name: project.name, productName: 'Eve', version: project.version, private: true, license: 'UNLICENSED', type: 'module', main: 'dist/host/main.cjs', dependencies: { 'better-sqlite3': sqlite.version } }, null, 2)}\n`);
    await copyPublicTree(path.join(repository, 'dist/host'), path.join(app, 'dist/host'));
    await copyPublicTree(path.join(repository, 'dist/renderer'), path.join(app, 'dist/renderer'));
    await copyFiles(path.join(repository, 'examples/orbit'), path.join(app, 'examples/orbit'), orbitFiles);
    await copyFiles(path.join(repository, 'extensions/eve-workbench'), path.join(app, 'extensions/eve-workbench'), extensionFiles);
    await copyFiles(repository, app, ['apps/desktop/renderer/public/assets/photo-walk.png', 'docs/CREDITS.md', 'packages/platform/scripts/session-bridge.py']);
    const nativeModule = path.join(app, 'node_modules/better-sqlite3');
    await copyPublicTree(path.join(sqliteDirectory, 'lib'), path.join(nativeModule, 'lib'));
    await copyFiles(sqliteDirectory, nativeModule, ['package.json', 'LICENSE']);
    // Preserve the loader's default glibc path; foreign prebuilds and build caches never enter the release.
    await copyPublicTree(path.join(sqliteDirectory, binding), path.join(nativeModule, 'prebuilds/linux-arm64.node'));
    const notices = await dependencyNotices(repository, Object.keys(project.dependencies), path.join(app, 'licenses/npm'));
    await copyFiles(electronDirectory, path.join(app, 'licenses/electron-package'), ['LICENSE', 'checksums.json']);

    const unpacked = path.join(temporary, 'workbench');
    await mkdir(unpacked);
    // The pinned cryptographic digest above authenticates this entire upstream archive.
    await execute('tar', ['-xzf', archive, '-C', unpacked], { timeout: 180_000, maxBuffer: 1024 * 1024 });
    const codeServerDirectory = path.join(unpacked, CODE_SERVER.name);
    const codeServerPackage = await json(path.join(codeServerDirectory, 'package.json'));
    if (codeServerPackage.version !== CODE_SERVER.version) throw new Error('Pinned runtime metadata version mismatch.');
    await verifyArm64Elf(path.join(codeServerDirectory, 'lib/node'));
    await access(path.join(codeServerDirectory, 'bin/code-server'), constants.X_OK);
    for (const notice of ['LICENSE', 'ThirdPartyNotices.txt']) await requiredFile(path.join(codeServerDirectory, notice));
    await copyPublicTree(codeServerDirectory, path.join(app, '.runtime/code-server', CODE_SERVER.name), {
      exclude: (name) => codeServerOmissions.some((omission) => name === omission || name.startsWith(`${omission}/`)),
    });

    // Exercise the actual distributed Electron and addon together, without starting the GUI,
    // application, services, a database on disk, or any account settings.
    const probeHome = path.join(temporary, 'probe-home');
    await mkdir(probeHome, { mode: 0o700 });
    const probe = `
      const Database = require(process.argv[1]);
      const db = new Database(':memory:');
      db.exec('CREATE VIRTUAL TABLE proof USING fts5(value)');
      db.prepare('INSERT INTO proof VALUES (?)').run('eve native check');
      if (db.prepare('SELECT value FROM proof WHERE proof MATCH ?').get('native').value !== 'eve native check') throw Error('SQLite FTS5 probe failed');
      const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
      db.close();
      process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,sqlite,fts5:true}));
    `;
    const { stdout } = await execute(path.join(staged, 'eve'), ['-e', probe, nativeModule], {
      env: { PATH: '/usr/bin:/bin', HOME: probeHome, LANG: 'C.UTF-8', ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const nativeProbe = JSON.parse(stdout);
    if (nativeProbe.platform !== 'linux' || nativeProbe.arch !== 'arm64' || nativeProbe.electron !== electron.version) throw new Error('Distributed Electron native probe returned an unexpected target.');
    const { stdout: codeNodeVersion } = await execute(path.join(app, '.runtime/code-server', CODE_SERVER.name, 'lib/node'), ['--version'], {
      env: { PATH: '/usr/bin:/bin', HOME: probeHome, LANG: 'C.UTF-8' }, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    if (!/^v\d+\.\d+\.\d+\s*$/.test(codeNodeVersion)) throw new Error('Pinned workbench Node did not execute on this target.');
    const lockfileHash = await sha256(path.join(repository, 'pnpm-lock.yaml'));
    const electronChecksums = await json(path.join(electronDirectory, 'checksums.json'));
    const electronArchive = `electron-v${electron.version}-linux-arm64.zip`;
    if (!/^[a-f0-9]{64}$/.test(electronChecksums[electronArchive] ?? '')) throw new Error('Installed Electron package has no pinned Linux arm64 archive checksum.');
    const manifest = {
      schemaVersion: 1, product: 'Eve', version: project.version, target: 'linux-arm64-glibc',
      createdAt: new Date().toISOString(), hardwareQualified: false,
      qualification: 'Target-native binary and SQLite load checks only. GX10 desktop, GNOME session, graphics, sandbox, focus, audio and recovery acceptance remain required.',
      build: { node: process.versions.node, glibc: process.report.getReport().header.glibcVersionRuntime, lockfileSha256: lockfileHash },
      electron: { version: electron.version, source: 'installed pinned Electron distribution', archive: electronArchive, upstreamExpectedArchiveSha256: electronChecksums[electronArchive], archiveReverified: false },
      sqlite: { version: sqlite.version, inputBinding: binding, packagedBinding: 'resources/app/node_modules/better-sqlite3/prebuilds/linux-arm64.node', nativeProbe },
      codeServer: { ...CODE_SERVER, archiveVerified: true, node: codeNodeVersion.trim(), omittedUpstreamDevelopmentAndForeignFiles: codeServerOmissions },
      licenses: { project: 'UNLICENSED; no public distribution license has been granted', npm: notices, electron: 'LICENSE and LICENSES.chromium.html', workbench: 'resources/app/.runtime/code-server/' + CODE_SERVER.name + '/ThirdPartyNotices.txt', assets: 'resources/app/docs/CREDITS.md' },
      manifestCoverage: 'All files and symlinks except package-manifest.json and its detached checksum; file modes recorded. Directory mtimes are not part of content identity.',
      files: await inventoryTree(staged),
    };
    const manifestPath = path.join(staged, 'package-manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(staged, 'package-manifest.sha256'), `${await sha256(manifestPath)}  package-manifest.json\n`);
    // Never replace a release, including one that appeared while inputs were checked.
    // Reserve the final name exclusively; rename replaces only our empty reservation.
    await mkdir(output, { mode: 0o755 });
    await rename(staged, output);
    return { output, version: project.version, files: manifest.files.length, hardwareQualified: false };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageLinux(parseArguments(process.argv.slice(2)));
    console.log(`Built Eve ${result.version}: ${result.output}\n${result.files} hashed entries. GX10/session qualification remains outstanding.`);
  } catch (error) {
    console.error(`Package refused: ${error.message}`);
    process.exitCode = 1;
  }
}
