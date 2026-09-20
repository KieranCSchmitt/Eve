import { z } from 'zod';
import { assertCanvasSuggestionRefreshScope, canvasBlockSchema, canvasDataEqual, canvasDesignLayerSchema, canvasDocumentSchema, canvasImageAdjustmentsSchema, imageAdjustmentsEqual, type CanvasBlock, type CanvasSuggestionRefreshScope } from '@eve/contracts';

const identity = z.string().min(1).max(128);
const collection = z.enum(['layers', 'items', 'rows']);
const startClock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const endClock = /^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
const fields = [
  'title', 'placement', 'sourceIds', 'body', 'columns', 'tableId', 'chartType', 'labelColumn', 'valueColumns',
  'rowId', 'column', 'prefix', 'suffix', 'decimals', 'date', 'startHour', 'endHour', 'assetId', 'caption',
  'width', 'height', 'background', 'durationSeconds', 'remainingSeconds', 'dueDate', 'description',
  'name', 'x', 'y', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'color', 'align', 'shape', 'fill', 'fit',
  'label', 'checked', 'startTime', 'endTime', 'status', 'detail',
] as const;
export const canvasPatchFieldSchema = z.enum(fields);
const primitiveValue = z.union([
  z.string().max(20_000), z.number().finite(), z.boolean(), z.null(),
  z.array(z.string().max(1000)).max(8), z.array(z.number().finite()).max(8),
]);
const target = z.object({ collection: z.enum(['layers', 'items']), id: identity }).strict().nullable();
const checklistItem = z.object({ id: identity, label: z.string().max(1000), checked: z.boolean() }).strict();
const timelineItem = z.object({ id: identity, title: z.string().max(160), startTime: z.string().regex(startClock), endTime: z.string().regex(endClock), status: z.enum(['planned', 'suggested', 'done']), detail: z.string().max(1000) }).strict();
const tableRow = z.object({ id: identity, cells: z.array(z.string().max(1000)).min(1).max(8) }).strict();
const insertItem = z.union([canvasDesignLayerSchema, checklistItem, timelineItem, tableRow]);

/** Bounded registered data mutations. No arbitrary paths, expressions or UI code. */
export const canvasPatchChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('adjust-image'), adjustments: canvasImageAdjustmentsSchema.nullable() }).strict(),
  z.object({ type: z.literal('set'), target, field: canvasPatchFieldSchema, value: primitiveValue }).strict(),
  z.object({ type: z.literal('insert'), collection, afterId: identity.nullable(), item: insertItem }).strict(),
  z.object({ type: z.literal('set-cell'), rowId: identity, column: z.number().int().min(0).max(7), value: z.string().max(1000) }).strict(),
  z.object({ type: z.literal('remove'), collection, id: identity }).strict(),
  z.object({ type: z.literal('move'), collection, id: identity, afterId: identity.nullable() }).strict(),
]);
export const canvasPatchSchema = z.object({ id: identity, changes: z.array(canvasPatchChangeSchema).min(1).max(24) }).strict();
/** Discriminators intentionally appear first in both model-facing object shapes. */
export const canvasBlockPatchSchema = z.object({ kind: z.literal('patch'), ...canvasPatchSchema.shape }).strict();
export const canvasPreparedPatchSchema = z.object({ type: z.literal('patch'), ...canvasPatchSchema.shape }).strict();
/** Model-only prepared edit: the host capture supplies the range, never the model. */
export const canvasPreparedSelectionReplacementSchema = z.object({
  type: z.literal('replace-selection'), id: identity, text: z.string().max(20_000),
}).strict();
export type CanvasPatch = z.infer<typeof canvasPatchSchema>;

const commonFields = ['title', 'placement', 'sourceIds'];
const blockFields: Record<CanvasBlock['kind'], readonly string[]> = {
  text: ['body'], checklist: [], table: ['columns'],
  chart: ['tableId', 'chartType', 'labelColumn', 'valueColumns'],
  metric: ['tableId', 'rowId', 'column', 'prefix', 'suffix', 'decimals'],
  timeline: ['date', 'startHour', 'endHour'], image: ['assetId', 'caption'],
  design: ['width', 'height', 'background'], timer: ['durationSeconds', 'remainingSeconds'],
  deadline: ['dueDate'], sources: ['description'], note: ['description'],
};
const layerFields: Record<'text' | 'shape' | 'image', readonly string[]> = {
  text: ['text', 'fontFamily', 'fontSize', 'fontWeight', 'color', 'align'],
  shape: ['shape', 'fill'], image: ['assetId', 'fit'],
};
type Entry = Record<string, unknown> & { id: string };
type Collection = z.infer<typeof collection>;

function invalid(message: string): never { throw new Error(`Invalid canvas patch: ${message}`); }

