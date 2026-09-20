import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// Official v4.138.0 release digests. Update the version and digests together after qualification.
const version = '4.138.0';
const artifacts = {
  'darwin-arm64': { platform: 'macos', digest: '1ecf699868e64bb9094a7d3ffcac50bb903354a32137dfc4017cb9479ef6b456' },
  'linux-arm64': { platform: 'linux', digest: 'fbebf4b18e97a5a48b7b105be0161d411e54ccfb53a1ffb1673c16518024fa30' },
};
const artifact = artifacts[`${process.platform}-${process.arch}`];
if (!artifact) throw new Error('This workbench installer currently qualifies arm64 Mac and Linux only. Supply a separately qualified EVE_CODE_SERVER for another platform.');
const name = `code-server-${version}-${artifact.platform}-arm64`;
const root = path.resolve('.runtime/code-server');
const destination = path.join(root, name);
try {
  await access(path.join(destination, 'bin/code-server'));
  console.log(`Workbench is already present: ${destination}`);
  process.exit(0);
} catch {}
await mkdir(root, { recursive: true });
const temporary = await mkdtemp(path.join(root, '.download-'));
try {
  const response = await fetch(`https://github.com/coder/code-server/releases/download/v${version}/${name}.tar.gz`);
  if (!response.ok || !response.body) throw new Error(`Official workbench download failed (${response.status}).`);
  const archive = path.join(temporary, 'archive.tar.gz');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== artifact.digest) throw new Error('Workbench archive digest did not match the pinned official release. Nothing was installed.');
  await promisify(execFile)('tar', ['-xzf', archive, '-C', temporary]);
  const metadata = JSON.parse(await readFile(path.join(temporary, name, 'package.json'), 'utf8'));
  if (metadata.version !== version) throw new Error('Unexpected workbench version. Nothing was installed.');
  await rename(path.join(temporary, name), destination);
  console.log(`Installed verified code-server ${version} in ${destination}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
