import { describe, expect, it } from 'vitest';
import {
  CANVAS_IMAGE_MIN_CROP_SPAN, canvasBlockSchema, canvasDataEqual, canvasDocumentSchema,
  canvasImageAdjustmentsSchema, canvasImageAssetIds, compileCanvasSuggestion,
  imageAdjustmentsEqual, normalizedImageAdjustments,
  type CanvasBlock, type CanvasDocument, type CanvasImageAdjustments,
} from '../../packages/contracts/src/canvas';

const image = (): Extract<CanvasBlock, { kind: 'image' }> => ({ id: 'photo', kind: 'image', title: 'My photograph', placement: 'main', pinned: false, sourceIds: [], assetId: 'original-image', caption: 'Original preserved' });
const neutral = (): CanvasImageAdjustments => ({ brightness: 1, contrast: 1, saturation: 1, straighten: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } });
const adjustments = (): CanvasImageAdjustments => ({ brightness: 1.12, contrast: 1.08, saturation: 0.9, straighten: -2.5, crop: { left: 0.12, top: 0.08, right: 0.88, bottom: 0.93 } });
const document = (block: CanvasBlock = image()): CanvasDocument => ({ version: 1, title: 'My photographs', subtitle: '', layout: 'focus', blocks: [block] });

describe('canonical reversible image adjustment data', () => {
  it('preserves legacy images and pinned identities without inserting adjustment defaults', () => {
    const original = { ...image(), pinned: true }, saved = document(original);
    const serialized = JSON.stringify(saved);
    const parsed = canvasDocumentSchema.parse(saved);
    expect(parsed).toEqual(saved);
    expect(canvasDataEqual(parsed, saved)).toBe(true);
    expect(Object.hasOwn(parsed.blocks[0]!, 'adjustments')).toBe(false);
    expect(JSON.stringify(saved)).toBe(serialized);
  });

  it('retains explicit null and explicit neutral settings without silently rewriting either representation', () => {
    for (const value of [null, neutral()]) {
      const original = { ...image(), adjustments: value }, saved = document(original);
      expect(canvasDocumentSchema.parse(saved)).toEqual(saved);
      expect(canvasBlockSchema.parse(original)).toEqual(original);
      expect(Object.hasOwn(canvasBlockSchema.parse(original), 'adjustments')).toBe(true);
    }
  });

  it('stores bounded display changes while keeping the same admitted original identity', () => {
    const original = image(), modified = { ...original, adjustments: adjustments() };
    expect(canvasBlockSchema.parse(modified)).toEqual(modified);
    expect(canvasImageAssetIds(modified)).toEqual([original.assetId]);
    expect(original).toEqual(image());
  });

  it('allows the full supported adjustment ranges, including grayscale and both straighten directions', () => {
    expect(canvasImageAdjustmentsSchema.parse({ ...neutral(), brightness: 0.25, contrast: 0.25, saturation: 0, straighten: -15 })).toMatchObject({ brightness: 0.25, contrast: 0.25, saturation: 0, straighten: -15 });
    expect(canvasImageAdjustmentsSchema.parse({ ...neutral(), brightness: 2, contrast: 2, saturation: 2, straighten: 15 })).toMatchObject({ brightness: 2, contrast: 2, saturation: 2, straighten: 15 });
  });

  it.each([
    ['brightness', 0.249], ['brightness', 2.001], ['contrast', 0], ['contrast', 2.001],
    ['saturation', -0.001], ['saturation', 2.001], ['straighten', -15.001], ['straighten', 15.001],
  ] as const)('rejects an unsupported %s value of %s', (field, value) => {
    expect(canvasImageAdjustmentsSchema.safeParse({ ...neutral(), [field]: value }).success).toBe(false);
  });

  it.each(['brightness', 'contrast', 'saturation', 'straighten'] as const)('requires finite numeric %s, with no coercion', field => {
    for (const value of [NaN, Infinity, -Infinity, '1', null, undefined]) expect(canvasImageAdjustmentsSchema.safeParse({ ...neutral(), [field]: value }).success).toBe(false);
  });

  it('requires complete registered settings and rejects arbitrary filter strings, assets and URLs', () => {
    for (const extra of [{ filter: 'blur(2px)' }, { url: 'https://example.com/image.png' }, { assetId: 'another-image' }, { exposure: 1 }, { crop: null }]) expect(canvasImageAdjustmentsSchema.safeParse({ ...neutral(), ...extra }).success).toBe(false);
    const partial: Partial<CanvasImageAdjustments> = neutral(); delete partial.contrast;
    expect(canvasImageAdjustmentsSchema.safeParse(partial).success).toBe(false);
  });

  it('does not expand this increment to design-layer adjustment data', () => {
    const block = { id: 'design', kind: 'design', title: 'A design', placement: 'main', pinned: false, sourceIds: [], width: 600, height: 600, background: '#ffffff', layers: [
      { id: 'layer', kind: 'image', name: 'Image', x: 0, y: 0, width: 600, height: 600, assetId: 'original-image', fit: 'contain', adjustments: neutral() },
    ] };
    expect(canvasBlockSchema.safeParse(block).success).toBe(false);
  });
});

