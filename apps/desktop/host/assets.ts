import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assetRegistrationSchema, idSchema, sourceRegistrationSchema, type AssetRecord, type CoreValueResult, type SourceRecord, type SourceRegistration } from '@eve/contracts';
import type { TaskAsset } from '../shared/bridge';
import { ASSET_LIMITS, ASSET_TYPES, ManagedImporter } from '../../../packages/imports/src/index';
import { ImportError, inspectPath, readChecked, verifyChain } from '../../../packages/imports/src/filesystem';
import type { CoreClient } from './project-edits';

export const MATERIAL_EXCERPT_BYTES = 1800;
/** Renderer-safe identity for the existing material viewer; never a filesystem path. */
export interface MaterialTarget { taskId: string; assetId: string }
class MaterialError extends Error {
  constructor(message: string, readonly notFound = false) { super(message); }
}
const textType = (asset: AssetRecord) => ['text/plain', 'text/markdown'].includes(asset.mediaType);
const supportedTypes = new Set(Object.values(ASSET_TYPES).map(type => type.mediaType));
const sourceId = (asset: AssetRecord) => `material:${createHash('sha256').update(JSON.stringify([asset.taskId, asset.id, asset.sha256])).digest('hex')}`;
const assetUrl = (taskId: string, assetId: string) => `eve-asset://workspace/${encodeURIComponent(taskId)}/${encodeURIComponent(assetId)}`;
const verifiedError = 'This saved material has changed or could not be verified. It was not shared with AI.';
function prefixBytes(text: string, limit: number): string {
  let result = ''; let size = 0;
  for (const character of text) { const bytes = Buffer.byteLength(character); if (size + bytes > limit) break; result += character; size += bytes; }
  return result;
}
function excerpt(bytes: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new MaterialError(verifiedError);
  if (!text) return '[Empty imported UTF-8 text file; no text content was extracted.]';
  if (Buffer.byteLength(text) <= MATERIAL_EXCERPT_BYTES) return text;
  // Put the notice first so a later model-context truncation cannot hide it.
  const notice = `[Truncated excerpt of imported text (${bytes.length} original UTF-8 bytes); only the beginning follows.]\n\n`;
  return notice + prefixBytes(text, MATERIAL_EXCERPT_BYTES - Buffer.byteLength(notice));
}

export class TaskAssets {
  private constructor(private importer: ManagedImporter, private core: CoreClient, private storageChain: Awaited<ReturnType<typeof inspectPath>>['chain']) {}
  static async open(managedRoot: string, core: CoreClient) {
    const importer = await ManagedImporter.open({ managedRoot });
    return new TaskAssets(importer, core, (await inspectPath(path.join(importer.managedRoot, 'assets'))).chain);
  }
  async records(taskId: string) {
    idSchema.parse(taskId);
    const assets = await this.core<AssetRecord[]>('list-assets', taskId);
    for (const asset of assets) {
      const { createdAt, ...registration } = asset;
      if (asset.taskId !== taskId || !supportedTypes.has(asset.mediaType) || !Number.isSafeInteger(createdAt) || createdAt < 0 || !assetRegistrationSchema.safeParse(registration).success) throw new MaterialError('Eve could not verify the saved details for this material.');
    }
    return assets;
  }
  async list(taskId: string): Promise<TaskAsset[]> {
    return (await this.records(taskId)).map(asset => ({
      id: asset.id, taskId: asset.taskId, title: asset.title, mediaType: asset.mediaType,
      byteLength: asset.byteLength, provenance: asset.provenance, url: assetUrl(asset.taskId, asset.id),
    }));
  }
  async import(taskId: string, sourcePath: string, attribution?: string, title?: string) {
    const asset = await this.importer.importAsset({ taskId, sourcePath, ...(attribution ? { attribution } : {}), ...(title ? { title } : {}) });
    let result: CoreValueResult<AssetRecord>;
    try { result = await this.core<CoreValueResult<AssetRecord>>('register-asset', asset); }
    catch { throw new MaterialError('Your original was copied, but Eve could not confirm that it was added to this space. A recovery copy is saved.'); }
    // Preserve the durable manifest even if database acknowledgement is lost.
    if (!result.ok) throw new MaterialError('Your original was copied, but it could not be added to this space. A recovery copy is saved.');
    if (textType(result.value)) {
      try { await this.ensureSource(result.value, await this.core<SourceRecord[]>('list-sources', taskId)); }
      catch { throw new MaterialError('The material was saved, but Eve could not make it available for questions yet. Eve will check it again before use.'); }
    }
    return result.value;
  }

