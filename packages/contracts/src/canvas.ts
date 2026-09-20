import { z } from 'zod';

const identity = z.string().min(1).max(128);
const base = {
  id: identity,
  title: z.string().max(160),
  placement: z.enum(['main', 'aside', 'full']),
  pinned: z.boolean(),
  sourceIds: z.array(identity).max(8),
};
const designColor = z.string().length(7).regex(/^#[0-9a-fA-F]{6}$/);
const layerBase = {
  id: identity,
  name: z.string().min(1).max(80),
  x: z.number().int().min(0).max(2400),
  y: z.number().int().min(0).max(2400),
  width: z.number().int().min(1).max(2400),
  height: z.number().int().min(1).max(2400),
};
/** Bounded declarative layers, ordered from back to front. */
export const canvasDesignLayerSchema = z.discriminatedUnion('kind', [
  z.object({ ...layerBase, kind: z.literal('text'), text: z.string().max(4000), fontFamily: z.enum(['serif', 'sans']), fontSize: z.number().int().min(8).max(240), fontWeight: z.enum(['regular', 'medium', 'bold']), color: designColor, align: z.enum(['left', 'center', 'right']) }).strict(),
  z.object({ ...layerBase, kind: z.literal('shape'), shape: z.enum(['rectangle', 'ellipse']), fill: designColor }).strict(),
  z.object({ ...layerBase, kind: z.literal('image'), assetId: identity, fit: z.enum(['cover', 'contain']) }).strict(),
]);
export type CanvasDesignLayer = z.infer<typeof canvasDesignLayerSchema>;

/** Original-relative crop edges. The minimum span bounds display magnification. */
export const CANVAS_IMAGE_MIN_CROP_SPAN = 0.05;
const cropRoundingTolerance = Number.EPSILON * 4;
export const canvasImageAdjustmentsSchema = z.object({
  brightness: z.number().finite().min(0.25).max(2),
  contrast: z.number().finite().min(0.25).max(2),
  saturation: z.number().finite().min(0).max(2),
  straighten: z.number().finite().min(-15).max(15),
  crop: z.object({
    left: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
    right: z.number().finite().min(0).max(1),
    bottom: z.number().finite().min(0).max(1),
  }).strict().superRefine((crop, context) => {
    // Ordinary decimal edges such as .10 and .15 must describe a valid 5% span.
    // Only floating-point subtraction noise is tolerated, never an outside edge.
    if (crop.right - crop.left + cropRoundingTolerance < CANVAS_IMAGE_MIN_CROP_SPAN) context.addIssue({ code: 'custom', path: ['right'], message: 'The crop must keep at least 5% of the original width.' });
    if (crop.bottom - crop.top + cropRoundingTolerance < CANVAS_IMAGE_MIN_CROP_SPAN) context.addIssue({ code: 'custom', path: ['bottom'], message: 'The crop must keep at least 5% of the original height.' });
  }),
}).strict();
export type CanvasImageAdjustments = z.infer<typeof canvasImageAdjustmentsSchema>;

/** Display values only: does not insert defaults or transform saved canonical data. */
export function normalizedImageAdjustments(value?: CanvasImageAdjustments | null): CanvasImageAdjustments {
  return value ? { brightness: value.brightness, contrast: value.contrast, saturation: value.saturation, straighten: value.straighten, crop: { ...value.crop } }
    : { brightness: 1, contrast: 1, saturation: 1, straighten: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } };
}

/** Missing/null adjustments and explicit neutral settings display the same original. */
export function imageAdjustmentsEqual(left?: CanvasImageAdjustments | null, right?: CanvasImageAdjustments | null): boolean {
  const first = normalizedImageAdjustments(left), second = normalizedImageAdjustments(right);
  return first.brightness === second.brightness && first.contrast === second.contrast && first.saturation === second.saturation && first.straighten === second.straighten
    && first.crop.left === second.crop.left && first.crop.top === second.crop.top && first.crop.right === second.crop.right && first.crop.bottom === second.crop.bottom;
}

