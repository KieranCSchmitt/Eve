import { describe, expect, it } from 'vitest';
import { canvasBlockSchema, compileCanvasSuggestion, normalizedImageAdjustments, type CanvasBlock, type CanvasDocument } from '../../packages/contracts/src/index';
import { createAgentService, prepareContext, routeRegisteredIntent, validateProposal, type AgentRequest } from '../../packages/agent/src/index';
import { applyCanvasPatch } from '../../packages/agent/src/canvas-patches';
import { fakeProvider, proposal, request } from './fixtures';

const writing: CanvasBlock = { id: 'writing', kind: 'text', title: 'Draft', body: 'My own writing.', placement: 'main', pinned: true, sourceIds: [] };
const slot = (): Extract<CanvasBlock, { kind: 'image' }> => ({ id: 'photo-slot', kind: 'image', title: 'Photo', caption: 'My caption.', placement: 'aside', pinned: false, sourceIds: [], assetId: null });
const document = (blocks: CanvasBlock[] = [writing]): CanvasDocument => ({ version: 1, title: 'My space', subtitle: '', layout: 'split', blocks, suggestions: [] });
const captured = (canvas = document(), assets: NonNullable<AgentRequest['targets'][number]['assets']> = []): AgentRequest => {
  const input = request({ role: 'prepare', sources: [], targets: [{ id: 'orbit:canvas', kind: 'canvas', revision: 7, canvas, assets }] });
  input.intent.text = 'Prepare useful next choices without changing current work.';
  return input;
};
const actions = (input: AgentRequest) => (prepareContext(input, 'local').input.schema as any).properties.actions.items.anyOf;
const choices = (input: AgentRequest) => actions(input).find((action: any) => action.properties.type.const === 'ComposeCanvas').properties.document.properties.blocks.items.anyOf;
const validate = (canvas: unknown, input = captured()): CanvasDocument => {
  const result = validateProposal({ ...proposal({ basis: 'general', citations: [] }), actions: [{ type: 'ComposeCanvas', targetId: 'orbit:canvas', expectedRevision: 7, document: canvas }] }, input, prepareContext(input, 'local'));
  const action = result.actions[0]; if (action?.type !== 'ComposeCanvas') throw new Error('Expected canvas'); return action.document;
};
const future = (block: unknown = slot()) => ({ id: 'add-photo-slot', label: 'Add an empty image slot', description: 'Choose or import an image after keeping the slot.', request: 'Add an empty image slot without changing my writing.', targetBlockId: null, prepared: { edits: [{ type: 'add', block }], arrangement: null } });
const asset = { id: 'original', title: 'User-selected image', mediaType: 'image/jpeg' };

