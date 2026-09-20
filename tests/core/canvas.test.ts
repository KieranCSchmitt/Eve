import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreStore, type CoreRelocationOptions } from '../../packages/core/src/index';
import { ALL_CAPABILITIES, compileCanvasSuggestion, numericCanvasCell, normalizedImageAdjustments, type AuthenticatedContext, type CanvasDocument, type CoreCommandInput, type DispatchResult } from '../../packages/contracts/src/index';

const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const must = (value: DispatchResult) => { expect(value.ok, JSON.stringify(value)).toBe(true); if (!value.ok) throw new Error(value.error.message); return value; };
const rejected = (value: DispatchResult, code: string) => { expect(value.ok).toBe(false); if (!value.ok) expect(value.error.code).toBe(code); };
let directory: string, profile: string, dbPath: string, core: CoreStore, sequence = 0;
const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
const item = (id: string) => ({ id, title: id, placement: 'main' as const, pinned: false, sourceIds: [] as string[] });
const document = (title = 'Coast weekend'): CanvasDocument => ({ version: 1, title, subtitle: 'Keep the useful details together.', layout: 'split', blocks: [
  { ...item('intro'), kind: 'text', body: 'A quiet afternoon by the sea.' },
  { ...item('packing'), kind: 'checklist', placement: 'aside', pinned: true, items: [{ id: 'camera', label: 'Pack the camera', checked: true }] },
  { ...item('budget'), kind: 'table', columns: ['Item', 'Cost'], rows: [{ id: 'lunch', cells: ['Lunch', '$12'] }, { id: 'total', cells: ['Total', '=B1*2'] }] },
  { ...item('plan'), kind: 'timeline', date: 'Saturday', startHour: 9, endHour: 18, items: [{ id: 'walk', title: 'Photo walk', startMinutes: 600, endMinutes: 660, status: 'suggested', detail: 'Meet by the river.' }] },
  { ...item('tea'), kind: 'timer', durationSeconds: 480, remainingSeconds: 460, endsAt: 2_000_000_000_000 },
  { ...item('notebook'), kind: 'note', description: 'Keep the original writing here.' },
] });
const update = (value = document(), overrides: Partial<Extract<CoreCommandInput, { type: 'UpdateCanvas' }>> = {}): Extract<CoreCommandInput, { type: 'UpdateCanvas' }> => ({ type: 'UpdateCanvas', requestId: `canvas-${++sequence}`, taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: task().canvas?.revision ?? 0, document: value, ...overrides });

function references() {
  for (const [id, owner, mediaType] of [['image', 'orbit', 'image/png'], ['foreign-image', 'photo-walk', 'image/png'], ['text', 'orbit', 'text/plain']] as const) {
    expect(core.registerAsset({ id, taskId: owner, title: id, originalPath: path.join(directory, `${id}.original`), managedPath: path.join(profile, 'assets', id, 'original'), sha256: hash(id), byteLength: Buffer.byteLength(id), mediaType, provenance: { kind: 'user-import', attribution: 'Selected test original', rights: 'Original work' } }, auth).ok).toBe(true);
  }
  for (const [id, owner] of [['source', 'orbit'], ['foreign-source', 'photo-walk']] as const) {
    expect(core.registerSource({ id, taskId: owner, title: id, url: 'https://example.com/reference', excerpt: 'A saved reference.', retrievedAt: 100, provenance: { kind: 'web-source', attribution: 'Saved link', rights: 'Reference only' } }, auth).ok).toBe(true);
  }
}
const withImage = (assetId = 'image', sourceId = 'source'): CanvasDocument => ({ ...document(), blocks: [...document().blocks, { ...item('photo'), kind: 'image', assetId, caption: 'Original preserved', sourceIds: [sourceId] }] });
const withLinkedVisuals = (): CanvasDocument => ({ ...withImage(), blocks: [...withImage().blocks,
  { ...item('cost-chart'), kind: 'chart', pinned: true, tableId: 'budget', chartType: 'bar', labelColumn: 0, valueColumns: [1] },
  { ...item('total-cost'), kind: 'metric', pinned: true, tableId: 'budget', rowId: 'total', column: 1, prefix: '$', suffix: '', decimals: 2 },
] });
const withDesign = (assetId = 'image'): CanvasDocument => ({ ...document(), blocks: [...document().blocks,
  { ...item('invitation'), kind: 'design', width: 480, height: 640, background: '#fffAf0', sourceIds: ['source'], layers: [
    { id: 'photo', name: 'Imported photograph', kind: 'image', x: 0, y: 0, width: 480, height: 640, assetId, fit: 'cover' },
    { id: 'panel', name: 'Title panel', kind: 'shape', x: 20, y: 20, width: 440, height: 150, shape: 'rectangle', fill: '#ffffff' },
    { id: 'heading', name: 'Heading', kind: 'text', x: 40, y: 30, width: 400, height: 120, text: 'Photo walk', fontFamily: 'serif', fontSize: 60, fontWeight: 'medium', color: '#182130', align: 'left' },
  ] },
] });
const withPreparedText = (): CanvasDocument => ({ ...document(), suggestions: [{ id: 'shorter', label: 'Make it concise', description: 'Review a shorter opening.', request: 'Shorten the opening.', targetBlockId: 'intro', prepared: {
  edits: [{ type: 'replace', block: { ...item('intro'), kind: 'text', body: 'An afternoon by the sea.' } }], before: [document().blocks[0]!],
} }] });
const withPreparedDesign = (): CanvasDocument => {
  const current = withDesign(), original = current.blocks.at(-1)!;
  return { ...current, suggestions: [{ id: 'design-choice', label: 'A quieter title', description: 'Review the new title.', request: 'Change the design title.', targetBlockId: original.id,
    prepared: { edits: [{ type: 'replace', block: { ...structuredClone(original), title: 'Quiet coast' } }], before: [structuredClone(original)] },
  }] };
};
function firstBlockEdit(value: CanvasDocument) {
  const edit = value.suggestions![0]!.prepared!.edits[0]!;
  if (!('block' in edit)) throw new Error('This fixture requires an added or replaced block.');
  return edit;
}
async function backup(): Promise<CoreRelocationOptions> {
  const stage = path.join(directory, 'stage'); mkdirSync(stage, { mode: 0o700 });
  await core.backupDatabase(path.join(stage, 'eve.db'));
  const bytes = readFileSync(path.join(stage, 'eve.db'));
  return { stagingProfile: stage, destinationProfile: path.join(directory, 'restored'), originalProfileRoot: profile, expectedSchemaVersion: 6, includedFiles: [
    { path: 'eve.db', bytes: bytes.length, sha256: hash(bytes) },
    ...['image', 'foreign-image', 'text'].flatMap(id => [{ path: `assets/${id}/original`, bytes: Buffer.byteLength(id), sha256: hash(id) }, { path: `assets/${id}/manifest.json`, bytes: 2, sha256: hash('{}') }]),
  ], includedDirectories: [] };
}
function refreshBackupHash(input: CoreRelocationOptions) {
  const bytes = readFileSync(path.join(input.stagingProfile, 'eve.db'));
  input.includedFiles = [{ path: 'eve.db', bytes: bytes.length, sha256: hash(bytes) }, ...input.includedFiles.slice(1)];
}
beforeEach(() => {
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'eve-canvas-'));
  profile = path.join(directory, 'profile'); mkdirSync(profile, { mode: 0o700 });
  dbPath = path.join(profile, 'eve.db'); core = new CoreStore({ dbPath });
});
afterEach(() => { core.close(); rmSync(directory, { recursive: true, force: true }); });

