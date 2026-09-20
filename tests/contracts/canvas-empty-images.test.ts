import { describe, expect, it } from 'vitest';
import { canvasBlockSchema, canvasDataEqual, canvasDesignLayerSchema, canvasDocumentSchema, canvasImageAssetIds, canvasReferencedBlocks, compileCanvasSuggestion, normalizedImageAdjustments, type CanvasBlock, type CanvasDocument, type CanvasSuggestion } from '../../packages/contracts/src/canvas';

const slot = (): Extract<CanvasBlock, { kind: 'image' }> => ({ id: 'image-slot', kind: 'image', title: 'My image', placement: 'aside', pinned: false, sourceIds: [], assetId: null, caption: 'My authored caption.' });
const text: CanvasBlock = { id: 'writing', kind: 'text', title: 'Writing', placement: 'main', pinned: true, sourceIds: [], body: 'Keep this exact sentence.' };
const document = (block: CanvasBlock = slot(), suggestions: CanvasSuggestion[] = []): CanvasDocument => ({ version: 1, title: 'My work', subtitle: '', layout: 'split', blocks: [text, block], suggestions });
const choice = (edits: NonNullable<CanvasSuggestion['prepared']>['edits'], before: CanvasBlock[] = []): CanvasSuggestion => ({ id: 'choice', label: 'Review image change', description: 'Review before keeping.', request: 'Review the prepared image change.', targetBlockId: null, prepared: { edits, before } });
const imageLayer = { id: 'layer', kind: 'image', name: 'Image', x: 0, y: 0, width: 100, height: 100, assetId: 'original', fit: 'contain' };

describe('canonical empty image slots', () => {
  it('keeps empty and existing attached representations without defaults or input mutation', () => {
    for (const image of [slot(), { ...slot(), adjustments: null }, { ...slot(), assetId: 'original' }, { ...slot(), assetId: 'original', adjustments: normalizedImageAdjustments() }]) {
      const initial = structuredClone(image);
      expect(canvasBlockSchema.parse(image)).toEqual(initial);
      expect(canvasDocumentSchema.parse(document(image))).toEqual(document(initial));
      expect(Object.hasOwn(canvasBlockSchema.parse(image), 'adjustments')).toBe(Object.hasOwn(initial, 'adjustments'));
      expect(image).toEqual(initial);
    }
  });
  it.each([undefined, '', 0, false, {}, 'x'.repeat(129)])('requires an explicit null or valid asset identity, rejecting %j', assetId => {
    expect(canvasBlockSchema.safeParse({ ...slot(), assetId }).success).toBe(false);
  });
  it('rejects every settings object on an empty slot, including neutral settings', () => {
    for (const adjustments of [normalizedImageAdjustments(), { ...normalizedImageAdjustments(), brightness: 1.2 }]) {
      expect(() => canvasBlockSchema.parse({ ...slot(), adjustments })).toThrow(/attach an image/i);
      expect(canvasDocumentSchema.safeParse(document({ ...slot(), adjustments })).success).toBe(false);
    }
  });
  it('allows direct user data to fill a pinned slot while preserving its pin and caption', () => {
    const empty = { ...slot(), pinned: true }, attached = { ...empty, assetId: 'original' };
    expect(canvasBlockSchema.parse(empty)).toEqual(empty);
    expect(canvasBlockSchema.parse(attached)).toEqual(attached);
    expect(attached.caption).toBe(empty.caption);
  });
  it('keeps image layers non-null and does not allow an arbitrary URL field', () => {
    expect(canvasDesignLayerSchema.parse(imageLayer)).toEqual(imageLayer);
    expect(canvasDesignLayerSchema.safeParse({ ...imageLayer, assetId: null }).success).toBe(false);
    expect(canvasBlockSchema.safeParse({ ...slot(), url: 'file:///private/photo.jpg' }).success).toBe(false);
  });
  it('reports no image resource for an empty slot while retaining attached and nested references', () => {
    expect(canvasImageAssetIds(slot())).toEqual([]);
    expect(canvasImageAssetIds({ ...slot(), assetId: 'original' })).toEqual(['original']);
    const design = canvasBlockSchema.parse({ id: 'art', kind: 'design', title: 'Art', placement: 'main', pinned: false, sourceIds: [], width: 400, height: 400, background: '#ffffff', layers: [imageLayer] });
    expect(canvasImageAssetIds(design)).toEqual(['original']);
  });
});

