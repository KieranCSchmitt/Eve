import { createHash, randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assetRegistrationSchema, idSchema, type AssetRegistration } from '@eve/contracts';
import { readChecked, writeDurable, syncDirectory } from '../../../packages/imports/src/filesystem';
import { BackupError, validRelative, type RelocationContext } from '../../../packages/backup/src/index';
import { parseOrbitConfig, type OrbitConfig } from '../../../adapters/orbit/src/index';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const recoveryDocument = z.object({
  uri: z.string().min(1).max(4096), version: integer, hash: digest,
  languageId: z.string().max(256), dirty: z.boolean(), untitled: z.boolean(),
  text: z.string().max(16 * 1024 * 1024), bytes: integer, diskHash: digest.nullable(),
}).strict();
const recoverySnapshot = z.object({
  version: z.literal(1), capturedAt: integer, projectRoot: z.string().min(1).max(4096),
  documents: z.array(recoveryDocument).max(10_000),
}).strict();
const recoveryName = /^(?:current|pending-[\d-]+[a-f\d-]*|orphan-[a-f\d-]+)\.json$/;
const acknowledgment = z.object({
  version: z.literal(1), projectRoot: z.string().min(1).max(4096),
  files: z.array(z.object({ name: z.string().regex(recoveryName).refine(name => name !== 'current.json'), sha256: digest }).strict()).max(10_000),
}).strict();
const assetManifest = z.object({ version: z.literal(1), kind: z.literal('asset'), registration: assetRegistrationSchema }).strict();
const projectManifest = z.object({
  version: z.literal(1), kind: z.literal('project'), starterId: z.literal('eve.orbit'),
  registration: z.object({
    id: idSchema, title: z.string().min(1).max(240), projectPath: z.string().min(1).max(4096), originPath: z.string().min(1).max(4096),
    mode: z.literal('copied-starter'), trusted: z.literal(false),
    provenance: z.object({ kind: z.enum(['user-import', 'user-authored']), attribution: z.string().max(1000), rights: z.string().max(1000) }).strict(),
    adapter: z.object({ id: z.literal('eve.orbit'), version: z.literal(1), status: z.literal('requires-review'), config: z.custom<OrbitConfig>(value => { try { parseOrbitConfig(value); return true; } catch { return false; } }), configSha256: digest }).strict().nullable(),
    adapterIssue: z.string().max(2000).optional(), manifestPath: z.string().min(1).max(4096),
  }).strict(),
  files: z.array(z.object({ relativePath: z.string().refine(validRelative), sha256: digest, byteLength: integer }).strict()).max(100_000),
}).strict();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const refused = (message: string): never => { throw new BackupError('RELOCATION_REQUIRED', message); };
export interface RecoveryProjectBinding {
  /** V4/V5 stable core ID; absent only for exact legacy V3 task-path receipts. */
  projectId?: string;
  before: string;
  after: string;
}
export interface ProfileFileRelocationOptions {
  assets?: readonly AssetRegistration[];
  projectBindings?: readonly RecoveryProjectBinding[];
  /** Legacy direct-validator compatibility. Cannot authorize a nested project namespace. */
  projectPaths?: readonly string[];
}
const portableProjectId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Only application-owned metadata is rewritten; authored source, notes and draft text are never searched/replaced. */
export async function relocateProfileFiles(context: RelocationContext, options: ProfileFileRelocationOptions = {}) {
  const { stagingProfile, destinationProfile, originalProfileRoot, manifest, signal } = context;
  const inCollection = (name: string, root: string) => name === root || name.startsWith(`${root}/`);
  // Entry labels are archive data, not authority. In particular an archive may
  // not relabel editor settings/extensions or Chromium data as a project tree.
  for (const entry of manifest.entries) {
    if (entry.kind === 'settings') return refused('This saved settings format requires an explicit restore adapter.');
    if (entry.kind === 'recovery' && entry.path !== 'workbench/recovery') return refused('An unrecognized recovery collection requires an explicit restore adapter.');
    if (entry.kind === 'managed-originals' && !inCollection(entry.path, 'storage/assets')) return refused('An unrecognized material collection requires an explicit restore adapter.');
    if (entry.kind === 'project' && !inCollection(entry.path, 'workspaces') && !inCollection(entry.path, 'storage/projects')) return refused('An unrecognized project collection requires an explicit restore adapter; editor and browser state cannot be restored as project files.');
  }
  const changes = new Map<string, string>();
  const notes = new Set<string>();
  const fileRecords = new Map(manifest.files.map(file => [file.path, file]));
  const sourceAssets = new Map((options.assets ?? []).map(asset => [asset.id, asset]));
  const validatedAssets = new Set<string>();
  if (sourceAssets.size !== (options.assets ?? []).length) return refused('The core material registry contains duplicate identities.');
  const check = () => { if (signal?.aborted) throw new BackupError('CANCELLED', 'Profile relocation cancelled. Existing profiles were not changed.'); };
  const relative = (root: string, value: string) => {
    const result = path.relative(root, value);
    return result === '' || (result !== '..' && !result.startsWith(`..${path.sep}`) && !path.isAbsolute(result)) ? result.split(path.sep).join('/') : null;
  };
  const location = (value: string, kind: 'managed' | 'reference'): string => {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return refused('A saved metadata path is not a canonical absolute path.');
    const owned = relative(originalProfileRoot, value);
    if (owned === null) {
      if (relative(stagingProfile, value) !== null || relative(destinationProfile, value) !== null) return refused('Metadata unexpectedly refers to the restore destination or temporary directory.');
      if (kind === 'managed') return refused('A managed original is outside its original profile.');
      notes.add('External file references were preserved; those external files were not copied or granted trust.');
      return value;
    }
    if (kind === 'managed' && !fileRecords.has(owned)) return refused('A managed original is missing from the verified backup.');
    return path.join(destinationProfile, owned);
  };
  const uri = (value: string): string => {
    if (/[\u0000-\u001f\u007f]/.test(value)) return refused('A recovery document URI contains unsupported control characters.');
    let parsed: URL;
    try { parsed = new URL(value); } catch { return refused('A recovery document URI is invalid.'); }
    if (parsed.protocol === 'untitled:') return value;
    if (parsed.protocol !== 'file:' || parsed.host || parsed.search || parsed.hash) return refused('A recovery document uses an unsupported location.');
    return pathToFileURL(location(fileURLToPath(parsed), 'reference')).href;
  };
  const read = async (name: string, limit = 32 * 1024 * 1024) => {
    check();
    const record = fileRecords.get(name);
    if (!record) return refused('A required metadata file is not listed in the verified backup.');
    const bytes = await readChecked(path.join(stagingProfile, name), limit);
    if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) return refused('Backup metadata changed before relocation.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return refused('Saved metadata is not valid UTF-8.'); }
  };
  const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return refused('A saved metadata file is not valid JSON.'); } };
  const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  for (const file of manifest.files) {
    check();
    if (/^storage\/assets\/[^/]+\/manifest\.json$/.test(file.path)) {
      const parsed = assetManifest.safeParse(parse(await read(file.path)));
      if (!parsed.success) return refused('An imported-material manifest has an unsupported format.');
      const registration = parsed.data.registration;
      if (registration.id !== path.posix.basename(path.posix.dirname(file.path))) return refused('An imported-material manifest does not match its collection identity.');
      const managedPath = location(registration.managedPath, 'managed');
      const originalRelative = relative(originalProfileRoot, registration.managedPath)!;
      const original = fileRecords.get(originalRelative)!;
      if (path.posix.dirname(originalRelative) !== path.posix.dirname(file.path) || registration.sha256 !== original.sha256 || registration.byteLength !== original.bytes) return refused('An imported-material manifest does not match its original bytes.');
      const expected = sourceAssets.get(registration.id);
      const relocated = { ...registration, managedPath, originalPath: registration.originalPath ? location(registration.originalPath, 'reference') : '' };
      if (expected && JSON.stringify(assetRegistrationSchema.parse(expected)) !== JSON.stringify(assetRegistrationSchema.parse(relocated))) return refused('An imported-material manifest disagrees with the relocated core record.');
      validatedAssets.add(registration.id);
      if (!expected) notes.add('Unregistered imported originals were preserved with their manifests; restore did not attach them to a task.');
      changes.set(file.path, serialize({ ...parsed.data, registration: relocated }));
    } else if (/^storage\/projects\/[^/]+\/\.eve-import\.json$/.test(file.path)) {
      const parsed = projectManifest.safeParse(parse(await read(file.path)));
      if (!parsed.success) return refused('A copied project manifest has an unsupported format.');
      const registration = parsed.data.registration;
      if (registration.id !== path.posix.basename(path.posix.dirname(file.path))) return refused('A copied project manifest does not match its collection identity.');
      const projectRelative = relative(originalProfileRoot, registration.projectPath);
      if (projectRelative !== path.posix.dirname(file.path) || relative(originalProfileRoot, registration.manifestPath) !== file.path) return refused('A copied project manifest refers outside its own collection.');
      if (new Set(parsed.data.files.map(item => item.relativePath)).size !== parsed.data.files.length) return refused('A copied project manifest contains duplicate original files.');
      changes.set(file.path, serialize({ ...parsed.data, registration: {
        ...registration, projectPath: location(registration.projectPath, 'reference'),
        originPath: location(registration.originPath, 'reference'), manifestPath: location(registration.manifestPath, 'managed'),
      } }));
      notes.add('Copied projects remain untrusted; their original import hashes are preserved as provenance, not treated as current file hashes.');
    }
  }
  if ([...sourceAssets.keys()].some(id => !validatedAssets.has(id))) return refused('A registered original has no validated matching material manifest.');

  const bindings = new Map<string, RecoveryProjectBinding>();
  for (const binding of options.projectBindings ?? []) {
    if (location(binding.before, 'reference') !== binding.after) return refused('A core recovery binding does not match the exact relocation mapping.');
    if (binding.projectId !== undefined) {
      const previous = bindings.get(binding.projectId);
      if (previous && (previous.before !== binding.before || previous.after !== binding.after)) return refused('A core recovery project identity has conflicting roots.');
      bindings.set(binding.projectId, { ...binding });
    }
  }
  const recoveryFiles = manifest.files.filter(file => file.path.startsWith('workbench/recovery/'));
  type Collection = { root: string; projectId?: string; files: typeof recoveryFiles };
  const collections = new Map<string, Collection>();
  let unknownCount = 0;
  for (const file of recoveryFiles) {
    const components = file.path.slice('workbench/recovery/'.length).split('/');
    const name = components.at(-1)!;
    if (name === 'workbench.lock') return refused('A running workbench lock cannot be restored as recovery content.');
    if (components.length > 2 || (!recoveryName.test(name) && name !== 'acknowledged.json')) { unknownCount++; continue; }
    const projectId = components.length === 2 ? components[0]! : undefined;
    if (projectId !== undefined && (![4, 5, 6].includes(manifest.versions.schema) || !portableProjectId.test(projectId) || !bindings.has(projectId))) return refused('A nested recovery collection requires its exact registered project identity in a supported schema.');
    const root = projectId === undefined ? 'workbench/recovery' : `workbench/recovery/${projectId}`;
    const collection = collections.get(root) ?? { root, projectId, files: [] };
    collection.files.push(file); collections.set(root, collection);
  }
  for (const collection of collections.values()) {
    const translatedHashes = new Map<string, string>();
    const journals = new Map<string, { originalProject: string; relocatedProject: string }>();
    const boundProject = (before: string, after: string) => {
      if (collection.projectId !== undefined) {
        const binding = bindings.get(collection.projectId)!;
        if (binding.before !== before || binding.after !== after) return refused('A nested recovery journal does not match its exact project ID and registered root.');
      } else if (options.projectBindings && !options.projectBindings.some(binding => binding.before === before && binding.after === after)) {
        return refused('A recovery journal does not belong to a registered restored project. Its archive remains intact.');
      }
      if (options.projectPaths && !options.projectPaths.includes(after)) return refused('A recovery journal does not belong to a registered restored project. Its archive remains intact.');
    };
    for (const file of collection.files) {
      const name = path.posix.basename(file.path);
      if (!recoveryName.test(name)) continue;
      const originalText = await read(file.path);
      const parsed = recoverySnapshot.safeParse(parse(originalText));
      if (!parsed.success) return refused('A recovery journal has an unsupported format; its archive remains intact.');
      for (const document of parsed.data.documents) {
        if (document.hash !== hash(document.text) || document.bytes !== Buffer.byteLength(document.text) || document.untitled !== document.uri.startsWith('untitled:')) return refused('A recovery draft does not match its recorded text or identity.');
      }
      const snapshot = {
        ...parsed.data,
        projectRoot: location(parsed.data.projectRoot, 'reference'),
        documents: parsed.data.documents.map(document => ({ ...document, uri: uri(document.uri) })),
      };
      boundProject(parsed.data.projectRoot, snapshot.projectRoot);
      if ([...journals.values()].some(journal => journal.originalProject !== parsed.data.projectRoot || journal.relocatedProject !== snapshot.projectRoot)) return refused('This recovery collection contains different projects and needs an explicit recovery adapter.');
      journals.set(name, { originalProject: parsed.data.projectRoot, relocatedProject: snapshot.projectRoot });
      const next = serialize(snapshot);
      changes.set(file.path, next);
      translatedHashes.set(`${name}:${hash(originalText)}`, hash(next));
    }
    const name = `${collection.root}/acknowledged.json`;
    if (fileRecords.has(name)) {
      const parsed = acknowledgment.safeParse(parse(await read(name)));
      if (!parsed.success) return refused('The recovery acknowledgment history has an unsupported format.');
      const projectRoot = location(parsed.data.projectRoot, 'reference');
      boundProject(parsed.data.projectRoot, projectRoot);
      if ([...journals.values()].some(journal => journal.originalProject !== parsed.data.projectRoot)) return refused('Recovery acknowledgment history belongs to a different project from its journals.');
      const files = parsed.data.files.flatMap(file => {
        const translated = translatedHashes.get(`${file.name}:${file.sha256}`);
        if (translated) return [{ ...file, sha256: translated }];
        if (journals.has(file.name)) {
          // A stale or cross-namespace hash must never acknowledge transformed content.
          notes.add('Stale acknowledgments for changed recovery journals were removed; those drafts remain pending for explicit review.');
          return [];
        }
        return [file]; // Historical receipts for absent journals remain inert history.
      });
      changes.set(name, serialize({ ...parsed.data, projectRoot, files }));
    }
  }
  if (unknownCount) notes.add(`${unknownCount} unrecognized recovery file${unknownCount === 1 ? ' was' : 's were'} preserved unchanged for review; none is used to authorize a file edit.`);
  // Validation is complete before rewriting any metadata. The caller still owns
  // staging and must compose the independent core/database validation receipt.
  for (const [name, text] of changes) {
    check();
    const target = path.join(stagingProfile, name);
    const temporary = `${target}.${randomUUID()}.restore`;
    try { await writeDurable(temporary, text); check(); await rename(temporary, target); await syncDirectory(path.dirname(target)); }
    finally { await rm(temporary, { force: true }); }
  }
  return { filesValidated: true as const, validatedFiles: [...new Set([...changes.keys(), ...recoveryFiles.map(file => file.path)])], changedFiles: [...changes.keys()], notes: [...notes] };
}