it('persists a complete composition, leaves the note intact, and acknowledges an exact retry only once after restart', () => {
  references(); const note = task().note; const command = update(withImage());
  const first = must(core.dispatch(command, auth));
  expect(task().canvas).toMatchObject({ document: command.document, revision: 1 });
  expect(task().note).toEqual(note);
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.document).toEqual(command.document);
  const retry = must(core.dispatch(command, auth));
  expect(retry.idempotent).toBe(true); expect(retry.operation.id).toBe(first.operation.id);
  expect(task().canvas?.revision).toBe(1);
  rejected(core.dispatch({ ...command, document: document('Different content') }, auth), 'IDEMPOTENCY_CONFLICT');
  expect(task().canvas?.document).toEqual(command.document);
});

it('persists reversible photo settings through restart and Undo while retaining the original asset record', () => {
  references(); const original=withImage(); must(core.dispatch(update(original),auth));
  const beforeAssets=core.listAssets('orbit');
  const settings={...normalizedImageAdjustments(),brightness:1.12,contrast:1.07,straighten:-2,crop:{left:0.1,top:0.05,right:0.9,bottom:0.95}};
  const next={...original,blocks:original.blocks.map(block=>block.kind==='image'?{...block,adjustments:settings}:block)};
  const applied=must(core.dispatch(update(next),auth));
  core.close(); core=new CoreStore({dbPath});
  expect(task().canvas!.document).toEqual(next);
  expect(core.listAssets('orbit')).toEqual(beforeAssets);
  must(core.dispatch({type:'Undo',requestId:'undo-photo-settings',taskId:'orbit',expectedEpoch:task().epoch,operationId:applied.operation.id},auth));
  expect(task().canvas!.document).toEqual(original);
  expect(core.listAssets('orbit')).toEqual(beforeAssets);
});

it('rejects invalid photo settings in current and dormant prepared blocks without a partial save', () => {
  references(); const original=withImage(); must(core.dispatch(update(original),auth));
  const photo=original.blocks.find(block=>block.kind==='image')!;
  const bad={...photo,adjustments:{...normalizedImageAdjustments(),crop:{left:0.8,top:0,right:0.2,bottom:1}}};
  const revision=task().canvas!.revision;
  rejected(core.dispatch(update({...original,blocks:original.blocks.map(block=>block.id===photo.id?bad:block)}),auth),'INVALID_COMMAND');
  rejected(core.dispatch(update({...original,suggestions:[{id:'crop',label:'Crop',description:'',request:'Review a crop.',targetBlockId:photo.id,prepared:{before:[photo],edits:[{type:'replace',block:bad}]}}]}),auth),'INVALID_COMMAND');
  expect(task().canvas).toMatchObject({document:original,revision});
});