describe('empty image prepared effects and retained originals', () => {
  it('adds a real empty image slot without an invented resource or mutation of existing work', () => {
    const original: CanvasDocument = { ...document(), blocks: [text], suggestions: [choice([{ type: 'add', block: slot() }])] };
    const copy = structuredClone(original);
    const projected = compileCanvasSuggestion(original, 'choice', { assetIds: [], sourceIds: [] });
    expect(projected.blocks).toEqual([text, slot()]);
    expect(original).toEqual(copy);
    expect(canvasReferencedBlocks(original).flatMap(canvasImageAssetIds)).toEqual([]);
  });
  it('compiles an admitted attachment with an exact empty original and refuses invented IDs', () => {
    const attached = { ...slot(), assetId: 'original' }, original = document(slot(), [choice([{ type: 'replace', block: attached }], [slot()])]);
    expect(compileCanvasSuggestion(original, 'choice', { assetIds: ['original'], sourceIds: [] }).blocks).toEqual([text, attached]);
    expect(() => compileCanvasSuggestion(original, 'choice', { assetIds: [], sourceIds: [] })).toThrow(/not attached/i);
    expect(canvasReferencedBlocks(original).flatMap(canvasImageAssetIds)).toEqual(['original']);
  });
  it('retains non-null original references when a prepared removal or clearing would hide them', () => {
    const attached = { ...slot(), assetId: 'original' };
    for (const edits of [[{ type: 'remove' as const, id: attached.id }], [{ type: 'replace' as const, block: slot() }]]) {
      const original = document(attached, [choice(edits, [attached])]);
      expect(canvasReferencedBlocks(original).flatMap(canvasImageAssetIds)).toEqual(['original', 'original']);
      expect(() => compileCanvasSuggestion(original, 'choice', { assetIds: [], sourceIds: [] })).toThrow(/not attached/i);
      const projected = compileCanvasSuggestion(original, 'choice', { assetIds: ['original'], sourceIds: [] });
      expect(projected.blocks[0]).toEqual(text);
      expect(projected.blocks.flatMap(canvasImageAssetIds)).toEqual([]);
      // The exact original remains a valid independent restoration snapshot.
      expect(canvasDataEqual(canvasDocumentSchema.parse(document(attached)), document(attached))).toBe(true);
    }
  });
  it('rejects stale caption snapshots and model changes to pinned empty slots', () => {
    const plan = choice([{ type: 'replace', block: { ...slot(), assetId: 'original' } }], [slot()]);
    expect(() => compileCanvasSuggestion(document({ ...slot(), caption: 'A later caption.' }, [plan]), 'choice')).toThrow(/changed/i);
    const pinned = { ...slot(), pinned: true };
    expect(() => compileCanvasSuggestion(document(pinned, [choice([{ type: 'replace', block: { ...pinned, assetId: 'original' } }], [pinned])]), 'choice')).toThrow(/unpin/i);
  });
  it('rejects photo settings hidden inside a future empty block or its original snapshot', () => {
    const bad = { ...slot(), adjustments: normalizedImageAdjustments() };
    expect(canvasDocumentSchema.safeParse(document(slot(), [choice([{ type: 'add', block: { ...bad, id: 'new' } }])])).success).toBe(false);
    expect(canvasDocumentSchema.safeParse(document(slot(), [choice([{ type: 'replace', block: { ...slot(), assetId: 'original' } }], [bad])])).success).toBe(false);
  });
});