/** A composition of installed tools and data. It never contains executable UI. */
export const canvasBlockSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('text'), body: z.string().max(20_000) }).strict(),
  z.object({ ...base, kind: z.literal('checklist'), items: z.array(z.object({ id: identity, label: z.string().max(1000), checked: z.boolean() }).strict()).max(60) }).strict(),
  z.object({ ...base, kind: z.literal('table'), columns: z.array(z.string().min(1).max(80)).min(1).max(8), rows: z.array(z.object({ id: identity, cells: z.array(z.string().max(1000)).min(1).max(8) }).strict()).max(80) }).strict(),
  z.object({ ...base, kind: z.literal('chart'), tableId: identity.nullable(), chartType: z.enum(['bar', 'line']), labelColumn: z.number().int().min(0).max(7), valueColumns: z.array(z.number().int().min(0).max(7)).max(3) }).strict(),
  z.object({ ...base, kind: z.literal('metric'), tableId: identity.nullable(), rowId: identity.nullable(), column: z.number().int().min(0).max(7), prefix: z.string().max(12), suffix: z.string().max(24), decimals: z.number().int().min(0).max(4) }).strict(),
  z.object({ ...base, kind: z.literal('timeline'), date: z.string().max(80), startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(1).max(24), items: z.array(z.object({ id: identity, title: z.string().max(160), startMinutes: z.number().int().min(0).max(1439), endMinutes: z.number().int().min(1).max(1440), status: z.enum(['planned', 'suggested', 'done']), detail: z.string().max(1000) }).strict()).max(40) }).strict(),
  z.object({ ...base, kind: z.literal('image'), assetId: identity.nullable(), caption: z.string().max(1000), adjustments: canvasImageAdjustmentsSchema.nullable().optional() }).strict().superRefine((block, context) => {
    if (block.assetId === null && block.adjustments != null) context.addIssue({ code: 'custom', path: ['adjustments'], message: 'Attach an image before adding photo adjustments.' });
  }),
  z.object({ ...base, kind: z.literal('design'), width: z.number().int().min(240).max(2400), height: z.number().int().min(240).max(2400), background: designColor, layers: z.array(canvasDesignLayerSchema).max(24) }).strict(),
  z.object({ ...base, kind: z.literal('timer'), durationSeconds: z.number().int().min(1).max(86400), remainingSeconds: z.number().int().min(0).max(86400), endsAt: z.number().int().nonnegative().nullable() }).strict(),
  z.object({ ...base, kind: z.literal('deadline'), dueAt: z.number().int().min(0).max(253402300799999).nullable() }).strict(),
  z.object({ ...base, kind: z.literal('sources'), description: z.string().max(1000) }).strict(),
  z.object({ ...base, kind: z.literal('note'), description: z.string().max(1000) }).strict(),
]);

export const canvasArrangementSchema = z.object({
  layout: z.enum(['focus', 'split', 'gallery']), order: z.array(identity).min(1).max(24),
}).strict().refine(value => new Set(value.order).size === value.order.length, 'An arrangement must list each item only once.');
export const canvasArrangementSnapshotSchema = z.object({
  layout: z.enum(['focus', 'split', 'gallery']),
  blocks: z.array(z.object({ id: identity, placement: base.placement }).strict()).min(1).max(24),
}).strict().refine(value => new Set(value.blocks.map(block => block.id)).size === value.blocks.length, 'An arrangement snapshot must list each item only once.');
export type CanvasArrangement = z.infer<typeof canvasArrangementSchema>;
export type CanvasArrangementSnapshot = z.infer<typeof canvasArrangementSnapshotSchema>;

export const MAX_CANVAS_SUGGESTIONS = 24;
export const MAX_CANVAS_REFRESH_SUGGESTIONS = 6;
export const MAX_CANVAS_SCOPED_SUGGESTIONS = 3;
/** UTF-16 offsets, matching the native textarea selection APIs. */
export const canvasTextSelectionSchema = z.object({
  field: z.literal('body'), start: z.number().int().min(0).max(20_000), end: z.number().int().min(1).max(20_000), text: z.string().min(1).max(20_000),
}).strict().refine(value => value.end > value.start && value.end - value.start === value.text.length, 'The selected text must match its nonempty range.');
export type CanvasTextSelection = z.infer<typeof canvasTextSelectionSchema>;
export const canvasSuggestionRefreshScopeSchema = z.object({ blockId: identity, selection: canvasTextSelectionSchema.optional() }).strict();
export type CanvasSuggestionRefreshScope = z.infer<typeof canvasSuggestionRefreshScopeSchema>;

