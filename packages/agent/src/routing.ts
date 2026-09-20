import { canvasDocumentSchema, type CanvasBlock, type CanvasDocument } from '@eve/contracts';
import { isDeepStrictEqual } from 'node:util';
import type { AgentProvider, AgentRequest, RegisteredAction } from './contracts.js';
import { canvasLearningIsCurrent, canvasSuggestionRefreshIsCurrent, canvasSuggestionIsCurrent, validateParameter } from './contracts.js';

/** Adding something does not authorize deleting existing blocks. */
export const requestsCanvasAddition = (text: string): boolean => /^(?:(?:can|could|would) you |please )?(?:add|insert|attach|put)\b/i.test(text.trim()) && !/\b(?:remove|delete|replace|clear)\b/i.test(text);

export const requestsCanvasToolAddition = (text: string): boolean => requestsCanvasAddition(text) && /^(?:(?:can|could|would) you |please )?(?:add|insert|attach|put) (?:a |an |the |another |some )?(?:(?:blank|empty) )?(?:(?:due[ -]date|deadline|focus|line|bar|linked) )?(?:countdown|deadline|due date|timer|checklist|table|charts?|metrics?|key figures?|designs?|sources?|notebook|videos?|articles?|timeline|images?|pictures?)\b/i.test(text.trim()) && !/\b(?:and|then) (?:edit|rewrite|change|update|revise)\b/i.test(text);

/** Whole-request matches only: source excerpts never enter this routing function. */
export function routeRegisteredIntent(request: AgentRequest): RegisteredAction[] | null {
  if (request.priority !== 'foreground') return null;
  // A refresh is an explicit metadata-only model request, regardless of its text.
  if (request.canvasSuggestionRefresh || request.canvasLearning || request.canvasSelection) return null;
  if (!canvasSuggestionIsCurrent(request)) return null;
  if (request.canvasSuggestion) return routeCanvasTool(request);
  const text = request.intent.text.trim();
  const key = text.toLowerCase().replace(/[.!]$/, '');
  const activities = { 'show notes': 'notes', 'open notes': 'notes', 'show code': 'code', 'open code': 'code', 'show preview': 'preview', 'open preview': 'preview', 'show video': 'video', 'open video': 'video', 'show easing': 'easing', 'try the easing': 'easing' } as const;
  if (key in activities) return [{ type: 'ChangeAttention', activity: activities[key as keyof typeof activities] }];
  if (['back', 'go back', 'back to work', 'back to building'].includes(key)) return [{ type: 'RestoreCheckpoint' }];
  if (key === 'undo') return [{ type: 'Undo' }];
  if (key === 'pause assistance') return [{ type: 'PauseAssistance' }];
  const recall = /^(?:find|recall)\s+(.{1,120})$/i.exec(text);
  if (recall && !/^(?:me )?(?:some |an? )?(?:articles?|videos?|sources?|links?|research)\b/i.test(recall[1]!.trim())) return [{ type: 'RecallTask', query: recall[1]!.trim() }];
  const timing = /^set\s+(transition|timer)\s+to\s+(\d+)\s*(ms|milliseconds|minutes|min)$/i.exec(text);
  if (timing) {
    const targets = request.targets.filter(target => target.kind === 'parameters');
    if (targets.length !== 1) return null;
    const name = timing[1]!.toLowerCase() === 'transition' ? 'transitionMs' : 'durationMinutes';
    const unit = timing[3]!.toLowerCase();
    if ((name === 'transitionMs' && !['ms', 'milliseconds'].includes(unit)) || (name === 'durationMinutes' && !['minutes', 'min'].includes(unit))) return null;
    const value = Number(timing[2]);
    if (!validateParameter(name, value)) return null;
    return [{ type: 'SetParameter', targetId: targets[0]!.id, expectedRevision: targets[0]!.revision, name, value }];
  }
  return routeCanvasTool(request);
}

/** An unavailable local role never causes a silent cloud escalation in local-only/offline. */
export function chooseProvider(request: AgentRequest, providers: readonly AgentProvider[]): AgentProvider | undefined {
  const selectedPassage = (!!request.canvasLearning && canvasLearningIsCurrent(request)) || (!!request.canvasSuggestionRefresh?.scope?.selection && canvasSuggestionRefreshIsCurrent(request));
  const available = providers.filter(provider => provider.enabled && provider.roles.includes(request.role) && (!provider.requestScope || selectedPassage))
    .sort((left, right) => Number(!!right.requestScope) - Number(!!left.requestScope));
  const local = available.find(provider => provider.kind === 'local');
  if (request.policy !== 'hybrid') return local;
  const cloud = available.find(provider => provider.kind === 'cloud');
  return cloud ?? local;
}