function canonicalBlock(value: unknown): CanvasBlock {
  const parsed = canvasBlockSchema.safeParse(value);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? 'the changed item is not registered data.');
  const block = parsed.data;
  // This module edits one item. Linked-table membership is checked against the
  // entire projected document by the existing proposal and suggestion compiler.
  const intrinsic = block.kind === 'chart' ? { ...block, tableId: null }
    : block.kind === 'metric' ? { ...block, tableId: null, rowId: null } : block;
  const complete = canvasDocumentSchema.safeParse({ version: 1, title: 'Patch validation', subtitle: '', layout: 'focus', blocks: [intrinsic] });
  if (!complete.success) invalid(complete.error.issues[0]?.message ?? 'the changed item exceeds its supported bounds.');
  return block;
}

/** Expand only the captured passage into ordinary registered block data. No
 * searching, occurrence inference, writable offsets or resource mutation. A
 * validated unchanged result may be removed by prepared-plan normalization. */
export function applyCanvasSelectionReplacement(base: CanvasBlock, value: unknown, scope: CanvasSuggestionRefreshScope): CanvasBlock {
  const parsed = canvasPreparedSelectionReplacementSchema.safeParse(value);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? 'the selected-text replacement is invalid.');
  const edit = parsed.data;
  const block = canonicalBlock(base);
  if (!scope.selection || edit.id !== scope.blockId || block.id !== scope.blockId || block.kind !== 'text') invalid('a selected-text replacement needs the exact captured text item.');
  assertCanvasSuggestionRefreshScope({ version: 1, title: 'Selection validation', subtitle: '', layout: 'focus', blocks: [block] }, scope);
  const { start, end } = scope.selection;
  return canonicalBlock({ ...block, body: block.body.slice(0, start) + edit.text + block.body.slice(end) });
}

function entries(block: CanvasBlock, name: Collection): Entry[] {
  if (name === 'layers' && block.kind === 'design') return block.layers as unknown as Entry[];
  if (name === 'items' && (block.kind === 'checklist' || block.kind === 'timeline')) return block.items as unknown as Entry[];
  if (name === 'rows' && block.kind === 'table') return block.rows as unknown as Entry[];
  return invalid(`${name} is not a registered collection for ${block.kind}.`);
}

function clockMinutes(value: unknown, end: boolean): number {
  if (typeof value !== 'string' || !(end ? endClock : startClock).test(value)) invalid(`use ${end ? '00:00–24:00' : '00:00–23:59'} clock notation.`);
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp), pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dueTimestamp(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) invalid('a due date needs null or YYYY-MM-DDTHH:MM local time.');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || localDateTime(timestamp) !== value) invalid('the due date is not a real local date and time.');
  return timestamp;
}

function insertedEntry(block: CanvasBlock, name: Collection, value: unknown): Entry {
  let schema: z.ZodType;
  if (name === 'layers' && block.kind === 'design') schema = canvasDesignLayerSchema;
  else if (name === 'items' && block.kind === 'checklist') schema = checklistItem;
  else if (name === 'items' && block.kind === 'timeline') schema = timelineItem;
  else if (name === 'rows' && block.kind === 'table') schema = tableRow;
  else return invalid(`${name} is not a registered collection for ${block.kind}.`);
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(`the inserted ${name} entry does not match its registered fields.`);
  if (block.kind === 'timeline' && name === 'items') {
    const { startTime, endTime, ...rest } = parsed.data as z.infer<typeof timelineItem>;
    return { ...rest, startMinutes: clockMinutes(startTime, false), endMinutes: clockMinutes(endTime, true) };
  }
  return parsed.data as Entry;
}

/**
 * Expand a compact wire patch against an exact canonical original. The result is
 * still untrusted proposed data: callers retain pins, resources, captured revision,
 * timer, formula, linked-document and saved-before checks before any application.
 */