/** A proposed follow-up request. It grants no authority and runs only after a user chooses it. */
export const canvasSuggestionSchema = z.object({
  id: identity,
  label: z.string().min(1).max(80),
  description: z.string().max(240),
  request: z.string().min(1).max(2000),
  targetBlockId: identity.nullable(),
  /** Trusted local capture. Never supplied by a model or used as a text search. */
  textSelection: canvasTextSelectionSchema.optional(),
  /** Concrete future edits are still passive data until the user reviews and keeps them. */
  prepared: z.object({
    edits: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.enum(['add', 'replace']), block: canvasBlockSchema }).strict(),
      z.object({ type: z.literal('remove'), id: identity }).strict(),
    ])).max(4),
    before: z.array(canvasBlockSchema).max(4),
    arrangement: canvasArrangementSchema.nullable().optional(),
    beforeArrangement: canvasArrangementSnapshotSchema.nullable().optional(),
  }).strict().superRefine((plan, context) => {
    if (!plan.edits.length && !plan.arrangement) context.addIssue({ code: 'custom', path: ['edits'], message: 'A prepared suggestion needs an edit or an arrangement.' });
    if (!!plan.arrangement !== !!plan.beforeArrangement) context.addIssue({ code: 'custom', path: ['beforeArrangement'], message: 'A prepared arrangement must retain exactly its original arrangement snapshot.' });
  }).nullable().optional(),
}).strict().superRefine((suggestion, context) => {
  if (suggestion.textSelection && (!suggestion.prepared || suggestion.targetBlockId === null)) context.addIssue({ code: 'custom', path: ['textSelection'], message: 'A text-selection choice needs a prepared change and an exact target item.' });
});
export type CanvasSuggestion = z.infer<typeof canvasSuggestionSchema>;
/** The renderer identifies a displayed suggestion; the host resolves its contents. */
export const canvasSuggestionSelectionSchema = z.object({
  id: identity,
  canvasRevision: z.number().int().nonnegative(),
}).strict();
export type CanvasSuggestionSelection = z.infer<typeof canvasSuggestionSelectionSchema>;

export const canvasDocumentSchema = z.object({
  version: z.literal(1), title: z.string().min(1).max(160), subtitle: z.string().max(1000),
  layout: z.enum(['focus', 'split', 'gallery']), blocks: z.array(canvasBlockSchema).min(1).max(24),
  suggestions: z.array(canvasSuggestionSchema).max(MAX_CANVAS_SUGGESTIONS).optional(),
}).strict().superRefine((document, context) => {
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(document.blocks.map(block => block.id))) context.addIssue({ code: 'custom', message: 'Each canvas item needs its own identity.' });
  if (!unique((document.suggestions ?? []).map(suggestion => suggestion.id))) context.addIssue({ code: 'custom', path: ['suggestions'], message: 'Each suggestion needs its own identity.' });
  const blockIds = new Set(document.blocks.map(block => block.id));
  const tables = new Map(document.blocks.filter(block => block.kind === 'table').map(block => [block.id, block]));
  for (const [index, suggestion] of (document.suggestions ?? []).entries()) {
    if (suggestion.targetBlockId !== null && !blockIds.has(suggestion.targetBlockId)) context.addIssue({ code: 'custom', path: ['suggestions', index, 'targetBlockId'], message: 'A suggestion must refer to an item in this canvas or the whole canvas with null.' });
    if (suggestion.prepared) {
      const path = ['suggestions', index, 'prepared'];
      const replaced = suggestion.prepared.edits.flatMap(edit => edit.type === 'remove' ? [edit.id] : edit.type === 'replace' ? [edit.block.id] : []);
      const originals = suggestion.prepared.before.map(block => block.id);
      if (!unique(suggestion.prepared.edits.map(edit => edit.type === 'remove' ? edit.id : edit.block.id))) context.addIssue({ code: 'custom', path: [...path, 'edits'], message: 'A prepared suggestion can change each item only once.' });
      if (!unique(originals) || originals.length !== replaced.length || originals.some(id => !replaced.includes(id))) context.addIssue({ code: 'custom', path: [...path, 'before'], message: 'A prepared suggestion must retain exactly the original of each replaced or removed item.' });
    }
  }
  // Future blocks and their captured originals receive the same intrinsic checks.
  // Their links and preconditions are checked when compiled, because user edits may
  // legitimately make a stored choice stale without making the canvas unsavable.
  const referenced = [
    ...document.blocks.map((block, index) => ({ block, path: ['blocks', index] as (string | number)[], current: true })),
    ...(document.suggestions ?? []).flatMap((suggestion, index) => suggestion.prepared ? [
      ...suggestion.prepared.edits.flatMap((edit, editIndex) => edit.type === 'remove' ? [] : [{ block: edit.block, path: ['suggestions', index, 'prepared', 'edits', editIndex, 'block'], current: false }] ),
      ...suggestion.prepared.before.map((block, beforeIndex) => ({ block, path: ['suggestions', index, 'prepared', 'before', beforeIndex], current: false })),
    ] : []),
  ];
  for (const { block, path, current } of referenced) {
    if ('items' in block && !unique(block.items.map(item => item.id))) context.addIssue({ code: 'custom', path: [...path, 'items'], message: 'Each item needs its own identity.' });
    if (block.kind === 'table' && (!unique(block.rows.map(row => row.id)) || block.rows.some(row => row.cells.length !== block.columns.length))) context.addIssue({ code: 'custom', path, message: 'Table rows must match their columns and have unique identities.' });
    if (block.kind === 'design') {
      if (!unique(block.layers.map(layer => layer.id))) context.addIssue({ code: 'custom', path: [...path, 'layers'], message: 'Each design layer needs its own identity.' });
      for (const [layerIndex, layer] of block.layers.entries()) {
        if (layer.x + layer.width > block.width || layer.y + layer.height > block.height) context.addIssue({ code: 'custom', path: [...path, 'layers', layerIndex], message: 'Every layer must fit within the design width and height.' });
      }
    }
    if (block.kind === 'chart' || block.kind === 'metric') {
      const table = block.tableId === null ? undefined : tables.get(block.tableId);
      if (current && block.tableId !== null && !table) context.addIssue({ code: 'custom', path: [...path, 'tableId'], message: 'Choose a table in this canvas, or leave the linked table unset with null.' });
      const columns = block.kind === 'chart' ? [block.labelColumn, ...block.valueColumns] : [block.column];
      if (current && table && columns.some(column => column >= table.columns.length)) context.addIssue({ code: 'custom', path, message: 'Linked columns must exist in the chosen table.' });
      if (block.kind === 'chart' && new Set(block.valueColumns).size !== block.valueColumns.length) context.addIssue({ code: 'custom', path: [...path, 'valueColumns'], message: 'Choose each chart value column only once.' });
      if (current && block.kind === 'metric' && block.rowId !== null && (!table || !table.rows.some(row => row.id === block.rowId))) context.addIssue({ code: 'custom', path: [...path, 'rowId'], message: 'Choose a row in the linked table, or leave the row unset with null.' });
    }
    if (block.kind === 'timeline' && (block.endHour <= block.startHour || block.items.some(item => item.endMinutes <= item.startMinutes || item.startMinutes < block.startHour * 60 || item.endMinutes > block.endHour * 60))) context.addIssue({ code: 'custom', path, message: 'Every event must end after it starts and fit between startHour*60 and endHour*60. Keep the schedule within the requested time window.' });
    if (block.kind === 'timer' && block.remainingSeconds > block.durationSeconds) context.addIssue({ code: 'custom', path, message: 'The time left cannot exceed the timer duration.' });
  }
});
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
export type CanvasBlock = z.infer<typeof canvasBlockSchema>;
export interface CanvasRecord { document: CanvasDocument | null; revision: number; updatedAt: number }

