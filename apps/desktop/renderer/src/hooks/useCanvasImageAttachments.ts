import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoreSnapshot, TaskRecord } from '@eve/contracts';
import type { CanvasImageAttachmentInput, TaskAsset } from '../../../shared/bridge';

interface Presentation { pending: boolean; needsCheck?: boolean; message?: string; canvasVersion?: string }
interface Attempt { taskId: string; blockId: string; requestId: string; input?: CanvasImageAttachmentInput; pending: boolean; cancelled: boolean; needsCheck: boolean }
interface Options {
  activeTaskId?: string;
  visible: boolean;
  getTask(taskId: string): TaskRecord | undefined;
  isCurrent(taskId: string): boolean;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  flush(taskId: string): Promise<void>;
  assets(taskId: string, assets: TaskAsset[]): void;
  snapshot(snapshot: CoreSnapshot): void;
}

/** A picker never occupies the renderer's draft-save queue. */
export function useCanvasImageAttachments(options: Options) {
  const current = useRef(options); current.current = options;
  const mounted = useRef(true);
  const attempts = useRef(new Map<string, Attempt>());
  const [states, setStates] = useState<Record<string, Record<string, Presentation>>>({});
  const version = (task?: TaskRecord) => task ? `${task.epoch}:${task.canvas?.revision ?? 'none'}` : undefined;
  const activeVersion = version(options.activeTaskId ? options.getTask(options.activeTaskId) : undefined);
  const show = (attempt: Attempt, state: Presentation) => {
    const presentation = { ...state, canvasVersion: !state.pending && !state.needsCheck ? version(current.current.getTask(attempt.taskId)) : undefined };
    // Only one attachment can be active per task. A new attempt also retires
    // feedback from its predecessor, rather than leaving it on another slot.
    if (mounted.current) setStates(previous => ({ ...previous, [attempt.taskId]: { [attempt.blockId]: presentation } }));
  };
  useEffect(() => {
    const taskId = options.activeTaskId;
    if (!taskId) return;
    const displayed = states[taskId];
    if (!displayed || !Object.values(displayed).some(state => !state.pending && !state.needsCheck && state.canvasVersion !== activeVersion)) return;
    setStates(previous => ({ ...previous, [taskId]: Object.fromEntries(Object.entries(previous[taskId] ?? {}).filter(([, state]) => state.pending || state.needsCheck || state.canvasVersion === activeVersion)) }));
  }, [options.activeTaskId, activeVersion, states]);
  const cancelTask = useCallback((taskId?: string) => {
    for (const attempt of attempts.current.values()) {
      if ((taskId && attempt.taskId !== taskId) || (!attempt.pending && !attempt.needsCheck)) continue;
      attempt.cancelled = true;
      if (attempt.pending) show(attempt, { pending: true, needsCheck: attempt.needsCheck, message: 'Cancelling image attachment…' });
      if (attempt.input) void window.eve.cancelCanvasImageAttachment({ taskId: attempt.taskId, requestId: attempt.requestId }).catch(() => {});
    }
  }, []);
  useEffect(() => {
    for (const attempt of attempts.current.values()) {
      if (attempt.taskId !== options.activeTaskId || !options.visible) cancelTask(attempt.taskId);
    }
  }, [options.activeTaskId, options.visible, cancelTask]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelTask(); }; }, [cancelTask]);

  const send = async (attempt: Attempt) => {
    if (!attempt.needsCheck && (attempt.cancelled || !current.current.isCurrent(attempt.taskId))) {
      attempt.pending = false;
      show(attempt, { pending: false, message: 'Image attachment cancelled.' });
      return;
    }
    try {
      const result = await window.eve.attachCanvasImage(attempt.input!);
      if (result.requestId !== attempt.requestId || result.taskId !== attempt.taskId || result.blockId !== attempt.blockId) throw new Error('The attachment receipt could not be verified.');
      attempt.needsCheck = result.status === 'uncertain';
      let message = result.message;
      // Read fresh state; a cached attachment receipt never rolls back a later
      // snapshot, navigation or authored draft. Managed bytes stay host-owned.
      await current.current.enqueue(async () => {
        current.current.assets(attempt.taskId, await window.eve.assets(attempt.taskId));
        const snapshot = await window.eve.snapshot();
        current.current.snapshot(snapshot);
        const block = snapshot.tasks.find(task => task.id === attempt.taskId)?.canvas?.document?.blocks.find(item => item.id === attempt.blockId);
        if (result.status === 'attached' && (!result.assetId || block?.kind !== 'image' || block.assetId !== result.assetId))
          message = 'The earlier image attachment was saved. Your current canvas is unchanged.';
      });
      show(attempt, { pending: false, needsCheck: attempt.needsCheck, message });
    } catch (error) {
      // The IPC may have failed after the host committed. Retain the same input
      // for an explicit receipt check; never reopen the picker on that retry.
      attempt.needsCheck = true;
      show(attempt, { pending: false, needsCheck: true, message: error instanceof Error ? error.message : 'The attachment could not be confirmed. Check its status.' });
    } finally { attempt.pending = false; }
  };
  const attach = (taskId: string, blockId: string, assetId?: string) => {
    const previous = attempts.current.get(taskId);
    if (previous?.pending || previous?.needsCheck) return;
    if (!current.current.isCurrent(taskId)) return;
    const attempt: Attempt = { taskId, blockId, requestId: crypto.randomUUID(), pending: true, cancelled: false, needsCheck: false };
    attempts.current.set(taskId, attempt);
    show(attempt, { pending: true, message: assetId ? 'Attaching image…' : 'Choose an image to attach…' });
    void current.current.enqueue(async () => {
      await current.current.flush(taskId);
      if (attempt.cancelled || !current.current.isCurrent(taskId)) throw new Error('Image attachment cancelled.');
      const task = current.current.getTask(taskId), block = task?.canvas?.document?.blocks.find(item => item.id === blockId);
      if (!task?.canvas || block?.kind !== 'image' || block.assetId !== null) throw new Error('Choose a current empty image slot.');
      attempt.input = { requestId: attempt.requestId, taskId, blockId, expectedEpoch: task.epoch, expectedRevision: task.canvas.revision,
        source: assetId ? { kind: 'existing', assetId } : { kind: 'import' } };
    }).then(() => send(attempt)).catch(error => {
      attempt.pending = false;
      show(attempt, { pending: false, message: error instanceof Error ? error.message : 'The current work could not be saved. Try attaching again after saving.' });
    });
  };
  const check = (taskId: string, blockId: string) => {
    const attempt = attempts.current.get(taskId);
    if (!attempt?.needsCheck || attempt.pending || attempt.blockId !== blockId || !attempt.input) return;
    attempt.pending = true;
    show(attempt, { pending: true, needsCheck: true, message: 'Checking image attachment…' });
    void send(attempt);
  };
  return { states, attach, check, cancelTask };
}