export function applyCanvasPatch(base: CanvasBlock, patch: unknown, options: { allowUnchanged?: true } = {}): CanvasBlock {
  const parsed = z.union([canvasPatchSchema, canvasBlockPatchSchema, canvasPreparedPatchSchema]).safeParse(patch);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? 'use registered changes only.');
  const value = parsed.data;
  const original = canonicalBlock(base);
  if (value.id !== original.id) invalid('the patch identity does not match its original item.');
  if (original.pinned) invalid('unpin this item before proposing a change.');
  const result = structuredClone(original);
  const fieldWrites = new Set<string>(), structuralWrites = new Map<string, 'insert' | 'remove' | 'move'>();
  const entityKey = (name: Collection, id: string) => JSON.stringify([name, id]);
  const removed = new Set(value.changes.flatMap(change => change.type === 'remove' ? [entityKey(change.collection, change.id)] : []));
  const fieldWrite = (entity: string, field: string) => {
    if (structuralWrites.has(entity) && structuralWrites.get(entity) !== 'move') invalid('an entry cannot be inserted or removed and edited in the same patch.');
    const key = `${entity}\u0000${field}`;
    if (fieldWrites.has(key)) invalid('each registered field can be changed only once.');
    fieldWrites.add(key);
  };
  const structuralWrite = (entity: string, type: 'insert' | 'remove' | 'move') => {
    if (structuralWrites.has(entity) || (type !== 'move' && [...fieldWrites].some(key => key.startsWith(`${entity}\u0000`)))) invalid('the patch contains duplicate or overlapping entry changes.');
    structuralWrites.set(entity, type);
  };
  const insertionIndex = (list: Entry[], name: Collection, afterId: string | null) => {
    if (afterId === null) return 0;
    if (removed.has(entityKey(name, afterId))) invalid('an insertion or move anchor cannot also be removed.');
    const index = list.findIndex(entry => entry.id === afterId);
    if (index < 0) invalid('the insertion or move anchor is missing.');
    return index + 1;
  };
  for (const change of value.changes) {
    if (change.type === 'adjust-image') {
      if (result.kind !== 'image') invalid('photo adjustments are available only on an image block.');
      fieldWrite('block', 'adjustments');
      // Preserve old absent/null representations for visually unchanged settings.
      if (!imageAdjustmentsEqual(result.adjustments, change.adjustments)) result.adjustments = change.adjustments;
    } else if (change.type === 'set') {
      if (change.target === null) {
        if (![...commonFields, ...blockFields[result.kind]].includes(change.field)) invalid(`${change.field} is not writable on ${result.kind}.`);
        fieldWrite('block', change.field);
        const destination = result as unknown as Record<string, unknown>;
        if (change.field === 'dueDate') destination.dueAt = dueTimestamp(change.value);
        else destination[change.field] = change.value;
      } else {
        const list = entries(result, change.target.collection), entry = list.find(item => item.id === change.target!.id);
        if (!entry) invalid('the selected collection entry is missing.');
        const allowed = change.target.collection === 'layers' && result.kind === 'design'
          ? ['name', 'x', 'y', 'width', 'height', ...layerFields[entry.kind as keyof typeof layerFields]]
          : result.kind === 'checklist' ? ['label', 'checked'] : ['title', 'startTime', 'endTime', 'status', 'detail'];
        if (!allowed.includes(change.field)) invalid(`${change.field} is not writable on this collection entry.`);
        fieldWrite(entityKey(change.target.collection, entry.id), change.field);
        if (change.field === 'startTime' || change.field === 'endTime') entry[change.field === 'startTime' ? 'startMinutes' : 'endMinutes'] = clockMinutes(change.value, change.field === 'endTime');
        else entry[change.field] = change.value;
      }
    } else if (change.type === 'set-cell') {
      if (result.kind !== 'table') invalid('table cells are available only on a table.');
      const row = result.rows.find(item => item.id === change.rowId);
      if (!row || change.column >= row.cells.length) invalid('the selected table cell is missing.');
      fieldWrite(entityKey('rows', change.rowId), `cell:${change.column}`);
      row.cells[change.column] = change.value;
    } else {
      const list = entries(result, change.collection);
      if (change.type === 'insert') {
        const entry = insertedEntry(result, change.collection, change.item);
        structuralWrite(entityKey(change.collection, entry.id), 'insert');
        if (list.some(item => item.id === entry.id)) invalid('the inserted entry identity already exists.');
        list.splice(insertionIndex(list, change.collection, change.afterId), 0, entry);
      } else {
        const index = list.findIndex(entry => entry.id === change.id);
        if (index < 0) invalid('the selected collection entry is missing.');
        structuralWrite(entityKey(change.collection, change.id), change.type);
        if (change.type === 'remove') list.splice(index, 1);
        else {
          if (change.afterId === change.id) invalid('an entry cannot move after itself.');
          const [entry] = list.splice(index, 1);
          list.splice(insertionIndex(list, change.collection, change.afterId), 0, entry!);
        }
      }
    }
  }
  if (result.kind === 'image' && result.assetId === null) {
    const adjustment = value.changes.find(change => change.type === 'adjust-image');
    if (adjustment?.adjustments != null) invalid('attach an image before adding photo adjustments.');
    // Clearing an attachment and its settings is one atomic data change. A
    // neutral object still needs removal even though it looks like null.
    if (adjustment && result.adjustments != null) result.adjustments = null;
  }
  const canonical = canonicalBlock(result);
  // Prepared wire plans may contain redundant preservation siblings. Their
  // caller can discard a fully validated unchanged result, but still must
  // validate the complete plan's effect. Direct patches remain strict.
  if (!options.allowUnchanged && canvasDataEqual(original, canonical)) invalid('the patch does not change this item.');
  return canonical;
}