it('persists prepared removal and arrangement through restart, backup and Undo without removing the managed original', async () => {
  references(); const current = withImage(), photo = current.blocks.at(-1)!;
  const seed: CanvasDocument = { ...current, suggestions: [{ id: 'more-room', label: 'Make more room', description: 'Remove this photo card and arrange the remaining work in a gallery.', request: 'Remove the photo card and reverse the remaining items in a gallery.', targetBlockId: photo.id, prepared: {
    edits: [{ type: 'remove', id: photo.id }], before: [photo],
    arrangement: { layout: 'gallery', order: current.blocks.filter(block => block.id !== photo.id).map(block => block.id).reverse() },
    beforeArrangement: { layout: current.layout, blocks: current.blocks.map(({ id, placement }) => ({ id, placement })) },
  } }] };
  must(core.dispatch(update(seed), auth)); const originalAssets = core.listAssets('orbit');
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas!.document).toEqual(seed);
  const candidate = compileCanvasSuggestion(task().canvas!.document!, 'more-room', { assetIds: ['image'], sourceIds: ['source'] });
  expect(candidate.blocks).toEqual([...document().blocks].reverse()); expect(candidate.layout).toBe('gallery');
  const kept = must(core.dispatch(update(candidate), auth));
  expect(core.listAssets('orbit')).toEqual(originalAssets);
  const input = await backup(); await CoreStore.relocateDatabase(input);
  const restored = new CoreStore({ dbPath: path.join(input.stagingProfile, 'eve.db') });
  try {
    const saved = restored.snapshot().tasks.find(item => item.id === 'orbit')!;
    expect(saved.canvas!.document).toEqual(candidate);
    must(restored.dispatch({ type: 'Undo', requestId: 'restore-arrangement', taskId: 'orbit', expectedEpoch: saved.epoch, operationId: kept.operation.id }, auth));
    expect(restored.snapshot().tasks.find(item => item.id === 'orbit')!.canvas!.document).toEqual(seed);
    expect(restored.listAssets('orbit').find(asset => asset.id === 'image')).toBeDefined();
  } finally { restored.close(); }
});

it('retains stale arrangement snapshots through save and relocation without blocking newer user placement or typing', async () => {
  references(); const current = document();
  const seed: CanvasDocument = { ...current, suggestions: [{ id: 'gallery', label: 'See everything together', description: '', request: 'Review a gallery.', targetBlockId: null, prepared: {
    edits: [], before: [], arrangement: { layout: 'gallery', order: current.blocks.map(block => block.id) },
    beforeArrangement: { layout: current.layout, blocks: current.blocks.map(({ id, placement }) => ({ id, placement })) },
  } }] };
  must(core.dispatch(update(seed), auth));
  const changed: CanvasDocument = { ...seed, blocks: seed.blocks.map(block => block.id === 'intro' && block.kind === 'text' ? { ...block, placement: 'full', body: 'My newer writing and placement.' } : block) };
  must(core.dispatch(update(changed), auth));
  expect(() => compileCanvasSuggestion(changed, 'gallery')).toThrow(/arrangement|layout|changed/i);
  const input = await backup(); await CoreStore.relocateDatabase(input);
  const restored = new CoreStore({ dbPath: path.join(input.stagingProfile, 'eve.db') });
  try {
    const saved = restored.snapshot().tasks.find(item => item.id === 'orbit')!.canvas!.document!;
    expect(saved).toEqual(changed);
    expect(() => compileCanvasSuggestion(saved, 'gallery')).toThrow(/arrangement|layout|changed/i);
  } finally { restored.close(); }
});

it('rejects new incomplete arrangement and destructive linked removal plans atomically at the core boundary', () => {
  references(); const current = withLinkedVisuals(); must(core.dispatch(update(current), auth));
  const original = task().canvas;
  for (const prepared of [
    { edits: [], before: [], arrangement: { layout: 'gallery', order: ['intro'] }, beforeArrangement: { layout: current.layout, blocks: current.blocks.map(({ id, placement }) => ({ id, placement })) } },
    { edits: [], before: [], arrangement: { layout: 'gallery', order: current.blocks.map(block => block.id) } },
    { edits: [{ type: 'remove', id: 'budget' }], before: [current.blocks.find(block => block.id === 'budget')!] },
    { edits: [{ type: 'remove', id: 'packing' }], before: [current.blocks.find(block => block.id === 'packing')!] },
  ]) {
    const invalid = { ...current, suggestions: [{ id: 'invalid', label: 'Invalid review', description: '', request: 'Review the change.', targetBlockId: null, prepared }] } as CanvasDocument;
    rejected(core.dispatch(update(invalid), auth), 'INVALID_COMMAND');
    expect(task().canvas).toEqual(original);
  }
});

it('undoes the first canvas to an empty saved state and restores prior versions without losing notes', () => {
  const note = task().note;
  const first = must(core.dispatch(update(), auth));
  must(core.dispatch({ type: 'Undo', requestId: 'undo-first', taskId: 'orbit', expectedEpoch: task().epoch, operationId: first.operation.id }, auth));
  expect(task().canvas).toMatchObject({ document: null, revision: 2 }); expect(task().note).toEqual(note);
  must(core.dispatch(update(document('First kept canvas')), auth));
  const second = must(core.dispatch(update(document('Second canvas')), auth));
  must(core.dispatch({ type: 'Undo', requestId: 'undo-second', taskId: 'orbit', expectedEpoch: task().epoch, operationId: second.operation.id }, auth));
  expect(task().canvas).toMatchObject({ document: document('First kept canvas'), revision: 5 });
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.revision).toBe(5); expect(task().note).toEqual(note);
});

