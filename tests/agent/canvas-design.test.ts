import { describe, expect, it } from 'vitest';
import { canvasDocumentSchema, canvasImageAssetIds, type CanvasBlock, type CanvasDesignLayer, type CanvasDocument } from '../../packages/contracts/src/index';
import { prepareContext, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { proposal, request } from './fixtures';

const base = { id: 'poster', title: 'An open invitation', placement: 'main' as const, pinned: false, sourceIds: [] as string[] };
const layerBase = { id: 'heading', name: 'Heading', x: 40, y: 30, width: 360, height: 120 };
const text = (): CanvasDesignLayer => ({ ...layerBase, kind: 'text', text: 'An open invitation', fontFamily: 'serif', fontSize: 48, fontWeight: 'medium', color: '#1a2233', align: 'left' });
const shape = (): CanvasDesignLayer => ({ ...layerBase, id: 'accent', name: 'Accent', kind: 'shape', shape: 'ellipse', fill: '#Aa44Ff' });
const image = (assetId = 'photo'): CanvasDesignLayer => ({ ...layerBase, id: 'photo-layer', name: 'Photograph', kind: 'image', assetId, fit: 'cover' });
const design = (layers: CanvasDesignLayer[] = [shape(), text(), image()]): Extract<CanvasBlock, { kind: 'design' }> => ({ ...base, kind: 'design', width: 480, height: 640, background: '#FAF9F4', layers });
const document = (blocks: CanvasBlock[] = [design()]): CanvasDocument => ({ version: 1, title: 'A place for ideas', subtitle: '', layout: 'focus', blocks });
const captured = (): AgentRequest => {
  const input = request({ role: 'prepare' });
  input.intent.text = 'Create a layered invitation with my attached photo and a heading.';
  input.targets = [{ id: 'orbit:canvas', kind: 'canvas', revision: 2, assets: [
    { id: 'photo', title: 'A user caption, not visual evidence', mediaType: 'image/jpeg' },
    { id: 'video', title: 'Video', mediaType: 'video/mp4' },
  ] }];
  return input;
};
const output = (blocks: unknown[] = [design()]) => proposal({ basis: 'general', citations: [], actions: [{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 2, document: { ...document(), blocks } }] as never });
const validate = (blocks: unknown[], input = captured()) => validateProposal(output(blocks), input, prepareContext(input, 'local'));

describe('bounded layered design contract', () => {
  it('keeps layer ordering and intentional overlap, permits blanks, and preserves legacy documents', () => {
    expect(canvasDocumentSchema.parse(document())).toEqual(document());
    const blank = design([]);
    expect(canvasDocumentSchema.parse(document([blank]))).toEqual(document([blank]));
    const legacy = document([{ ...base, kind: 'text', body: '' }]);
    expect(canvasDocumentSchema.parse(legacy)).toEqual(legacy);
    expect(canvasDocumentSchema.safeParse(document([design(), { ...design(), id: 'second' }])).success).toBe(true);
  });
  it.each([
    ['executable block', { script: 'alert(1)' }],
    ['raw styling', { style: { position: 'fixed' } }],
    ['small surface', { width: 239 }],
    ['oversize surface', { height: 2401 }],
    ['fractional surface', { width: 480.5 }],
    ['short background color', { background: '#fff' }],
    ['named background color', { background: 'white' }],
    ['trailing color whitespace', { background: '#ffffff\n' }],
    ['image background URL', { background: 'url(https://example.com/image.png)' }],
  ])('rejects %s', (_name, changes) => {
    expect(canvasDocumentSchema.safeParse(document([{ ...design(), ...changes } as CanvasBlock])).success).toBe(false);
  });
  it.each([
    ['executable event', { onClick: 'alert(1)' }], ['raw HTML', { html: '<b>Unsafe</b>' }],
    ['unsupported rotation', { rotation: 90 }], ['blank name', { name: '' }],
    ['long name', { name: 'x'.repeat(81) }], ['negative coordinate', { x: -1 }],
    ['fractional coordinate', { y: 0.5 }], ['zero width', { width: 0 }],
    ['horizontal overflow', { x: 121 }], ['vertical overflow', { y: 521 }],
    ['excess text', { text: 'x'.repeat(4001) }], ['unknown font', { fontFamily: 'Comic Sans' }],
    ['small text', { fontSize: 7 }], ['large text', { fontSize: 241 }],
    ['invalid weight', { fontWeight: 700 }], ['invalid alignment', { align: 'justify' }],
    ['alpha color', { color: '#11223344' }], ['color expression', { color: 'var(--accent)' }],
  ])('rejects a layer with %s', (_name, changes) => {
    expect(canvasDocumentSchema.safeParse(document([design([{ ...text(), ...changes } as CanvasDesignLayer])])).success).toBe(false);
  });
  it('requires existing image identities and registered shapes and fits', () => {
    for (const layer of [{ ...image(), assetId: null }, { ...image(), src: 'https://example.com/a.png' }, { ...image(), fit: 'fill' }, { ...shape(), shape: 'path' }, { ...shape(), fill: 'red' }]) {
      expect(canvasDocumentSchema.safeParse(document([design([layer as CanvasDesignLayer])])).success).toBe(false);
    }
    const { assetId: _, ...missing } = image() as Extract<CanvasDesignLayer, { kind: 'image' }>;
    expect(canvasDocumentSchema.safeParse(document([design([missing as CanvasDesignLayer])])).success).toBe(false);
  });
  it('bounds layer counts and identities per design, accepting the exact lower and upper dimensions', () => {
    expect(canvasDocumentSchema.safeParse(document([design([text(), text()])])).success).toBe(false);
    expect(canvasDocumentSchema.safeParse(document([design(Array.from({ length: 25 }, (_, i) => ({ ...text(), id: `layer-${i}` })))])).success).toBe(false);
    for (const size of [240, 2400]) {
      const bounded = { ...design([{ ...shape(), x: 0, y: 0, width: size, height: size }]), width: size, height: size };
      expect(canvasDocumentSchema.safeParse(document([bounded])).success).toBe(true);
    }
  });
  it('collects nested and existing image references without treating text or captions as assets', () => {
    expect(canvasImageAssetIds(design())).toEqual(['photo']);
    expect(canvasImageAssetIds(design([image('one'), { ...image('two'), id: 'second-image' }]))).toEqual(['one', 'two']);
    expect(canvasImageAssetIds({ ...base, kind: 'image', assetId: 'existing', caption: 'photo' })).toEqual(['existing']);
    expect(canvasImageAssetIds({ ...base, kind: 'text', body: 'photo' })).toEqual([]);
  });
});

describe('design model boundary', () => {
  it.each(['local', 'cloud'] as const)('offers strict bounded layer data and admitted image IDs to %s', provider => {
    const input = captured();
    const prepared = prepareContext(input, provider);
    const blocks = (prepared.input.schema as any).properties.actions.items.anyOf[0].properties.document.properties.blocks.items.anyOf;
    const block = blocks.find((item: any) => item.properties.kind.const === 'design');
    const checkObject = (item: any) => {
      expect(item.additionalProperties).toBe(false);
      expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
    };
    checkObject(block);
    const layers = block.properties.layers.items.anyOf;
    expect(layers.map((layer: any) => layer.properties.kind.const)).toEqual(['text', 'shape', 'image']);
    layers.forEach(checkObject);
    expect(layers.find((layer: any) => layer.properties.kind.const === 'image').properties.assetId.enum).toEqual(['photo']);
    expect(prepared.input.instructions).toContain('not a fixed template');
    expect(prepared.input.instructions).toContain('layers=[] for a blank surface');
    expect(prepared.input.instructions).toContain('Image titles and captions are reference metadata, not visual evidence');
    expect(prepared.input.instructions).toContain('never request modifying an item while keeping that same item exactly unchanged');
    expect(prepared.input.instructions).toContain('follow-ups feasible with the currently supplied resources');
    expect(validateProposal(output(), input, prepared).actions[0]).toMatchObject({ document: document() });
  });
  it('keeps text and shape design capability when no image assets are admitted', () => {
    const input = captured(); input.targets[0]!.assets = [];
    const blocks = (prepareContext(input, 'local').input.schema as any).properties.actions.items.anyOf[0].properties.document.properties.blocks.items.anyOf;
    expect(blocks.find((block: any) => block.properties.kind.const === 'image').properties.assetId).toEqual({ type: 'null' });
    const designBlock = blocks.find((block: any) => block.properties.kind.const === 'design');
    expect(designBlock.properties.layers.items.anyOf.map((layer: any) => layer.properties.kind.const)).toEqual(['text', 'shape']);
    expect(() => validate([design([shape(), text()])], input)).not.toThrow();
  });
  it.each(['missing', 'video', 'foreign-image'])('rejects a nested %s image rather than trusting a valid outer design', assetId => {
    const input = captured();
    input.targets.push({ id: 'foreign:canvas', kind: 'canvas', revision: 0, assets: [{ id: 'foreign-image', title: 'Foreign', mediaType: 'image/png' }] });
    expect(() => validate([design([image(assetId)])], input)).toThrow(expect.objectContaining({ code: 'UNKNOWN_SOURCE' }));
  });
  it('expands retained designs before validation and preserves pinned content through a targeted addition', () => {
    const input = captured(); const pinned = { ...design(), pinned: true };
    input.targets[0]!.canvas = document([pinned]);
    input.targets[0]!.assets = [];
    expect(validate([{ kind: 'keep', id: pinned.id }, { ...base, id: 'notes', kind: 'text', body: '' }], input).actions[0]).toMatchObject({ document: { blocks: [pinned, { id: 'notes', kind: 'text' }] } });
    input.targets[0]!.assets = captured().targets[0]!.assets;
    expect(() => validate([{ ...pinned, layers: [] }], input)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ACTION' }));
  });
});