/** Captures only arrangement prerequisites, so unrelated authored typing stays current. */
export function canvasArrangementSnapshot(document: CanvasDocument): CanvasArrangementSnapshot {
  return { layout: document.layout, blocks: document.blocks.map(({ id, placement }) => ({ id, placement })) };
}

/** Compare canonical JSON data without making object property order significant. */
export function canvasDataEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => canvasDataEqual(value, right[index]));
  const leftObject = left as Record<string, unknown>, rightObject = right as Record<string, unknown>;
  const keys = Object.keys(leftObject);
  return keys.length === Object.keys(rightObject).length && keys.every(key => Object.hasOwn(rightObject, key) && canvasDataEqual(leftObject[key], rightObject[key]));
}

function textBoundary(body: string, offset: number): boolean {
  return !(offset > 0 && offset < body.length && /[\uD800-\uDBFF]/.test(body[offset - 1]!) && /[\uDC00-\uDFFF]/.test(body[offset]!));
}

/** Checks a current host capture, never silently relocates matching text. */
function assertCanvasTextScope(document: CanvasDocument, scope: CanvasSuggestionRefreshScope): void {
  const parsed = canvasSuggestionRefreshScopeSchema.safeParse(scope);
  if (!parsed.success) throw new Error('The selected item or text range is invalid.');
  const block = document.blocks.find(item => item.id === scope.blockId);
  if (!block) throw new Error('The selected canvas item is no longer available.');
  const selected = scope.selection;
  if (selected && (block.kind !== 'text' || selected.end > block.body.length || block.body.slice(selected.start, selected.end) !== selected.text || !textBoundary(block.body, selected.start) || !textBoundary(block.body, selected.end)))
    throw new Error('The selected text changed. Select it again from your current writing.');
}

/** Reading a pinned passage never grants authority to change it. */
export function assertCanvasLearningScope(document: CanvasDocument, scope: CanvasSuggestionRefreshScope): void {
  assertCanvasTextScope(document, scope);
  if (!scope.selection) throw new Error('Select a passage to learn more about it.');
}

/** A free-form selection request can revise that passage or add supporting
 * registered items. It cannot silently broaden authority to existing work. */