describe('original-relative crop bounds', () => {
  it('supports full crops and exact minimum spans at ordinary decimal edges', () => {
    expect(CANVAS_IMAGE_MIN_CROP_SPAN).toBe(0.05);
    for (const crop of [
      { left: 0, top: 0, right: 1, bottom: 1 },
      { left: 0.1, top: 0.1, right: 0.15, bottom: 0.15 },
      { left: 0.95, top: 0.95, right: 1, bottom: 1 },
    ]) expect(canvasImageAdjustmentsSchema.parse({ ...neutral(), crop }).crop).toEqual(crop);
  });

  it.each([
    { left: 0.5, top: 0, right: 0.5, bottom: 1 },
    { left: 0, top: 0.5, right: 1, bottom: 0.5 },
    { left: 0.6, top: 0, right: 0.5, bottom: 1 },
    { left: 0, top: 0.6, right: 1, bottom: 0.5 },
    { left: 0.1, top: 0, right: 0.1499999999, bottom: 1 },
    { left: 0, top: 0.1, right: 1, bottom: 0.1499999999 },
    { left: -Number.EPSILON, top: 0, right: 1, bottom: 1 },
    { left: 0, top: 0, right: 1 + Number.EPSILON, bottom: 1 },
    { left: 0, top: -0.001, right: 1, bottom: 1 },
    { left: 0, top: 0, right: 1, bottom: 1.001 },
  ])('rejects empty, reversed, undersized or outside crop %j', crop => {
    expect(canvasImageAdjustmentsSchema.safeParse({ ...neutral(), crop }).success).toBe(false);
  });

  it.each(['left', 'top', 'right', 'bottom'] as const)('requires a finite numeric %s crop edge', field => {
    for (const value of [NaN, Infinity, -Infinity, '0', null, undefined]) expect(canvasImageAdjustmentsSchema.safeParse({ ...neutral(), crop: { ...neutral().crop, [field]: value } }).success).toBe(false);
  });

  it('rejects mixed crop coordinate representations and unknown geometry fields', () => {
    expect(canvasImageAdjustmentsSchema.safeParse({ ...neutral(), crop: { x: 0, y: 0, width: 1, height: 1 } }).success).toBe(false);
    expect(canvasImageAdjustmentsSchema.safeParse({ ...neutral(), crop: { ...neutral().crop, width: 1 } }).success).toBe(false);
  });
});

describe('display-only adjustment normalization', () => {
  it('treats missing/null settings and explicit neutral factors with full crop as the same original', () => {
    expect(normalizedImageAdjustments()).toEqual(neutral());
    expect(normalizedImageAdjustments(null)).toEqual(neutral());
    expect(imageAdjustmentsEqual(undefined, null)).toBe(true);
    expect(imageAdjustmentsEqual(undefined, neutral())).toBe(true);
    expect(imageAdjustmentsEqual(null, neutral())).toBe(true);
    expect(imageAdjustmentsEqual({ ...neutral(), straighten: -0 }, neutral())).toBe(true);
  });

  it('returns independent data without mutating originals or sharing neutral crop objects', () => {
    const original = adjustments(), normalized = normalizedImageAdjustments(original);
    expect(normalized).toEqual(original);
    normalized.crop.left = 0.2; normalized.brightness = 1.5;
    expect(original).toEqual(adjustments());
    const first = normalizedImageAdjustments(); first.crop.left = 0.1;
    expect(normalizedImageAdjustments()).toEqual(neutral());
  });

  it('detects every visible setting change without considering object key order', () => {
    const original = adjustments();
    expect(imageAdjustmentsEqual(original, { crop: { bottom: original.crop.bottom, top: original.crop.top, right: original.crop.right, left: original.crop.left }, straighten: original.straighten, saturation: original.saturation, contrast: original.contrast, brightness: original.brightness })).toBe(true);
    for (const field of ['brightness', 'contrast', 'saturation', 'straighten'] as const) expect(imageAdjustmentsEqual(original, { ...original, [field]: original[field] + 0.01 })).toBe(false);
    for (const field of ['left', 'top', 'right', 'bottom'] as const) expect(imageAdjustmentsEqual(original, { ...original, crop: { ...original.crop, [field]: original.crop[field] + 0.01 } })).toBe(false);
  });
});

describe('image adjustments inside prepared suggestions', () => {
  const choice = (): CanvasDocument => ({ ...document(), suggestions: [{ id: 'light', label: 'A little more light', description: 'Preview the adjustment.', request: 'Adjust this image.', targetBlockId: 'photo', prepared: { before: [image()], edits: [{ type: 'replace', block: { ...image(), adjustments: adjustments() } }] } }] });

  it('compiles only reversible data and preserves the original resource and exact before snapshot', () => {
    const original = choice(), compiled = compileCanvasSuggestion(original, 'light', { assetIds: ['original-image'], sourceIds: [] });
    expect(compiled.blocks[0]).toEqual({ ...image(), adjustments: adjustments() });
    expect(canvasImageAssetIds(compiled.blocks[0]!)).toEqual(['original-image']);
    expect(original).toEqual(choice());
  });

  it.each(['before', 'edit'] as const)('validates nested adjustment bounds in the prepared %s', location => {
    const original = choice(), plan = original.suggestions![0]!.prepared!;
    const edit = plan.edits[0]!;
    if (edit.type === 'remove') throw new Error('Expected a block edit');
    const block = location === 'before' ? plan.before[0]! : edit.block;
    if (block.kind === 'image') block.adjustments = { ...neutral(), crop: { left: 0.99, top: 0, right: 1, bottom: 1 } };
    expect(canvasDocumentSchema.safeParse(original).success).toBe(false);
  });

  it('keeps visual equality separate from exact durable preconditions and pin protection', () => {
    const value = choice(), original = value.blocks[0]!;
    if (original.kind !== 'image') throw new Error('Expected image');
    expect(imageAdjustmentsEqual(original.adjustments, null)).toBe(true);
    value.suggestions![0]!.prepared!.before[0] = { ...original, adjustments: null };
    expect(() => compileCanvasSuggestion(value, 'light')).toThrow('changed');
    const pinned = choice(); pinned.blocks[0]!.pinned = true; pinned.suggestions![0]!.prepared!.before[0]!.pinned = true;
    expect(() => compileCanvasSuggestion(pinned, 'light')).toThrow('Unpin');
  });
});