it('persists suggestions as passive canvas data across restart, revision changes and undo', () => {
  const note = task().note;
  const value: CanvasDocument = { ...document(), suggestions: [{ id: 'checklist', label: 'Finish packing', description: 'Add the remaining essentials.', request: 'Add missing essentials to the packing checklist.', targetBlockId: 'packing' }] };
  must(core.dispatch(update(value), auth));
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.document).toEqual(value);
  expect(task().note).toEqual(note);
  const change = must(core.dispatch(update({ ...value, suggestions: [] }), auth));
  must(core.dispatch({ type: 'Undo', requestId: 'undo-suggestions', taskId: 'orbit', expectedEpoch: task().epoch, operationId: change.operation.id }, auth));
  expect(task().canvas?.document).toEqual(value);
});

it('persists a prepared review without applying it, then keeps exactly once and restores it through Undo after restart', () => {
  const value = withPreparedText(); must(core.dispatch(update(value), auth));
  expect(task().canvas?.document?.blocks[0]).toEqual(document().blocks[0]);
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.document).toEqual(value);
  const candidate = compileCanvasSuggestion(task().canvas!.document!, 'shorter', { assetIds: [], sourceIds: [] });
  const command = update(candidate), kept = must(core.dispatch(command, auth));
  expect(task().canvas).toMatchObject({ document: candidate, revision: 2 });
  expect(must(core.dispatch(command, auth))).toMatchObject({ idempotent: true, operation: { id: kept.operation.id } });
  core.close(); core = new CoreStore({ dbPath });
  must(core.dispatch({ type: 'Undo', requestId: 'undo-prepared', taskId: 'orbit', expectedEpoch: task().epoch, operationId: kept.operation.id }, auth));
  expect(task().canvas).toMatchObject({ document: value, revision: 3 });
});

it('saves newer local writing and metadata-only changes without rebasing or executing its now-stale prepared choice', () => {
  const value = withPreparedText(); must(core.dispatch(update(value), auth));
  const edited: CanvasDocument = { ...value, blocks: value.blocks.map(block => block.kind === 'text' ? { ...block, body: 'My newer local writing.' } : block) };
  must(core.dispatch(update(edited), auth));
  const renamed: CanvasDocument = { ...edited, suggestions: edited.suggestions!.map(suggestion => ({ ...suggestion, label: 'Review shorter text', description: 'A shorter option for this writing.' })) };
  must(core.dispatch(update(renamed), auth));
  expect(task().canvas?.document).toEqual(renamed);
  expect(task().canvas?.document?.suggestions?.[0]?.prepared?.before).toEqual([document().blocks[0]]);
  expect(() => compileCanvasSuggestion(task().canvas!.document!, 'shorter')).toThrow('changed');
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.document).toEqual(renamed);
});