export function assertCanvasSelectionResult(before: CanvasDocument, after: CanvasDocument, scope: CanvasSuggestionRefreshScope): void {
  assertCanvasLearningScope(before, scope);
  const selected = scope.selection!;
  const originalIds = new Set(before.blocks.map(block => block.id));
  const additions = after.blocks.filter(block => !originalIds.has(block.id));
  if (additions.length > 4 || !canvasDataEqual(before.blocks.map(block => block.id), after.blocks.filter(block => originalIds.has(block.id)).map(block => block.id)))
    throw new Error('A selection request must preserve every existing item and its order.');
  const selectedIndex = after.blocks.findIndex(block => block.id === scope.blockId);
  if (!canvasDataEqual(additions.map(block => block.id), after.blocks.slice(selectedIndex + 1, selectedIndex + 1 + additions.length).map(block => block.id)))
    throw new Error('Supporting items must be inserted immediately after the selected item.');
  const { blocks: _oldBlocks, layout: oldLayout, ...oldMetadata } = before;
  const { blocks: _newBlocks, layout: newLayout, ...newMetadata } = after;
  if (!canvasDataEqual(oldMetadata, newMetadata)) throw new Error('A selection request must preserve the canvas title and saved choices.');
  if (oldLayout !== newLayout && (newLayout !== 'split' || !additions.length || before.blocks.find(block => block.id === scope.blockId)?.placement === 'full'))
    throw new Error('A selection request can only make room beside the selected item for new content.');
  if (oldLayout !== newLayout && additions.some(block => block.placement !== (before.blocks.find(item => item.id === scope.blockId)?.placement === 'main' ? 'aside' : 'main')))
    throw new Error('Items added beside a selection must use its opposite column.');
  for (const original of before.blocks) {
    const candidate = after.blocks.find(block => block.id === original.id);
    if (!candidate) throw new Error('A selection request cannot remove existing items.');
    if (original.id !== scope.blockId || original.pinned) {
      if (!canvasDataEqual(original, candidate)) throw new Error('A selection request cannot change other or pinned items.');
      continue;
    }
    if (original.kind !== 'text' || candidate.kind !== 'text') throw new Error('The selected writing must remain writing.');
    const { body: oldBody, ...oldFields } = original;
    const { body: newBody, ...newFields } = candidate;
    const prefix = oldBody.slice(0, selected.start), suffix = oldBody.slice(selected.end);
    if (!canvasDataEqual(oldFields, newFields) || newBody.length < prefix.length + suffix.length || !newBody.startsWith(prefix) || !newBody.endsWith(suffix))
      throw new Error('A selection request must preserve all writing outside the highlighted passage.');
  }
}

export function assertCanvasSuggestionRefreshScope(document: CanvasDocument, scope: CanvasSuggestionRefreshScope): void {
  assertCanvasTextScope(document, scope);
  if (document.blocks.find(item => item.id === scope.blockId)?.pinned)
    throw new Error('Unpin this item before asking for suggested changes.');
}

export function canvasSuggestionRefreshCapacity(document: CanvasDocument, scope?: CanvasSuggestionRefreshScope): number {
  return scope ? Math.max(0, Math.min(MAX_CANVAS_SCOPED_SUGGESTIONS, MAX_CANVAS_SUGGESTIONS - (document.suggestions ?? []).filter(choice => choice.targetBlockId !== scope.blockId).length)) : MAX_CANVAS_REFRESH_SUGGESTIONS;
}

function assertTextSelectionPlan(document: CanvasDocument, suggestion: CanvasSuggestion): void {
  const selection = suggestion.textSelection;
  if (!selection) return;
  if (!suggestion.prepared || suggestion.targetBlockId === null) throw new Error('A text-selection choice needs a prepared change and an exact target item.');
  assertCanvasSuggestionRefreshScope(document, { blockId: suggestion.targetBlockId, selection });
  if (suggestion.prepared.arrangement) throw new Error('A selected-text suggestion cannot rearrange the canvas.');
  for (const edit of suggestion.prepared.edits) {
    if (edit.type === 'add') continue;
    if (edit.type !== 'replace' || edit.block.id !== suggestion.targetBlockId || edit.block.kind !== 'text') throw new Error('A selected-text suggestion can only add supporting items or replace its selected text.');
    const before = suggestion.prepared.before.find(block => block.id === suggestion.targetBlockId);
    if (before?.kind !== 'text' || before.body.slice(selection.start, selection.end) !== selection.text) throw new Error('The selected text does not match its captured original.');
    const { body: original, ...beforeFields } = before;
    const { body: replacement, ...afterFields } = edit.block;
    const prefix = original.slice(0, selection.start), suffix = original.slice(selection.end);
    if (!canvasDataEqual(beforeFields, afterFields) || replacement.length < prefix.length + suffix.length || !replacement.startsWith(prefix) || !replacement.endsWith(suffix))
      throw new Error('A selected-text suggestion must preserve all text outside the selection and every other item field.');
  }
}

/** Shared agent/host check. Refreshed choices are validated; untouched foreign
 * choices retain their exact historical data and are allowed to remain stale. */