/** Installed tool creation is ordinary local interaction, not a model completion.
 * Match the complete explicit request; never scan reference text or guess at extra instructions. */
function routeCanvasTool(request: AgentRequest): RegisteredAction[] | null {
  const targets = request.targets.filter(target => target.kind === 'canvas');
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  const text = request.intent.text.trim().replace(/[.!?]$/, '').replace(/^(?:can|could|would) you /i, '');
  const compose = (document: CanvasDocument): RegisteredAction[] | null => {
    const scope = request.canvasSuggestion?.targetBlockId;
    if (scope !== undefined && scope !== null && target.canvas?.blocks.some(block => block.id !== scope && !isDeepStrictEqual(document.blocks.find(next => next.id === block.id), block))) return null;
    const parsed = canvasDocumentSchema.safeParse(document);
    return parsed.success ? [{ type: 'ComposeCanvas', targetId: target.id, expectedRevision: target.revision, document: parsed.data }] : null;
  };
  // A stated intention to write opens a writing surface. A request to write FOR the
  // user, generate an outline, or draft prose is intentionally left to inference.
  const writing = /^(?:i (?:need to|want to|would like to|wanna) (?:write|work on) |(?:start|open|create) (?:a |an |my )?(?:blank )?)(?:a |an |my |the )?(essay|story|report|article|document|letter|paper|poem|novel|journal|blog post)(?: (?:about|on|called|titled) (.{1,140}))?$/i.exec(text);
  if (writing && request.role === 'prepare' && !target.canvas && !/\b(?:and|then|with|outline|draft|generate|for me)\b/i.test(writing[2] ?? '')) {
    const subject = writing[2]?.trim();
    const title = subject ? subject[0]!.toUpperCase() + subject.slice(1) : writing[1]![0]!.toUpperCase() + writing[1]!.slice(1);
    return compose({ version: 1, title, subtitle: '', layout: 'focus', blocks: [{ id: 'writing', kind: 'text', title: '', body: '', placement: 'main', pinned: false, sourceIds: [] }] });
  }
  const suppliedDate = text.replace(/^(?:(?:set|change|update) (?:the |my )?(?:due date|deadline)(?: to| for)? |(?:it(?:'s| is) due|due(?: date)?(?: is)?) )/i, '');
  const dueAt = parseDeadlineDate(suppliedDate, request.context.createdAt);
  if (dueAt !== undefined && target.canvas) {
    const candidates = target.canvas.blocks.filter(block => block.kind === 'deadline' && !block.pinned && (block.dueAt === null || /^(?:set|change|update)\b/i.test(text)));
    if (candidates.length !== 1) return null;
    return compose({ ...target.canvas, blocks: target.canvas.blocks.map(block => block.id === candidates[0]!.id && block.kind === 'deadline' ? { ...block, dueAt } : block) });
  }
  const datedAddition = /^(?:please )?(?:add|insert|create|put) (?:a |an |the )?(?:due[ -]date countdown|deadline countdown|countdown|due date|deadline) (?:for|due|on) (.+)$/i.exec(text);
  const additionDate = datedAddition ? parseDeadlineDate(datedAddition[1]!, request.context.createdAt) : undefined;
  if (datedAddition && additionDate === undefined) return null;
  const add = /^(?:please )?(?:add|insert|create|put)(?: me)? (?:a |an |the )?(due[ -]date countdown|deadline countdown|countdown|due date|deadline|checklist|notebook|sources|chart|metric|key figure|design(?: surface)?|(?:blank |empty )?(?:image|photo|picture)(?: (?:block|slot))?)(?: (?:here|to (?:this|the|my) (?:canvas|page|space)|please))?$/i.exec(text);
  const timer = /^(?:please )?(?:add|insert|create) (?:a |an )?(\d{1,5})[ -](second|minute|hour)s? (?:focus )?timer(?: here| please)?$/i.exec(text);
  if (!add && !timer && !datedAddition) return null;
  const existing = target.canvas;
  const kind = timer ? 'timer' : datedAddition ? 'deadline' : /countdown|due date|deadline/i.test(add![1]!) ? 'deadline' : /^design/i.test(add![1]!) ? 'design' : /\b(?:image|photo|picture)\b/i.test(add![1]!) ? 'image' : add![1]!.toLowerCase() === 'notebook' ? 'note' : add![1]!.toLowerCase() === 'key figure' ? 'metric' : add![1]!.toLowerCase() as 'checklist' | 'sources' | 'chart' | 'metric';
  // Reuse an unfinished date control instead of adding a duplicate.
  const pendingDeadline = existing?.blocks.filter(block => block.kind === 'deadline' && block.dueAt === null && !block.pinned) ?? [];
  if (kind === 'deadline' && pendingDeadline.length === 1 && existing) return compose(additionDate === undefined ? existing : { ...existing, blocks: existing.blocks.map(block => block.id === pendingDeadline[0]!.id && block.kind === 'deadline' ? { ...block, dueAt: additionDate } : block) });
  const stem = kind === 'deadline' ? 'due-date' : kind;
  let id = stem, sequence = 1;
  while (existing?.blocks.some(block => block.id === id)) id = `${stem}-${++sequence}`;
  const base = { id, title: kind === 'deadline' ? 'Due date' : kind === 'timer' ? 'Timer' : kind === 'note' ? 'Notebook' : kind === 'sources' ? 'Sources' : kind === 'chart' ? 'A different perspective' : kind === 'metric' ? 'At a glance' : kind === 'design' ? 'Room to create' : kind === 'image' ? 'Image' : 'Checklist', placement: existing && kind !== 'design' ? 'aside' as const : 'main' as const, pinned: false, sourceIds: [] };
  let block: CanvasBlock;
  if (kind === 'deadline') block = { ...base, kind, dueAt: additionDate ?? null };
  else if (kind === 'timer') {
    const durationSeconds = Number(timer![1]) * (timer![2]!.toLowerCase() === 'hour' ? 3600 : timer![2]!.toLowerCase() === 'minute' ? 60 : 1);
    block = { ...base, kind, durationSeconds, remainingSeconds: durationSeconds, endsAt: null };
  } else if (kind === 'design') block = { ...base, kind, width: 960, height: 640, background: '#fbfbf8', layers: [] };
  else if (kind === 'chart') block = { ...base, kind, tableId: null, chartType: 'bar', labelColumn: 0, valueColumns: [] };
  else if (kind === 'metric') block = { ...base, kind, tableId: null, rowId: null, column: 0, prefix: '', suffix: '', decimals: 0 };
  else if (kind === 'checklist') block = { ...base, kind, items: [] };
  else if (kind === 'image') block = { ...base, kind, assetId: null, caption: '' };
  else block = { ...base, kind, description: '' };
  return compose(existing ? { ...existing, layout: existing.layout === 'focus' && block.placement === 'aside' ? 'split' : existing.layout, blocks: [...existing.blocks, block] } : { version: 1, title: request.purpose.split('\n')[0]!.slice(0, 160) || 'Your space', subtitle: '', layout: 'focus', blocks: [block] });
}


/** Narrow English/ISO dates only. A missing year means the next occurrence;
 * an omitted time means end of that day. Ambiguous dates stay in the inline editor. */
export function parseDeadlineDate(input: string, now: number): number | undefined {
  const text = input.trim().toLowerCase();
  const clock = (value?: string): [number, number] | undefined => {
    if (!value) return [23, 59];
    if (value === 'midnight') return [0, 0];
    if (value === 'noon') return [12, 0];
    const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(value);
    if (ampm) {
      const hour = Number(ampm[1]), minute = Number(ampm[2] ?? 0);
      if (hour < 1 || hour > 12 || minute > 59) return undefined;
      return [hour % 12 + (ampm[3] === 'pm' ? 12 : 0), minute];
    }
    const military = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    return military ? [Number(military[1]), Number(military[2])] : undefined;
  };
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) return undefined;
  let year: number, month: number, day: number, time: [number, number] | undefined;
  let nextOccurrence = false;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}:\d{2}))?$/.exec(text);
  const relative = /^(today|tomorrow)(?: at (.+))?$/.exec(text);
  const named = /^(january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?(?: at (.+))?$/.exec(text);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]) - 1; day = Number(iso[3]); time = clock(iso[4]);
  } else if (relative) {
    const date = new Date(current.getFullYear(), current.getMonth(), current.getDate() + (relative[1] === 'tomorrow' ? 1 : 0));
    year = date.getFullYear(); month = date.getMonth(); day = date.getDate(); time = clock(relative[2]);
  } else if (named) {
    year = named[3] ? Number(named[3]) : current.getFullYear();
    month = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(named[1]!);
    day = Number(named[2]); time = clock(named[4]); nextOccurrence = !named[3];
  } else return undefined;
  if (!time || year < 1970 || year > 9999) return undefined;
  const build = () => new Date(year, month, day, time![0], time![1]);
  let date = build();
  // Reject invalid calendar dates and nonexistent local clock times, not normalize them silently.
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day || date.getHours() !== time[0] || date.getMinutes() !== time[1]) return undefined;
  if (nextOccurrence && date.getTime() < now) { year++; date = build(); }
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day && date.getHours() === time[0] && date.getMinutes() === time[1] ? date.getTime() : undefined;
}
