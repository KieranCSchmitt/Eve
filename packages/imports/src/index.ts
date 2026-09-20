import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { assetRegistrationSchema, idSchema, type AssetRegistration } from '../../contracts/src/index';
import { parseOrbitConfig, type OrbitConfig } from '../../../adapters/orbit/src/index';
import { ASSET_LIMITS, ASSET_TYPES, validateImage } from './media-types';
import { checkCancelled, checkedAbsolute, copyChecked, ImportError, inspectPath, readChecked, syncDirectory, verifyChain, writeDurable } from './filesystem';

export { ImportError } from './filesystem';
export type { ImportErrorCode } from './filesystem';
export { ASSET_LIMITS, ASSET_TYPES } from './media-types';
export { normalizeWebSource, normalizeVideoSource } from './sources';

export const ORBIT_STARTER_FILES = Object.freeze(['eve.project.json', 'index.html', 'package.json', 'server.mjs', 'src/app.mjs', 'src/styles.css', 'src/timer.mjs']);
export const STARTER_LIMITS = Object.freeze({ fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
export interface ProjectRegistration {
  id: string;
  title: string;
  projectPath: string;
  originPath: string;
  mode: 'external-folder' | 'copied-starter';
  trusted: false;
  provenance: { kind: 'user-import' | 'user-authored'; attribution: string; rights: string };
  adapter: { id: 'eve.orbit'; version: 1; status: 'requires-review'; config: OrbitConfig; configSha256: string } | null;
  adapterIssue?: string;
  manifestPath?: string;
}

function title(input: string): string {
  const result = input.trim();
  if (!result || result.length > 240 || /[\u0000-\u001f]/.test(result)) throw new ImportError('INVALID_INPUT', 'Use a title between 1 and 240 characters without control characters.');
  return result;
}
function asImportError(error: unknown): ImportError {
  if (error instanceof ImportError) return error;
  return new ImportError('IO_ERROR', 'The import could not be completed. The original was not changed.', undefined, { cause: error });
}
async function detectOrbit(projectPath: string): Promise<Pick<ProjectRegistration, 'adapter' | 'adapterIssue'>> {
  const file = path.join(projectPath, 'eve.project.json');
  try { await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { adapter: null };
    throw error;
  }
  let bytes: Buffer;
  try { bytes = await readChecked(file, 64 * 1024); }
  catch {
    // Adapter detection is optional. A linked, oversized or unreadable declaration
    // never enables Orbit, but does not make an otherwise valid folder unusable.
    // The caller still rechecks the selected folder's original directory chain.
    return { adapter: null, adapterIssue: 'Eve could not read this project’s settings. You can still open its files in the code editor.' };
  }
  let config: OrbitConfig;
  try { config = parseOrbitConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return { adapter: null, adapterIssue: 'This project does not support Orbit’s timer controls. You can still open its files in the code editor.' }; }
  return { adapter: { id: 'eve.orbit', version: 1, status: 'requires-review', config, configSha256: createHash('sha256').update(bytes).digest('hex') } };
}

/** Trusted-host API. A selected folder remains external; no script or dependency is run. */
export async function registerProjectFolder(options: { sourcePath: string; title?: string }): Promise<ProjectRegistration> {
  try {
    const inspected = await inspectPath(options.sourcePath);
    if (!inspected.stat.isDirectory()) throw new ImportError('INVALID_INPUT', 'Choose a project folder.');
    const detected = await detectOrbit(inspected.path);
    await verifyChain(inspected.chain);
    return {
      id: randomUUID(), title: title(options.title ?? path.basename(inspected.path)), projectPath: inspected.path, originPath: inspected.path,
      mode: 'external-folder', trusted: false,
      provenance: { kind: 'user-import', attribution: 'User-selected external project folder. Files remain in their original location.', rights: 'Rights and project trust have not been verified.' },
      ...detected,
    };
  } catch (error) { throw asImportError(error); }
}

/** Managed storage is separate from core: register returned metadata only after this promise resolves. */
export class ManagedImporter {
  private constructor(readonly managedRoot: string, private readonly rootChain: Awaited<ReturnType<typeof inspectPath>>['chain']) {}

  /** Parent must already exist. Existing storage must belong to this OS user and be private. */
  static async open(options: { managedRoot: string }): Promise<ManagedImporter> {
    try {
      const root = checkedAbsolute(options.managedRoot);
      await inspectPath(path.dirname(root));
      await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const inspected = await inspectPath(root);
      if (!inspected.stat.isDirectory() || (inspected.stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && inspected.stat.uid !== process.getuid())) throw new ImportError('UNSAFE_PATH', 'Managed storage must be a private directory owned by the current user.');
      const importer = new ManagedImporter(root, inspected.chain);
      for (const name of ['assets', 'projects']) {
        const directory = path.join(root, name);
        await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        await importer.assertStorage(directory);
      }
      await syncDirectory(root); await syncDirectory(path.dirname(root));
      return importer;
    } catch (error) { throw asImportError(error); }
  }

  private async assertStorage(directory: string) {
    await verifyChain(this.rootChain);
    const inspected = await inspectPath(directory);
    if (!inspected.stat.isDirectory() || (inspected.stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && inspected.stat.uid !== process.getuid())) throw new ImportError('UNSAFE_PATH', 'Managed storage must remain private and owned by the current user.');
    return inspected;
  }

  private async publish<T>(collection: 'assets' | 'projects', id: string, signal: AbortSignal | undefined, fill: (staging: string, published: string) => Promise<T>): Promise<T> {
    checkCancelled(signal);
    const parent = path.join(this.managedRoot, collection);
    const parentState = await this.assertStorage(parent).catch(error => { throw asImportError(error); });
    const staging = path.join(parent, `.staging-${id}`);
    const published = path.join(parent, id);
    let didPublish = false;
    await mkdir(staging, { mode: 0o700 }).catch(error => { throw asImportError(error); });
    try {
      const result = await fill(staging, published);
      await syncDirectory(staging);
      await this.assertStorage(parent); await verifyChain(parentState.chain);
      checkCancelled(signal);
      await rename(staging, published);
      didPublish = true;
      // Cancellation after publication cannot revoke a durable import. Finish and return its receipt.
      try { await syncDirectory(parent); }
      catch (error) { throw new ImportError('DURABILITY_UNCERTAIN', 'The copy was made, but Eve could not confirm that it finished saving. Keep the recovery copy and try again.', published, { cause: error }); }
      return result;
    } catch (error) {
      if (!didPublish) {
        // Only remove our unpublished stage while its original storage chain is still intact.
        await verifyChain(parentState.chain).then(() => rm(staging, { recursive: true, force: true })).catch(() => {});
      }
      throw asImportError(error);
    }
  }

  async importAsset(options: { taskId: string; sourcePath: string; title?: string; attribution?: string; rights?: string; signal?: AbortSignal }): Promise<AssetRegistration> {
    if (!idSchema.safeParse(options.taskId).success) throw new ImportError('INVALID_INPUT', 'Choose a space for this material.');
    const source = checkedAbsolute(options.sourcePath);
    const format = ASSET_TYPES[path.extname(source).toLowerCase()];
    if (!format) throw new ImportError('UNSUPPORTED_TYPE', 'Choose UTF-8 text, Markdown, PNG, JPEG, or WebP.');
    const assetTitle = title(options.title ?? path.basename(source));
    const provenance = { kind: 'user-import' as const, attribution: options.attribution ?? 'Original file selected by the user; copied without modification.', rights: options.rights ?? 'Rights have not been verified. Import does not grant redistribution permission.' };
    if (provenance.attribution.length > 1000 || provenance.rights.length > 1000) throw new ImportError('INVALID_INPUT', 'Attribution and rights text must be at most 1000 characters each.');
    const id = randomUUID();
    return this.publish('assets', id, options.signal, async (stage, published) => {
      const fileName = `original${format.extension}`;
      const copied = await copyChecked({
        source, destination: path.join(stage, fileName), maxBytes: format.text ? ASSET_LIMITS.textBytes : ASSET_LIMITS.imageBytes,
        text: format.text, signal: options.signal,
        ...(!format.text ? { validateHeader: (header: Buffer, size: number) => validateImage(header, format.mediaType, size) } : {}),
      });
      const registration = assetRegistrationSchema.parse({ id, taskId: options.taskId, originalPath: copied.sourcePath, managedPath: path.join(published, fileName), sha256: copied.sha256, byteLength: copied.byteLength, mediaType: format.mediaType, title: assetTitle, provenance });
      await writeDurable(path.join(stage, 'manifest.json'), `${JSON.stringify({ version: 1, kind: 'asset', registration }, null, 2)}\n`);
      return registration;
    });
  }

  registerProject(options: { sourcePath: string; title?: string }): Promise<ProjectRegistration> { return registerProjectFolder(options); }

  /** The host supplies its reviewed, bundled starter path, never a renderer/model-provided path. */
  async copyStarter(options: { starterId: 'eve.orbit'; starterPath: string; title?: string; signal?: AbortSignal }): Promise<ProjectRegistration> {
    if (options.starterId !== 'eve.orbit') throw new ImportError('UNSUPPORTED_TYPE', 'This starter project is not available.');
    checkCancelled(options.signal);
    const original = await registerProjectFolder({ sourcePath: options.starterPath, title: options.title });
    if (!original.adapter) throw new ImportError('UNSUPPORTED_TYPE', 'This starter does not contain the settings needed for Orbit’s timer controls.');
    const id = randomUUID();
    return this.publish('projects', id, options.signal, async (stage, published) => {
      await mkdir(path.join(stage, 'src'), { mode: 0o700 });
      let total = 0;
      const files: { relativePath: string; sha256: string; byteLength: number }[] = [];
      for (const relativePath of ORBIT_STARTER_FILES) {
        checkCancelled(options.signal);
        const copied = await copyChecked({ source: path.join(original.projectPath, relativePath), destination: path.join(stage, relativePath), maxBytes: Math.min(STARTER_LIMITS.fileBytes, STARTER_LIMITS.totalBytes - total), signal: options.signal });
        total += copied.byteLength; files.push({ relativePath, sha256: copied.sha256, byteLength: copied.byteLength });
      }
      await syncDirectory(path.join(stage, 'src'));
      const detected = await detectOrbit(stage);
      if (!detected.adapter || detected.adapter.configSha256 !== original.adapter!.configSha256) throw new ImportError('SOURCE_CHANGED', 'The starter configuration changed during the copy.');
      const registration: ProjectRegistration = {
        id, title: original.title, projectPath: published, originPath: original.projectPath, mode: 'copied-starter', trusted: false,
        provenance: { kind: 'user-import', attribution: 'New project copied from the host-reviewed eve.orbit starter. No scripts were run and no dependencies were installed.', rights: 'Starter rights and attribution must be reviewed before redistribution.' },
        ...detected, manifestPath: path.join(published, '.eve-import.json'),
      };
      await writeDurable(path.join(stage, '.eve-import.json'), `${JSON.stringify({ version: 1, kind: 'project', starterId: options.starterId, registration, files }, null, 2)}\n`);
      return registration;
    });
  }
}
