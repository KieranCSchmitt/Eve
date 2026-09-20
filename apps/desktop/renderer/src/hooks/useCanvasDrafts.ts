import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasDocument, CoreCommandInput, DispatchResult, TaskRecord } from '@eve/contracts';

interface Draft { document: CanvasDocument; baseRevision: number; requestId?: string; submitted?: CanvasDocument; submittedEpoch?: number }

/** Immediate edits; one serialized, revision-checked durable writer. Failed drafts stay visible. */
export function useCanvasDrafts(options: {
  getTask(id: string): TaskRecord | undefined;
  dispatch(command: CoreCommandInput): Promise<DispatchResult>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  onDirty(dirty: boolean): void;
}) {
  const optionsRef = useRef(options); optionsRef.current = options;
  const drafts = useRef(new Map<string, Draft>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [version, setVersion] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refresh = () => { setVersion(value => value + 1); optionsRef.current.onDirty(drafts.current.size > 0); };
  const flush = useCallback(async (taskId?: string) => {
    for (const id of taskId ? [taskId] : [...drafts.current.keys()]) {
      clearTimeout(timers.current.get(id)); timers.current.delete(id);
      for (let iteration = 0; drafts.current.has(id); iteration++) {
        if (iteration > 30) throw new Error('Finish typing, then try again. Your canvas is still here.');
        const draft = drafts.current.get(id)!;
        const task = optionsRef.current.getTask(id);
        if (!task) throw new Error('This space could not be found. Your draft is still here.');
        // Retry a lost acknowledgement with the same exact request before sending newer text.
        draft.requestId ??= crypto.randomUUID();
        draft.submitted ??= structuredClone(draft.document);
        draft.submittedEpoch ??= task.epoch;
        try {
          const result = await optionsRef.current.dispatch({ type: 'UpdateCanvas', requestId: draft.requestId, taskId: id, expectedEpoch: draft.submittedEpoch, expectedRevision: draft.baseRevision, document: draft.submitted });
          if (!result.ok) {
            // A definitive validation rejection wrote nothing. Allow a corrected
            // draft to become a fresh request; uncertain storage failures must
            // still retry the exact original request and epoch.
            if (result.error.code === 'INVALID_COMMAND') { delete draft.requestId; delete draft.submitted; delete draft.submittedEpoch; }
            throw new Error(result.error.code === 'REVISION_CONFLICT' ? 'A newer canvas was saved while you were editing. Your draft is still here.' : result.error.message);
          }
          const saved = result.snapshot.tasks.find(item => item.id === id)?.canvas;
          if (!saved) throw new Error('The save could not be confirmed. Your draft is still here.');
          if (drafts.current.get(id) === draft) {
            if (JSON.stringify(draft.document) === JSON.stringify(draft.submitted)) drafts.current.delete(id);
            else { draft.baseRevision = saved.revision; delete draft.requestId; delete draft.submitted; delete draft.submittedEpoch; }
          }
          setErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
          refresh();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Your canvas could not be saved. Your draft is still here.';
          setErrors(previous => ({ ...previous, [id]: message })); refresh(); throw new Error(message);
        }
      }
    }
  }, []);
  const queue = useCallback((taskId: string, document: CanvasDocument) => {
    const task = optionsRef.current.getTask(taskId); if (!task) return;
    const draft = drafts.current.get(taskId);
    if (draft) draft.document = document;
    else drafts.current.set(taskId, { document, baseRevision: task.canvas?.revision ?? 0 });
    refresh(); clearTimeout(timers.current.get(taskId));
    timers.current.set(taskId, setTimeout(() => { timers.current.delete(taskId); void optionsRef.current.enqueue(() => flush(taskId)).catch(() => {}); }, 350));
  }, [flush]);
  const resolve = useCallback((taskId: string, choice: 'saved' | 'draft', reviewedRevision: number) => {
    const task = optionsRef.current.getTask(taskId), draft = drafts.current.get(taskId);
    if (!draft || !task) return;
    if ((task.canvas?.revision ?? 0) !== reviewedRevision) {
      setErrors(previous => ({ ...previous, [taskId]: 'The saved canvas changed again. Review its latest version first.' })); return;
    }
    clearTimeout(timers.current.get(taskId)); timers.current.delete(taskId);
    if (choice === 'saved') drafts.current.delete(taskId);
    else { draft.baseRevision = reviewedRevision; delete draft.requestId; delete draft.submitted; delete draft.submittedEpoch; }
    setErrors(previous => { const next = { ...previous }; delete next[taskId]; return next; }); refresh();
    if (choice === 'draft') void optionsRef.current.enqueue(() => flush(taskId)).catch(() => {});
  }, [flush]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  return { queue, flush, resolve, errors, version, dirty: drafts.current.size > 0, hasDraft: (id: string) => drafts.current.has(id), document: (task: TaskRecord) => drafts.current.get(task.id)?.document ?? task.canvas?.document ?? null };
}