describe('empty image slots in the constrained provider schema', () => {
  it.each(['local', 'cloud'] as const)('admits only null whole images and excludes unavailable nested image layers for %s', provider => {
    const input = captured(), schema = prepareContext(input, provider).input.schema as any;
    const found: any[] = [];
    const visit = (node: any) => { if (!node || typeof node !== 'object') return; if (node.properties?.kind?.const === 'image') found.push(node); Object.values(node).forEach(visit); };
    visit(schema);
    expect(found.length).toBeGreaterThan(1); // current and future blocks
    for (const image of found) {
      expect(image.properties).toHaveProperty('caption');
      expect(image.properties.assetId).toEqual({ type: 'null' });
      expect(image.properties.adjustments).toEqual({ type: 'null' });
      expect(image.additionalProperties).toBe(false);
      expect(image.required).toContain('assetId'); expect(image.required).toContain('adjustments');
    }
  });
  it('allows null or admitted image IDs on whole images while nested layers stay non-null', () => {
    const input = captured(document(), [asset, { id: 'text-file', title: 'Text', mediaType: 'text/plain' }]);
    const blocks = choices(input), image = blocks.find((block: any) => block.properties.kind.const === 'image');
    expect(image.properties.assetId).toEqual({ anyOf: [{ type: 'string', enum: ['original'] }, { type: 'null' }] });
    const design = blocks.find((block: any) => block.properties.kind.const === 'design');
    expect(design.properties.layers.items.anyOf.find((layer: any) => layer.properties.kind.const === 'image').properties.assetId).toEqual({ type: 'string', enum: ['original'] });
  });
  it('offers an empty image plan during restricted refresh without granting attachment authority', () => {
    const input = captured(); input.canvasSuggestionRefresh = { targetId: 'orbit:canvas', canvasRevision: 7 };
    const response = { ...proposal({ basis: 'general', citations: [] }), actions: [{ type: 'PatchCanvas', targetId: 'orbit:canvas', expectedRevision: 7, edits: [], suggestions: [future()] }] };
    const result = validateProposal(response, input, prepareContext(input, 'local'));
    const action = result.actions[0]; if (action?.type !== 'ComposeCanvas') throw new Error('Expected canvas');
    expect(action.document.blocks).toEqual([writing]);
    expect(action.document.suggestions![0]!.prepared!.before).toEqual([]);
    expect(compileCanvasSuggestion(action.document, 'add-photo-slot', { assetIds: [], sourceIds: [] }).blocks).toEqual([writing, slot()]);
    expect((prepareContext(input, 'local').input.schema as any).properties.actions.items.anyOf.map((branch: any) => branch.properties.type.const)).toEqual(['PatchCanvas']);
  });
});

describe('empty image authority and canonical expansion', () => {
  it('adds an empty image to current or prepared composition without inventing an asset', () => {
    expect(validate(document([writing, slot()])).blocks).toEqual([writing, slot()]);
    const result = validate({ ...document(), suggestions: [future()] });
    expect(result.suggestions![0]!.prepared!.edits).toEqual([{ type: 'add', block: slot() }]);
  });
  it.each(['invented', 'text-file', 'foreign'])('refuses non-null %s identities even though the empty image alternative exists', assetId => {
    const input = captured(document(), [{ id: 'text-file', title: 'Text', mediaType: 'text/plain' }]);
    input.targets.push({ id: 'other:canvas', kind: 'canvas', revision: 0, assets: [{ ...asset, id: 'foreign' }] });
    expect(() => validate(document([writing, { ...slot(), assetId }]), input)).toThrow(/not attached/i);
    expect(() => validate({ ...document(), suggestions: [future({ ...slot(), assetId })] }, input)).toThrow(/not attached/i);
  });
  it('permits an admitted attachment patch without changing caption, identity or surrounding pinned work', () => {
    const initial = document([writing, slot()]), input = captured(initial, [asset]);
    const changed = validate({ ...initial, blocks: [{ kind: 'keep', id: writing.id }, { kind: 'patch', id: slot().id, changes: [{ type: 'set', target: null, field: 'assetId', value: asset.id }] }] }, input);
    expect(changed.blocks).toEqual([writing, { ...slot(), assetId: asset.id }]);
    expect(initial).toEqual(document([writing, slot()]));
  });
  it('refuses model attachment to a pinned slot while ordinary canonical data can represent the user action', () => {
    const pinned = { ...slot(), pinned: true }, attached = { ...pinned, assetId: asset.id }, input = captured(document([writing, pinned]), [asset]);
    expect(canvasBlockSchema.parse(attached)).toEqual(attached);
    expect(() => validate(document([writing, attached]), input)).toThrow(/unpin/i);
    expect(() => applyCanvasPatch(pinned, { id: pinned.id, changes: [{ type: 'set', target: null, field: 'assetId', value: asset.id }] })).toThrow(/unpin/i);
  });
  it('rejects settings on an empty image even if another field changes and neutral settings would otherwise disappear', () => {
    for (const adjustments of [normalizedImageAdjustments(), { ...normalizedImageAdjustments(), brightness: 1.2 }]) {
      expect(() => validate(document([writing, { ...slot(), adjustments }]))).toThrow(/attach an image/i);
      expect(() => applyCanvasPatch(slot(), { id: slot().id, changes: [{ type: 'adjust-image', adjustments }, { type: 'set', target: null, field: 'caption', value: 'Changed' }] })).toThrow(/attach an image/i);
    }
  });
  it.each([false, true])('clears an attached image and its settings atomically regardless of patch order (%s)', reverse => {
    const changes = [{ type: 'set', target: null, field: 'assetId', value: null }, { type: 'adjust-image', adjustments: null }];
    if (reverse) changes.reverse();
    for (const settings of [normalizedImageAdjustments(), { ...normalizedImageAdjustments(), brightness: 1.2 }]) {
      const attached = { ...slot(), assetId: asset.id, adjustments: settings };
      expect(applyCanvasPatch(attached, { id: attached.id, changes })).toEqual({ ...slot(), adjustments: null });
      expect(() => applyCanvasPatch(attached, { id: attached.id, changes: [{ type: 'set', target: null, field: 'assetId', value: null }] })).toThrow(/attach an image/i);
    }
  });
  it('still rejects null IDs in inserted or patched design image layers', () => {
    const layer = { id: 'picture', kind: 'image', name: 'Picture', x: 0, y: 0, width: 100, height: 100, assetId: asset.id, fit: 'contain' };
    const design = canvasBlockSchema.parse({ id: 'art', kind: 'design', title: 'Art', placement: 'main', pinned: false, sourceIds: [], width: 400, height: 400, background: '#ffffff', layers: [layer] });
    expect(() => applyCanvasPatch(design, { id: design.id, changes: [{ type: 'set', target: { collection: 'layers', id: layer.id }, field: 'assetId', value: null }] })).toThrow();
    expect(() => applyCanvasPatch(design, { id: design.id, changes: [{ type: 'insert', collection: 'layers', afterId: null, item: { ...layer, id: 'new', assetId: null } }] })).toThrow(/invalid canvas patch/i);
  });
});