export function assertCanvasSuggestionRefreshResult(before: CanvasDocument, after: CanvasDocument, scope?: CanvasSuggestionRefreshScope): void {
  const { suggestions: oldChoices, ...oldWork } = before;
  const { suggestions: choices, ...newWork } = after;
  if (!Array.isArray(choices) || !canvasDataEqual(oldWork, newWork)) throw new Error('Refreshing suggestions must preserve every existing block, title, subtitle, layout and order exactly.');
  if (!canvasDocumentSchema.safeParse(after).success) throw new Error('The refreshed choices must form a valid canvas.');
  if (scope) assertCanvasSuggestionRefreshScope(before, scope);
  const returned = scope ? choices.filter(choice => choice.targetBlockId === scope.blockId) : choices;
  if (returned.length > canvasSuggestionRefreshCapacity(before, scope)) throw new Error('There is no room for that many new choices while preserving the other suggestions.');
  if (scope) {
    const preserved = (oldChoices ?? []).filter(choice => choice.targetBlockId !== scope.blockId);
    if (!canvasDataEqual(preserved, choices.filter(choice => choice.targetBlockId !== scope.blockId))) throw new Error('An item refresh must preserve every unrelated suggestion exactly.');
    const foreignIds = new Set(preserved.map(choice => choice.id));
    for (const choice of returned) {
      if (foreignIds.has(choice.id) || !choice.prepared) throw new Error('Scoped choices need distinct prepared changes for the selected item.');
      if (scope.selection && !canvasDataEqual(choice.textSelection, scope.selection)) throw new Error('The suggested change does not match the captured text selection.');
      if (!scope.selection && choice.textSelection && !canvasDataEqual((oldChoices ?? []).find(old => old.id === choice.id)?.textSelection, choice.textSelection)) throw new Error('An item refresh cannot invent text-selection authority.');
    }
  }
  for (const choice of returned) {
    const previous = oldChoices?.find(old => old.id === choice.id);
    if (after.blocks.find(block => block.id === choice.targetBlockId)?.pinned && !canvasDataEqual(previous, choice)) throw new Error('A refreshed suggestion cannot target a pinned item.');
    if (previous?.textSelection && (previous.targetBlockId !== choice.targetBlockId || !canvasDataEqual(previous.textSelection, choice.textSelection))) throw new Error('A saved selected-text choice cannot change its captured scope. Use a new choice identity.');
    if (scope?.selection && previous && !canvasDataEqual(previous.textSelection, scope.selection)) throw new Error('A saved choice cannot adopt a different text selection. Use a new choice identity.');
    if (previous?.prepared && choice.prepared && previous.targetBlockId === choice.targetBlockId) {
      for (const edit of choice.prepared.edits) {
        if (edit.type === 'add' || !previous.prepared.edits.some(old => canvasDataEqual(old, edit))) continue;
        const id = edit.type === 'remove' ? edit.id : edit.block.id;
        if (!canvasDataEqual(previous.prepared.before.find(block => block.id === id), choice.prepared.before.find(block => block.id === id))) throw new Error('A retained suggestion cannot refresh its captured original. Use a new choice identity.');
      }
      if (previous.prepared.arrangement && canvasDataEqual(previous.prepared.arrangement, choice.prepared.arrangement) && !canvasDataEqual(previous.prepared.beforeArrangement, choice.prepared.beforeArrangement)) throw new Error('A retained arrangement cannot refresh its original layout or placement.');
    }
    if (choice.prepared) compileCanvasSuggestion(after, choice.id);
  }
}

/** Includes dormant future edits and originals, so admission and backup cannot hide references. */
export function canvasReferencedBlocks(document: CanvasDocument): CanvasBlock[] {
  return [...document.blocks, ...(document.suggestions ?? []).flatMap(suggestion => suggestion.prepared ? [
    ...suggestion.prepared.edits.flatMap(edit => edit.type === 'remove' ? [] : [edit.block]), ...suggestion.prepared.before,
  ] : [])];
}

export interface CanvasSuggestionResources { assetIds: readonly string[]; sourceIds: readonly string[] }

/**
 * Cheap presentation-only prerequisites for saved choices while the user types.
 * An absent reason is not approval or proof that an edit is executable. The host
 * must still compile the complete saved suggestion before previewing and keeping.
 */