it.each(['stale', 'no-op', 'pinned', 'outside-target', 'missing-link', 'started-timer', 'invalid-formula'] as const)('rejects a new %s prepared plan before canvas or history writes', kind => {
  const value = withPreparedText(), suggestion = value.suggestions![0]!, plan = suggestion.prepared!;
  if (kind === 'stale') plan.before[0] = { ...item('intro'), kind: 'text', body: 'A different original.' };
  if (kind === 'no-op') firstBlockEdit(value).block = structuredClone(plan.before[0]!);
  if (kind === 'pinned') { plan.before = [value.blocks[1]!]; plan.edits = [{ type: 'replace', block: { ...value.blocks[1]!, title: 'A changed title' } }]; suggestion.targetBlockId = 'packing'; }
  if (kind === 'outside-target') suggestion.targetBlockId = 'budget';
  if (kind === 'missing-link') { plan.edits = [{ type: 'add', block: { ...item('figure'), kind: 'metric', tableId: 'absent', rowId: null, column: 0, prefix: '', suffix: '', decimals: 0 } }]; plan.before = []; }
  if (kind === 'started-timer') { plan.edits = [{ type: 'add', block: { ...item('running'), kind: 'timer', durationSeconds: 60, remainingSeconds: 60, endsAt: 2_000_000_000_000 } }]; plan.before = []; }
  if (kind === 'invalid-formula') { plan.edits = [{ type: 'add', block: { ...item('bad-table'), kind: 'table', columns: ['Number'], rows: [{ id: 'cycle', cells: ['=A1'] }] } }]; plan.before = []; }
  const before = core.snapshot();
  rejected(core.dispatch(update(value), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('checks a changed prepared edit even when its identity and target are retained', () => {
  const original = withPreparedText(); must(core.dispatch(update(original), auth));
  const changed = structuredClone(original); firstBlockEdit(changed).block = document().blocks[0]!;
  const before = core.snapshot(); rejected(core.dispatch(update(changed), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('revalidates a changed saved selection descriptor even when the prepared edit is byte-identical', () => {
  const original = withPreparedText();
  original.suggestions![0]!.textSelection = { field: 'body', start: 0, end: 7, text: 'A quiet' };
  must(core.dispatch(update(original), auth));
  const changed = structuredClone(original);
  changed.suggestions![0]!.textSelection = { field: 'body', start: 24, end: 28, text: ' sea' };
  const before = core.snapshot();
  rejected(core.dispatch(update(changed), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('preserves selected-passage authority through SQLite reopen, prepared Keep, Undo and later authored edits', () => {
  const value = withPreparedText();
  value.suggestions![0]!.textSelection = { field: 'body', start: 0, end: 7, text: 'A quiet' };
  must(core.dispatch(update(value), auth));
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas!.document).toEqual(value);
  const candidate = compileCanvasSuggestion(task().canvas!.document!, 'shorter');
  expect(candidate.blocks[0]).toMatchObject({ body: 'An afternoon by the sea.' });
  const kept = must(core.dispatch(update(candidate), auth));
  must(core.dispatch({ type: 'Undo', requestId: 'undo-selected-passage', taskId: 'orbit', expectedEpoch: task().epoch, operationId: kept.operation.id }, auth));
  expect(task().canvas!.document).toEqual(value);
  const edited = { ...value, blocks: value.blocks.map(block => block.kind === 'text' ? { ...block, body: 'A quiet afternoon by my chosen sea.' } : block) };
  must(core.dispatch(update(edited), auth));
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas!.document).toEqual(edited);
  expect(() => compileCanvasSuggestion(task().canvas!.document!, 'shorter')).toThrow(/changed/);
});

it.each(['edits', 'before'] as const)('rejects unauthorized nested assets in dormant prepared %s', location => {
  references(); const original = withPreparedDesign();
  const block = location === 'edits' ? firstBlockEdit(original).block : original.suggestions![0]!.prepared!.before[0]!;
  if (block.kind === 'design' && block.layers[0]?.kind === 'image') block.layers[0].assetId = 'foreign-image';
  const before = core.snapshot(), result = core.dispatch(update(original), auth);
  rejected(result, 'INVALID_COMMAND'); if (!result.ok) expect(result.error.message).toContain('image');
  expect(core.snapshot()).toEqual(before);
});

it('rejects a dangling suggestion target without writing canvas state or history', () => {
  const before = core.snapshot();
  const value: CanvasDocument = { ...document(), suggestions: [{ id: 'unknown', label: 'Keep going', description: '', request: 'Add a checklist.', targetBlockId: 'absent' }] };
  rejected(core.dispatch(update(value), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('persists an unconfigured deadline, saves an absolute due date across restart, and undoes the date independently', () => {
  const blank: CanvasDocument = { ...document(), blocks: [
    { ...item('essay'), kind: 'text', body: '' },
    { ...item('due'), title: 'Essay due', kind: 'deadline', placement: 'aside', dueAt: null },
  ] };
  must(core.dispatch(update(blank), auth));
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.document).toEqual(blank);
  const dated: CanvasDocument = { ...blank, blocks: blank.blocks.map(block => block.kind === 'deadline' ? { ...block, dueAt: Date.UTC(2027, 3, 10, 17) } : block) };
  const dateChange = must(core.dispatch(update(dated), auth));
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.document).toEqual(dated);
  must(core.dispatch({ type: 'Undo', requestId: 'undo-deadline-date', taskId: 'orbit', expectedEpoch: task().epoch, operationId: dateChange.operation.id }, auth));
  expect(task().canvas?.document).toEqual(blank);
});

it.each([-1, 253402300800000, 1.5])('rejects an invalid absolute deadline (%s) without creating history', (dueAt) => {
  const before = core.snapshot();
  const invalid: CanvasDocument = { ...document(), blocks: [{ ...item('due'), kind: 'deadline', dueAt }] };
  rejected(core.dispatch(update(invalid), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('rejects stale revisions and stale undo without overwriting a newer composition', () => {
  const oldCommand = update(); const first = must(core.dispatch(oldCommand, auth));
  const newer = document('The latest plan'); must(core.dispatch(update(newer), auth));
  const before = core.snapshot();
  rejected(core.dispatch({ ...oldCommand, requestId: 'stale-save' }, auth), 'REVISION_CONFLICT');
  rejected(core.dispatch({ type: 'Undo', requestId: 'stale-undo', taskId: 'orbit', expectedEpoch: task().epoch, operationId: first.operation.id }, auth), 'REVISION_CONFLICT');
  expect(core.snapshot()).toEqual(before);
});

it('requires canvas authority and rejects a result after its task or background job changes', () => {
  const command = update(); const before = core.snapshot();
  rejected(core.dispatch(command, { ...auth, capabilities: ['notes:write'] }), 'UNAUTHORIZED');
  rejected(core.dispatch(command, { ...auth, taskIds: ['photo-walk'] }), 'UNAUTHORIZED');
  expect(core.snapshot()).toEqual(before);
  expect(core.beginJob({ id: 'suggestion', taskId: 'orbit', taskEpoch: task().epoch, generation: 1, provider: 'local' }, auth).ok).toBe(true);
  expect(core.endJob('suggestion', 1, 'cancelled', auth).ok).toBe(true);
  rejected(core.dispatch({ ...command, jobToken: { id: 'suggestion', generation: 1 } }, auth), 'JOB_CANCELLED');
  must(core.dispatch({ type: 'RecallTask', requestId: 'switch', taskId: 'photo-walk' }, auth));
  rejected(core.dispatch(command, auth), 'STALE_EPOCH');
  expect(task().canvas).toBeNull();
});

it.each([
  ['missing image', 'missing-image', 'source'],
  ['another space’s image', 'foreign-image', 'source'],
  ['a text file used as an image', 'text', 'source'],
  ['missing source', 'image', 'missing-source'],
  ['another space’s source', 'image', 'foreign-source'],
])('refuses %s before writing any canvas or history', (_name, assetId, sourceId) => {
  references(); const before = core.snapshot();
  rejected(core.dispatch(update(withImage(assetId, sourceId)), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('backs up and relocates a saved composition and its undo history while preserving authored text and original reference IDs', async () => {
  references();
  const value = withImage(); value.blocks[0] = { ...item('intro'), kind: 'text', body: `Keep this literal path: ${profile}/assets/image/original` };
  const saved = must(core.dispatch(update(value), auth));
  const input = await backup(); const receipt = await CoreStore.relocateDatabase(input);
  expect(receipt.schemaVersion).toBe(6);
  const restored = new CoreStore({ dbPath: path.join(input.stagingProfile, 'eve.db') });
  try {
    const current = restored.snapshot().tasks.find(item => item.id === 'orbit')!;
    expect(current.canvas?.document).toEqual(value);
    expect(restored.listAssets('orbit').find(asset => asset.id === 'image')?.managedPath).toBe(path.join(input.destinationProfile, 'assets/image/original'));
    must(restored.dispatch({ type: 'Undo', requestId: 'restored-undo', taskId: 'orbit', expectedEpoch: current.epoch, operationId: saved.operation.id }, auth));
    expect(restored.snapshot().tasks.find(item => item.id === 'orbit')?.canvas).toMatchObject({ document: null, revision: 2 });
    expect(task().canvas?.document).toEqual(value);
  } finally { restored.close(); }
});

it('persists linked visuals and live table edits through restart, backup, relocation and restored Undo', async () => {
  references();
  const original = withLinkedVisuals();
  must(core.dispatch(update(original), auth));
  const revised: CanvasDocument = { ...original, blocks: original.blocks.map(block => block.kind === 'table' && block.id === 'budget' ? { ...block, rows: block.rows.map(row => row.id === 'lunch' ? { ...row, cells: ['Lunch', '$15'] } : row) } : block) };
  const change = must(core.dispatch(update(revised), auth));
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas?.document).toEqual(revised);
  const table = task().canvas!.document!.blocks.find(block => block.kind === 'table')!;
  if (table.kind !== 'table') throw new Error('Missing saved table.');
  expect(numericCanvasCell(table.rows, 1, 1)).toBe(30);
  const input = await backup();
  expect((await CoreStore.relocateDatabase(input)).schemaVersion).toBe(6);
  const restored = new CoreStore({ dbPath: path.join(input.stagingProfile, 'eve.db') });
  try {
    const current = restored.snapshot().tasks.find(item => item.id === 'orbit')!;
    expect(current.canvas?.document).toEqual(revised);
    must(restored.dispatch({ type: 'Undo', requestId: 'restore-linked-undo', taskId: 'orbit', expectedEpoch: current.epoch, operationId: change.operation.id }, auth));
    const undone = restored.snapshot().tasks.find(item => item.id === 'orbit')!.canvas!.document!;
    expect(undone).toEqual(original);
    const restoredTable = undone.blocks.find(block => block.kind === 'table')!;
    if (restoredTable.kind !== 'table') throw new Error('Missing restored table.');
    expect(numericCanvasCell(restoredTable.rows, 1, 1)).toBe(24);
    expect(task().canvas?.document).toEqual(revised);
  } finally { restored.close(); }
});

it('preserves nested design images, layer order and literal text through restart, backup, relocation and Undo', async () => {
  references(); const original = withDesign();
  must(core.dispatch(update(original), auth));
  const literal = `Keep this original reference: ${profile}/assets/image/original`;
  const revised: CanvasDocument = { ...original, blocks: original.blocks.map(block => block.kind === 'design'
    ? { ...block, layers: block.layers.map(layer => layer.kind === 'text' ? { ...layer, text: literal, fontSize: 24 } : layer) } : block) };
  const change = must(core.dispatch(update(revised), auth));
  core.close(); core = new CoreStore({ dbPath });
  expect(task().canvas).toMatchObject({ revision: 2, document: revised });
  const input = await backup();
  expect((await CoreStore.relocateDatabase(input)).schemaVersion).toBe(6);
  const restored = new CoreStore({ dbPath: path.join(input.stagingProfile, 'eve.db') });
  try {
    const current = restored.snapshot().tasks.find(item => item.id === 'orbit')!;
    expect(current.canvas?.document).toEqual(revised);
    expect(restored.listAssets('orbit').find(asset => asset.id === 'image')?.managedPath).toBe(path.join(input.destinationProfile, 'assets/image/original'));
    must(restored.dispatch({ type: 'Undo', requestId: 'restore-design-undo', taskId: 'orbit', expectedEpoch: current.epoch, operationId: change.operation.id }, auth));
    expect(restored.snapshot().tasks.find(item => item.id === 'orbit')!.canvas).toMatchObject({ revision: 3, document: original });
    expect(task().canvas?.document).toEqual(revised);
  } finally { restored.close(); }
});

it.each(['missing-image', 'foreign-image', 'text'])('rejects nested design asset %s before saving any canvas or history', assetId => {
  references(); const before = core.snapshot();
  rejected(core.dispatch(update(withDesign(assetId)), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it('rejects invalid design layer bounds at the core write boundary without history', () => {
  references(); const before = core.snapshot();
  const value = withDesign();
  const invalid: CanvasDocument = { ...value, blocks: value.blocks.map(block => block.kind === 'design'
    ? { ...block, layers: block.layers.map(layer => ({ ...layer, x: 480 })) } : block) };
  rejected(core.dispatch(update(invalid), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it.each(['canvas', 'before_json', 'after_json'].flatMap(location => ['missing-image', 'foreign-image', 'text'].map(assetId => [location, assetId])))('rejects nested design asset %s/%s in backup state and Undo history', async (location, assetId) => {
  references(); const original = withDesign();
  must(core.dispatch(update(original), auth));
  const later = must(core.dispatch(update({ ...original, title: 'A later design' }), auth));
  const input = await backup();
  const saved = new Database(path.join(input.stagingProfile, 'eve.db'));
  if (location === 'canvas') saved.prepare('UPDATE canvases SET value=? WHERE task_id=?').run(JSON.stringify(withDesign(assetId)), 'orbit');
  else saved.prepare(`UPDATE operations SET ${location}=? WHERE id=?`).run(JSON.stringify(withDesign(assetId)), later.operation.id);
  saved.close(); refreshBackupHash(input);
  await expect(CoreStore.relocateDatabase(input)).rejects.toMatchObject({ code: 'INVALID_DATABASE' });
  expect(task().canvas?.document).toEqual({ ...original, title: 'A later design' });
});

it('relocates an admitted but stale prepared plan without rebasing its saved originals', async () => {
  references(); const original = withPreparedDesign(); must(core.dispatch(update(original), auth));
  const edited: CanvasDocument = { ...original, blocks: original.blocks.map(block => block.kind === 'design' ? { ...block, title: 'My local design title' } : block) };
  must(core.dispatch(update(edited), auth));
  const input = await backup(); await CoreStore.relocateDatabase(input);
  const restored = new CoreStore({ dbPath: path.join(input.stagingProfile, 'eve.db') });
  try {
    const saved = restored.snapshot().tasks.find(item => item.id === 'orbit')!.canvas!.document!;
    expect(saved).toEqual(edited);
    expect(() => compileCanvasSuggestion(saved, 'design-choice')).toThrow('changed');
  } finally { restored.close(); }
});

it.each(['canvas', 'before_json', 'after_json'].flatMap(location => ['edits', 'before'].flatMap(nested => ['asset', 'source'].map(reference => [location, nested, reference]))))('rejects hidden %s/%s/%s references in backup and Undo history', async (location, nested, reference) => {
  references(); const original = withPreparedDesign(); must(core.dispatch(update(original), auth));
  const later = must(core.dispatch(update({ ...original, title: 'Later design' }), auth));
  const input = await backup(), invalid = structuredClone(original);
  const block = nested === 'edits' ? firstBlockEdit(invalid).block : invalid.suggestions![0]!.prepared!.before[0]!;
  if (reference === 'source') block.sourceIds = ['foreign-source'];
  else if (block.kind === 'design' && block.layers[0]?.kind === 'image') block.layers[0].assetId = 'foreign-image';
  const saved = new Database(path.join(input.stagingProfile, 'eve.db'));
  if (location === 'canvas') saved.prepare('UPDATE canvases SET value=? WHERE task_id=?').run(JSON.stringify(invalid), 'orbit');
  else saved.prepare(`UPDATE operations SET ${location}=? WHERE id=?`).run(JSON.stringify(invalid), later.operation.id);
  saved.close(); refreshBackupHash(input);
  await expect(CoreStore.relocateDatabase(input)).rejects.toMatchObject({ code: 'INVALID_DATABASE' });
  expect(task().canvas?.document?.title).toBe('Later design');
});

it.each(['table', 'row', 'foreign-table'] as const)('rejects stale %s bindings before writing a linked canvas or history', kind => {
  references(); const original = withLinkedVisuals(); must(core.dispatch(update(original), auth));
  const before = core.snapshot();
  const invalid: CanvasDocument = { ...original, blocks: original.blocks.flatMap(block => {
    if (kind === 'table' && block.id === 'budget') return [];
    if (kind === 'row' && block.kind === 'table') return [{ ...block, rows: block.rows.filter(row => row.id !== 'total') }];
    if (kind === 'foreign-table' && block.kind === 'chart') return [{ ...block, tableId: 'photo-walk:budget' }];
    return [block];
  }) };
  rejected(core.dispatch(update(invalid), auth), 'INVALID_COMMAND');
  expect(core.snapshot()).toEqual(before);
});

it.each(['canvas', 'before_json', 'after_json'] as const)('rejects dangling linked visual references in backed-up %s data', async location => {
  references(); const original = withLinkedVisuals(); must(core.dispatch(update(original), auth));
  const later = must(core.dispatch(update({ ...original, title: 'A later linked canvas' }), auth));
  const input = await backup();
  const invalid: CanvasDocument = { ...original, blocks: original.blocks.map(block => block.kind === 'metric' ? { ...block, rowId: 'deleted-row' } : block) };
  const saved = new Database(path.join(input.stagingProfile, 'eve.db'));
  if (location === 'canvas') saved.prepare('UPDATE canvases SET value=? WHERE task_id=?').run(JSON.stringify(invalid), 'orbit');
  else saved.prepare(`UPDATE operations SET ${location}=? WHERE id=?`).run(JSON.stringify(invalid), later.operation.id);
  saved.close(); refreshBackupHash(input);
  await expect(CoreStore.relocateDatabase(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
  expect(task().canvas?.document?.title).toBe('A later linked canvas');
});

it.each([
  ['missing image', 'missing-image', 'source'],
  ['foreign image', 'foreign-image', 'source'],
  ['text image', 'text', 'source'],
  ['missing source', 'image', 'missing-source'],
  ['foreign source', 'image', 'foreign-source'],
])('rejects a backed-up canvas with a %s even if its SQLite integrity and manifest hash are valid', async (_name, assetId, sourceId) => {
  references(); must(core.dispatch(update(withImage()), auth));
  const input = await backup();
  const saved = new Database(path.join(input.stagingProfile, 'eve.db'));
  saved.prepare('UPDATE canvases SET value=? WHERE task_id=?').run(JSON.stringify(withImage(assetId, sourceId)), 'orbit'); saved.close();
  refreshBackupHash(input);
  await expect(CoreStore.relocateDatabase(input)).rejects.toMatchObject({ code: 'INVALID_DATABASE' });
  expect(task().canvas?.document).toEqual(withImage());
});

it.each([
  ['before_json', 'foreign-image', 'source'], ['after_json', 'foreign-image', 'source'],
  ['before_json', 'image', 'foreign-source'], ['after_json', 'image', 'foreign-source'],
] as const)('rejects unauthorized references in backed-up canvas history (%s, %s, %s) before Undo can reveal them', async (column, assetId, sourceId) => {
  references(); must(core.dispatch(update(withImage()), auth));
  const later = must(core.dispatch(update({ ...withImage(), title: 'A later canvas' }), auth));
  const input = await backup();
  const saved = new Database(path.join(input.stagingProfile, 'eve.db'));
  saved.prepare(`UPDATE operations SET ${column}=? WHERE id=?`).run(JSON.stringify(withImage(assetId, sourceId)), later.operation.id); saved.close();
  refreshBackupHash(input);
  await expect(CoreStore.relocateDatabase(input)).rejects.toMatchObject({ code: 'INVALID_DATABASE' });
});

it('migrates a v5 profile with a verified rollback while preserving notes, history and idempotent receipts', () => {
  const note = must(core.dispatch({ type: 'UpdateNote', requestId: 'old-note', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, body: 'My writing before the canvas existed.' }, auth));
  const before = core.snapshot(); core.close();
  const old = new Database(dbPath); old.exec('DROP TABLE canvases; PRAGMA user_version=5;'); old.pragma('wal_checkpoint(TRUNCATE)'); old.pragma('journal_mode=DELETE'); old.close();
  core = new CoreStore({ dbPath });
  expect(core.diagnostics().schemaVersion).toBe(6); expect(core.snapshot()).toEqual(before);
  expect(core.migrationRollback).toMatchObject({ fromVersion: 5, toVersion: 6 });
  const rollback = new Database(core.migrationRollback!.path, { readonly: true });
  expect(rollback.pragma('user_version', { simple: true })).toBe(5);
  expect(rollback.prepare("SELECT name FROM sqlite_master WHERE name='canvases'").get()).toBeUndefined(); rollback.close();
  expect(must(core.dispatch({ type: 'UpdateNote', requestId: 'old-note', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, body: 'My writing before the canvas existed.' }, auth)).operation.id).toBe(note.operation.id);
  must(core.dispatch(update(), auth)); expect(task().note.body).toBe('My writing before the canvas existed.');
});

it('relocates an actual v5 backup without adding v6 tables until the restored profile opens', async () => {
  const saved = must(core.dispatch({ type: 'UpdateNote', requestId: 'legacy-backup-note', taskId: 'orbit', expectedEpoch: task().epoch, expectedRevision: 0, body: 'A note from the previous version.' }, auth));
  const input = await backup();
  const historical = new Database(path.join(input.stagingProfile, 'eve.db'));
  historical.exec('DROP TABLE canvases; PRAGMA user_version=5;'); historical.close();
  input.expectedSchemaVersion = 5; refreshBackupHash(input);
  expect((await CoreStore.relocateDatabase(input)).schemaVersion).toBe(5);
  const untouched = new Database(path.join(input.stagingProfile, 'eve.db'), { readonly: true });
  expect(untouched.pragma('user_version', { simple: true })).toBe(5);
  expect(untouched.prepare("SELECT name FROM sqlite_master WHERE name='canvases'").get()).toBeUndefined(); untouched.close();
  const restored = new CoreStore({ dbPath: path.join(input.stagingProfile, 'eve.db') });
  try {
    expect(restored.diagnostics().schemaVersion).toBe(6);
    expect(restored.migrationRollback).toMatchObject({ fromVersion: 5, toVersion: 6 });
    expect(restored.snapshot().tasks.find(item => item.id === 'orbit')).toMatchObject({ note: { body: 'A note from the previous version.' }, canvas: null });
    expect(restored.snapshot().recentActions.find(action => action.requestId === 'legacy-backup-note')?.id).toBe(saved.operation.id);
  } finally { restored.close(); }
});

it('refuses canvas operation history in a backup claiming to be the older v5 schema', async () => {
  must(core.dispatch(update(), auth));
  const input = await backup();
  const historical = new Database(path.join(input.stagingProfile, 'eve.db'));
  historical.exec('DROP TABLE canvases; PRAGMA user_version=5;'); historical.close();
  input.expectedSchemaVersion = 5; refreshBackupHash(input);
  await expect(CoreStore.relocateDatabase(input)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_DATABASE|UNSUPPORTED_SCHEMA/) });
});