  /** Every capture must replace persisted asset sources with this verified result. */
  async ensureSources(taskId: string): Promise<SourceRecord[]> {
    const assets = (await this.records(taskId)).filter(textType);
    const existing = await this.core<SourceRecord[]>('list-sources', taskId);
    const result: SourceRecord[] = [];
    // Images remain material-viewer metadata. No caption, OCR, or visual facts
    // are invented, and cached excerpts are never admitted without re-reading.
    for (const asset of assets) result.push(await this.ensureSource(asset, existing));
    return result;
  }

  async resolveSource(taskId: string, id: string): Promise<MaterialTarget> {
    idSchema.parse(id);
    const assetRecords = await this.records(taskId);
    const source = (await this.core<SourceRecord[]>('list-sources', taskId)).find(item => item.id === id && item.taskId === taskId);
    const asset = source?.assetId && assetRecords.find(item => item.id === source.assetId);
    if (!source || !asset || !textType(asset) || source.id !== sourceId(asset)) throw new MaterialError('Choose a source attached to this space.');
    const registration = await this.sourceRegistration(asset);
    this.matches(source, registration);
    return { taskId, assetId: asset.id };
  }

  private async ensureSource(asset: AssetRecord, existing: readonly SourceRecord[]): Promise<SourceRecord> {
    const registration = await this.sourceRegistration(asset);
    const prior = existing.find(source => source.id === registration.id);
    if (prior) { this.matches(prior, registration); return structuredClone(prior); }
    let result: CoreValueResult<SourceRecord>;
    try { result = await this.core<CoreValueResult<SourceRecord>>('register-source', registration); }
    catch { throw new MaterialError('Your material is saved, but Eve could not confirm that it is available for questions.'); }
    if (!result.ok) throw new MaterialError('Your material is saved, but Eve could not make it available for questions.');
    this.matches(result.value, registration);
    return result.value;
  }
  private matches(source: SourceRecord, expected: SourceRegistration) {
    const { createdAt, ...registration } = source;
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !sourceRegistrationSchema.safeParse(registration).success || !isDeepStrictEqual(registration, expected)) throw new MaterialError('The source used for questions no longer matches your saved material.');
  }
  private async sourceRegistration(asset: AssetRecord): Promise<SourceRegistration> {
    try {
      return sourceRegistrationSchema.parse({ id: sourceId(asset), taskId: asset.taskId, assetId: asset.id, title: asset.title,
        excerpt: excerpt(await this.verifiedBytes(asset)), retrievedAt: asset.createdAt, provenance: structuredClone(asset.provenance) });
    } catch (error) { if (error instanceof MaterialError) throw error; throw new MaterialError(verifiedError); }
  }
  private async verifiedBytes(asset: AssetRecord): Promise<Buffer> {
    try {
      const max = textType(asset) ? ASSET_LIMITS.textBytes : ASSET_LIMITS.imageBytes;
      if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0 || asset.byteLength > max) throw new MaterialError(verifiedError);
      const collection = path.join(this.importer.managedRoot, 'assets');
      const relative = path.relative(collection, asset.managedPath);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new MaterialError('Not found', true);
      await verifyChain(this.storageChain);
      const bytes = await readChecked(asset.managedPath, max);
      await verifyChain(this.storageChain);
      if (bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new MaterialError(verifiedError);
      return bytes;
    } catch (error) {
      if (error instanceof MaterialError) throw error;
      if (error instanceof ImportError && error.code === 'UNSAFE_PATH') throw new MaterialError('Not found', true);
      throw new MaterialError(verifiedError);
    }
  }
  async text(taskId: string, assetId: string) {
    const asset = (await this.records(taskId)).find(item => item.id === assetId);
    if (!asset || !textType(asset)) throw new Error('Choose a saved text or Markdown reference.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(await this.verifiedBytes(asset)); }
    catch { throw new Error('This saved material could not be verified.'); }
  }
  async serve(urlString: string): Promise<Response> {
    try {
      const url = new URL(urlString);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (url.protocol !== 'eve-asset:' || url.hostname !== 'workspace' || url.username || url.password || url.port || url.search || url.hash || parts.length !== 2) return new Response('Not found', { status: 404 });
      const [taskId, assetId] = parts as [string, string];
      const asset = (await this.records(taskId)).find(item => item.id === assetId);
      if (!asset) return new Response('Not found', { status: 404 });
      const bytes = await this.verifiedBytes(asset);
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': asset.mediaType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" } });
    } catch (error) { return new Response('This saved material could not be verified.', { status: error instanceof MaterialError && error.notFound ? 404 : 409 }); }
  }
}