export function canvasSuggestionUnavailableReason(document: CanvasDocument, suggestion: CanvasSuggestion): string | undefined {
  if (suggestion.textSelection) {
    try { assertTextSelectionPlan(document, suggestion); }
    catch (error) { return error instanceof Error ? error.message : 'The selected text changed.'; }
  }
  if (!suggestion.prepared) return undefined;
  const { edits, arrangement, beforeArrangement } = suggestion.prepared;
  if (arrangement && !canvasDataEqual(canvasArrangementSnapshot(document), beforeArrangement)) return 'The canvas arrangement changed. Review a new suggestion from your current work.';
  for (const edit of edits) {
    const id = edit.type === 'remove' ? edit.id : edit.block.id;
    const previous = document.blocks.find(block => block.id === id);
    if (edit.type === 'add') {
      if (previous) return 'This suggestion would add an item that is already on the canvas.';
      continue;
    }
    const original = suggestion.prepared.before.find(block => block.id === id);
    if (!previous || !canvasDataEqual(previous, original)) return 'An item in this suggestion changed. Review a new suggestion from your current work.';
    if (previous.pinned) return 'Unpin this item before applying a suggested change.';
    if (suggestion.targetBlockId !== null && suggestion.targetBlockId !== id) return 'This suggestion changes an item outside its selected target.';
    if (edit.type !== 'remove' && canvasDataEqual(previous, edit.block)) return 'This suggestion would leave its item unchanged.';
  }
  const removed = new Set(edits.flatMap(edit => edit.type === 'remove' ? [edit.id] : []));
  const resultingIds = [...document.blocks.filter(block => !removed.has(block.id)).map(block => block.id), ...edits.flatMap(edit => edit.type === 'add' ? [edit.block.id] : [])];
  if (!resultingIds.length) return 'A suggestion cannot remove every item from the canvas.';
  if (arrangement) {
    if (arrangement.order.length !== resultingIds.length || new Set(arrangement.order).size !== resultingIds.length || arrangement.order.some(id => !resultingIds.includes(id))) return 'The suggested arrangement must list every resulting canvas item exactly once.';
    if (!edits.length && arrangement.layout === document.layout && canvasDataEqual(arrangement.order, resultingIds)) return 'This suggestion would leave the canvas arrangement unchanged.';
  }
  return undefined;
}

function parseSuggestionDocument(document: CanvasDocument): CanvasDocument {
  const parsed = canvasDocumentSchema.safeParse(document);
  if (!parsed.success) throw new Error(`This suggestion does not form a valid canvas: ${parsed.error.issues[0]?.message ?? 'Review its items.'}`);
  return parsed.data;
}

/** Compile one plan without recursively processing other saved suggestions. */
function compilePreparedSuggestion(document: CanvasDocument, suggestionId: string, resources?: CanvasSuggestionResources): CanvasDocument {
  const suggestion = document.suggestions?.find(item => item.id === suggestionId);
  if (!suggestion?.prepared) throw new Error('This suggestion has no prepared change to review.');
  const { edits, before, arrangement } = suggestion.prepared;
  const unavailable = canvasSuggestionUnavailableReason(document, suggestion);
  if (unavailable) throw new Error(unavailable);
  const originals = new Map(before.map(block => [block.id, block]));
  const current = new Map(document.blocks.map(block => [block.id, block]));
  const replacements = new Map<string, CanvasBlock>();
  const removals = new Set<string>();
  const additions: CanvasBlock[] = [];
  for (const edit of edits) {
    if (edit.type === 'remove') {
      removals.add(edit.id);
      continue;
    }
    const block = edit.block, previous = current.get(block.id);
    if (edit.type === 'add') {
      if (previous) throw new Error('This suggestion would add an item that is already on the canvas.');
      additions.push(block);
    } else {
      if (!previous || !canvasDataEqual(previous, originals.get(block.id))) throw new Error('An item in this suggestion changed. Review a new suggestion from your current work.');
      if (previous.pinned) throw new Error('Unpin this item before applying a suggested change.');
      if (suggestion.targetBlockId !== null && suggestion.targetBlockId !== block.id) throw new Error('This suggestion changes an item outside its selected target.');
      if (canvasDataEqual(previous, block)) throw new Error('This suggestion would leave its item unchanged.');
      replacements.set(block.id, block);
    }
    if (block.kind === 'timer' && (block.endsAt !== null || block.remainingSeconds !== block.durationSeconds)) throw new Error('A suggestion cannot start or resume a timer. Use its Start button.');
    if (block.kind === 'table') {
      for (const [row, item] of block.rows.entries()) for (const [column, value] of item.cells.entries()) {
        if (value.startsWith('=') && typeof calculateCell(block.rows, row, column) !== 'number') throw new Error(`Prepared table ${JSON.stringify(block.id)}, cell ${String.fromCharCode(65 + column)}${row + 1} (row ${JSON.stringify(item.id)}) has an invalid formula ${JSON.stringify(value)}. Column A is the first column; row 1 is the first data row, excluding headings. Reference existing numeric cells and produce a finite number. Blank, unknown and other nonnumeric cells are not zero.`);
      }
    }
  }
  let blocks = [...document.blocks.filter(block => !removals.has(block.id)).map(block => replacements.get(block.id) ?? block), ...additions];
  if (arrangement) {
    const resulting = new Map(blocks.map(block => [block.id, block]));
    blocks = arrangement.order.map(id => resulting.get(id)!);
  }
  const candidate = parseSuggestionDocument({ ...document,
    layout: arrangement?.layout ?? document.layout, blocks,
    suggestions: document.suggestions?.filter(item => item.id !== suggestionId && (item.targetBlockId === null || !removals.has(item.targetBlockId))),
  });
  if (resources) {
    const assets = new Set(resources.assetIds), sources = new Set(resources.sourceIds);
    for (const block of [...candidate.blocks, ...before]) {
      if (canvasImageAssetIds(block).some(id => !assets.has(id))) throw new Error('An image needed by this suggestion is not attached to this space.');
      if (block.sourceIds.some(id => !sources.has(id))) throw new Error('A source needed by this suggestion is not attached to this space.');
    }
  }
  return candidate;
}