describe('explicit local image-tool creation', () => {
  it.each(['Add an image', 'Add a blank image slot', 'Please create an empty photo block', 'Insert a picture here'])('routes the whole request %j to a real empty slot without inference', async text => {
    const input = captured(); input.intent.text = text;
    const provider = fakeProvider('local'), service = createAgentService({ providers: [provider.provider], isCurrent: () => true });
    try {
      const result = await service.request(input);
      expect(result).toMatchObject({ status: 'complete', origin: 'registered-command', actions: [{ type: 'ComposeCanvas', document: { blocks: [writing, { kind: 'image', assetId: null, caption: '' }] } }] });
      expect(provider.generate).not.toHaveBeenCalled();
    } finally { service.dispose(); }
  });
  it.each(['Add an image of a cedar tree', 'Import /private/photo.jpg', 'Add an image and rewrite my text', 'Crop my image', 'Generate a photo'])('does not mistake %j for blank tool creation', text => {
    const input = captured(); input.intent.text = text;
    expect(routeRegisteredIntent(input)).toBeNull();
  });
  it('does not choose an admitted asset automatically and keeps refresh model-only', () => {
    const input = captured(document(), [asset]); input.intent.text = 'Add an image';
    expect(routeRegisteredIntent(input)).toMatchObject([{ document: { blocks: [writing, { assetId: null }] } }]);
    input.canvasSuggestionRefresh = { targetId: 'orbit:canvas', canvasRevision: 7 };
    expect(routeRegisteredIntent(input)).toBeNull();
  });
  it('does not let an empty-image addition authorize rewriting unpinned authored work', () => {
    const authored = { ...writing, pinned: false }, input = captured(document([authored]));
    input.intent.text = 'Add a blank image slot with room for a caption';
    expect(routeRegisteredIntent(input)).toBeNull();
    expect(() => validate(document([{ ...authored, body: 'An unsolicited rewrite.' }, slot()]), input)).toThrow(/preserv|unchanged/i);
    expect(validate(document([authored, slot()]), input).blocks).toEqual([authored, slot()]);
  });
});
