import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export type ImportErrorCode = 'INVALID_INPUT' | 'UNSAFE_PATH' | 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'SOURCE_CHANGED' | 'CANCELLED' | 'IO_ERROR' | 'DURABILITY_UNCERTAIN';
export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode, message: string, readonly retainedPath?: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ImportError';
  }
}

export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ImportError('CANCELLED', 'Import cancelled. The original was not changed.');
}

export function checkedAbsolute(input: string): string {
  if (!path.isAbsolute(input) || input.includes('\0') || input.split(/[\\/]/).includes('..')) throw new ImportError('UNSAFE_PATH', 'Choose an absolute path without parent traversal.');
  return path.normalize(input);
}

/** No path component may be a symlink, including the selected file itself. */
export async function inspectPath(input: string): Promise<{ path: string; stat: Stats; chain: { path: string; dev: number; ino: number }[] }> {
  const absolute = checkedAbsolute(input);
  const root = path.parse(absolute).root;
  let current = root;
  const chain: { path: string; dev: number; ino: number }[] = [];
  let found = await lstat(root);
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    found = await lstat(current);
    if (found.isSymbolicLink()) throw new ImportError('UNSAFE_PATH', 'Symbolic links are not imported. Choose the original file or folder.');
    chain.push({ path: current, dev: found.dev, ino: found.ino });
  }
  if (await realpath(absolute) !== absolute) throw new ImportError('UNSAFE_PATH', 'The selected path is not canonical.');
  return { path: absolute, stat: found, chain };
}

export async function verifyChain(chain: { path: string; dev: number; ino: number }[]) {
  for (const entry of chain) {
    const current = await lstat(entry.path);
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino) throw new ImportError('SOURCE_CHANGED', 'A path changed during import. Choose it again.');
  }
}

export async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeDurable(file: string, text: string) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

export async function copyChecked(options: {
  source: string; destination: string; maxBytes: number; signal?: AbortSignal;
  text?: boolean; validateHeader?: (header: Buffer, size: number) => void;
}): Promise<{ sha256: string; byteLength: number; sourcePath: string }> {
  checkCancelled(options.signal);
  const inspected = await inspectPath(options.source);
  if (!inspected.stat.isFile()) throw new ImportError('UNSUPPORTED_TYPE', 'Only regular files can be copied.');
  if (inspected.stat.size > options.maxBytes) throw new ImportError('TOO_LARGE', 'The file exceeds this import limit.');
  const source = await open(inspected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await source.stat();
    if (before.dev !== inspected.stat.dev || before.ino !== inspected.stat.ino || !before.isFile()) throw new ImportError('SOURCE_CHANGED', 'The selected file changed before it could be copied.');
    destination = await open(options.destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    const decoder = options.text ? new TextDecoder('utf-8', { fatal: true }) : undefined;
    const headerParts: Buffer[] = [];
    let headerSize = 0;
    let size = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const checkText = (text: string) => {
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new ImportError('UNSUPPORTED_TYPE', 'Text imports must contain UTF-8 text without binary control characters.');
    };
    while (true) {
      checkCancelled(options.signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > options.maxBytes) throw new ImportError('TOO_LARGE', 'The file grew beyond this import limit.');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (decoder) {
        try { checkText(decoder.decode(chunk, { stream: true })); }
        catch (error) { if (error instanceof ImportError) throw error; throw new ImportError('UNSUPPORTED_TYPE', 'Text imports must use valid UTF-8.', undefined, { cause: error }); }
      }
      if (headerSize < 1024 * 1024) {
        const part = Buffer.from(chunk.subarray(0, 1024 * 1024 - headerSize)); headerParts.push(part); headerSize += part.length;
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(chunk, written, bytesRead - written, null);
        if (!result.bytesWritten) throw new ImportError('IO_ERROR', 'The destination stopped accepting data.');
        written += result.bytesWritten;
      }
    }
    if (decoder) {
      try { checkText(decoder.decode()); } catch (error) { if (error instanceof ImportError) throw error; throw new ImportError('UNSUPPORTED_TYPE', 'Text imports must use valid UTF-8.', undefined, { cause: error }); }
    }
    options.validateHeader?.(Buffer.concat(headerParts), size);
    const after = await source.stat();
    if (before.size !== after.size || size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ImportError('SOURCE_CHANGED', 'The original changed while it was being copied. Retry from its current version.');
    await verifyChain(inspected.chain);
    checkCancelled(options.signal);
    await destination.sync();
    return { sha256: hash.digest('hex'), byteLength: size, sourcePath: inspected.path };
  } finally {
    await Promise.allSettled([source.close(), ...(destination ? [destination.close()] : [])]);
  }
}

export async function readChecked(file: string, maxBytes: number): Promise<Buffer> {
  const inspected = await inspectPath(file);
  if (!inspected.stat.isFile()) throw new ImportError('UNSUPPORTED_TYPE', 'The selected path is not a regular file.');
  if (inspected.stat.size > maxBytes) throw new ImportError('TOO_LARGE', 'The file exceeds this read limit.');
  const handle = await open(inspected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.dev !== inspected.stat.dev || before.ino !== inspected.stat.ino) throw new ImportError('SOURCE_CHANGED', 'The file changed before inspection.');
    // Read at most the bound plus one byte, even if another process grows the file.
    const bytes = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > maxBytes || after.size > maxBytes) throw new ImportError('TOO_LARGE', 'The file exceeds this read limit.');
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ImportError('SOURCE_CHANGED', 'The file changed during inspection.');
    await verifyChain(inspected.chain);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