/**
 * A reviewable, deterministic future canvas. No model request, mutation or side
 * effect occurs here. The host still binds the returned result to a saved revision.
 */
export function compileCanvasSuggestion(document: CanvasDocument, suggestionId: string, resources?: CanvasSuggestionResources): CanvasDocument {
  const current = parseSuggestionDocument(document);
  const candidate = compilePreparedSuggestion(current, suggestionId, resources);
  candidate.suggestions = candidate.suggestions?.filter(suggestion => {
    if (!suggestion.prepared) return true;
    try { compilePreparedSuggestion(candidate, suggestion.id, resources); return true; } catch { return false; }
  });
  return parseSuggestionDocument(candidate);
}

/** Every image reference in one registered block, including nested design layers. */
export function canvasImageAssetIds(block: CanvasBlock): string[] {
  if (block.kind === 'image') return block.assetId === null ? [] : [block.assetId];
  if (block.kind === 'design') return block.layers.flatMap(layer => layer.kind === 'image' ? [layer.assetId] : []);
  return [];
}

/** No implicit zero, unit stripping, exponent notation, or malformed thousands groups. */
function numericValue(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = /^([+-]?)(?:([$£€¥])\s*)?([+-]?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/.exec(value.trim());
  if (!match || (match[1] && match[3])) return null;
  const parsed = Number(`${match[1] || match[3]}${match[4]!.replace(/,/g, '')}`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The live numeric value for a linked visual; missing/error cells stay missing. */
export function numericCanvasCell(rows: Array<{ cells: string[] }>, row: number, column: number): number | null {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0 || rows[row]?.cells[column] === undefined) return null;
  return numericValue(calculateCell(rows, row, column));
}

/** Bounded arithmetic with A1 references. No JS, functions, property access, or side effects. */
export function calculateCell(rows: Array<{ cells: string[] }>, row: number, column: number): string | number {
  const cache = new Map<string, string | number>();
  let steps = 0;
  const evaluate = (row: number, column: number, visiting = new Set<string>()): string | number => {
    if (++steps > 10000) return '#LIMIT';
    const value = rows[row]?.cells[column] ?? '';
    if (!value.startsWith('=')) return value;
    const key = `${row}:${column}`;
    if (visiting.has(key) || visiting.size >= 64) return '#CYCLE';
    if (cache.has(key)) return cache.get(key)!;
    const path = new Set(visiting).add(key);
    let answer: string | number;
    try {
      const expression = value.slice(1).replace(/\s+/g, '');
      const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[A-Ha-h][1-9]\d?|[()+*/-]/g) ?? [];
      if (tokens.join('') !== expression || tokens.length > 128 || !tokens.length) return '#FORMULA';
      let index = 0;
      const atom = (): number => {
        if (++steps > 10000) throw new Error();
        const token = tokens[index++];
        if (token === '+' || token === '-') return (token === '-' ? -1 : 1) * atom();
        if (token === '(') { const result = sum(); if (tokens[index++] !== ')') throw new Error(); return result; }
        if (!token) throw new Error();
        if (/^[A-Ha-h]/.test(token)) {
          const r = Number(token.slice(1)) - 1, c = token.toUpperCase().charCodeAt(0) - 65;
          if (rows[r]?.cells[c] === undefined) throw new Error();
          const result = evaluate(r, c, path);
          const numeric = numericValue(result);
          if (numeric === null) throw new Error();
          return numeric;
        }
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new Error();
        return Number(token);
      };
      const product = (): number => { let value = atom(); while (tokens[index] === '*' || tokens[index] === '/') { const op = tokens[index++]; const right = atom(); value = op === '*' ? value * right : value / right; } return value; };
      const sum = (): number => { let value = product(); while (tokens[index] === '+' || tokens[index] === '-') { const op = tokens[index++]; const right = product(); value = op === '+' ? value + right : value - right; } return value; };
      const result = sum();
      answer = index === tokens.length && Number.isFinite(result) ? (Math.abs(result) <= Number.MAX_VALUE / 1e8 ? Math.round(result * 1e8) / 1e8 : result) : '#FORMULA';
    } catch { answer = '#FORMULA'; }
    cache.set(key, answer); return answer;
  };
  return evaluate(row, column);
}
