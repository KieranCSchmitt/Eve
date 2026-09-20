import { z } from 'zod';
import { idSchema, type AssetRecord, type CoreCommandInput, type CoreSnapshot, type DispatchResult, type PreflightResult } from '@eve/contracts';
import type { CanvasImageAttachmentInput, CanvasImageAttachmentResult } from '../shared/bridge';

const inputSchema = z.object({
  requestId: idSchema, taskId: idSchema, blockId: idSchema,
  expectedEpoch: z.number().int().nonnegative(), expectedRevision: z.number().int().nonnegative(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('import') }).strict(),
    z.object({ kind: z.literal('existing'), assetId: idSchema }).strict(),
  ]),
}).strict();
const cancelSchema = z.object({ taskId: idSchema, requestId: idSchema }).strict();
type Update = Extract<CoreCommandInput, { type: 'UpdateCanvas' }>;
type Operation = {
  input: CanvasImageAttachmentInput;
  fingerprint: string;
  cancelled: boolean;
  assetId: string | null;
  imported: boolean;
  command?: Update;
  pending?: Promise<CanvasImageAttachmentResult>;
  result?: CanvasImageAttachmentResult;
};
interface Dependencies {
  snapshot(): Promise<CoreSnapshot>;
  records(taskId: string): Promise<AssetRecord[]>;
  importImage(taskId: string, sourcePath: string): Promise<AssetRecord>;
  chooseImage(): Promise<string | null>;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  dispatch(command: Update): Promise<DispatchResult>;
  preflight(command: Update): Promise<PreflightResult>;
  available(): boolean;
}

/** User-directed, exact-slot attachment. Models cannot invoke this operation. */
export class CanvasImageAttachments {
  private operations = new Map<string, Operation>();
  constructor(private dependencies: Dependencies) {}

  attach(raw: unknown): Promise<CanvasImageAttachmentResult> {
    const input = inputSchema.parse(raw), fingerprint = JSON.stringify(input);
    const previous = this.operations.get(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new Error('This attachment request has changed. Start a new attachment.'));
      if (previous.pending) return previous.pending;
      if (previous.result?.status !== 'uncertain') return Promise.resolve(previous.result!);
      // Only the exact already-dispatched command can settle a lost receipt.
      return this.run(previous, () => this.commit(previous, true));
    }
    if ([...this.operations.values()].some(item => item.input.taskId === input.taskId && (item.pending || item.result?.status === 'uncertain')))
      return Promise.reject(new Error('Finish or check the current image attachment first.'));
    for (const [id, item] of this.operations) {
      if (this.operations.size < 128) break;
      if (!item.pending && item.result?.status !== 'uncertain') this.operations.delete(id);
    }
    if (this.operations.size >= 128) return Promise.reject(new Error('Finish the outstanding image attachments before starting another.'));
    const operation: Operation = { input, fingerprint, cancelled: false, assetId: null, imported: false };
    this.operations.set(input.requestId, operation);
    return this.run(operation, () => this.prepare(operation));
  }

  cancel(raw: unknown): void {
    const input = cancelSchema.parse(raw), operation = this.operations.get(input.requestId);
    if (operation?.input.taskId === input.taskId) operation.cancelled = true;
  }
  cancelAll(): void { for (const operation of this.operations.values()) operation.cancelled = true; }

  private run(operation: Operation, work: () => Promise<CanvasImageAttachmentResult>) {
    const pending = Promise.resolve().then(work).catch(error => this.receipt(operation,
      operation.command ? 'uncertain' : operation.imported ? 'not-attached' : operation.cancelled ? 'cancelled' : 'failed',
      operation.command ? 'Eve could not confirm the attachment. Check its status before trying another image.'
        : operation.imported ? 'The image is saved in this space, but was not attached. Your current work is unchanged.'
        : error instanceof Error ? error.message : 'The image could not be attached. Your current work is unchanged.',
    )).then(result => { operation.result = result; return result; }).finally(() => { operation.pending = undefined; });
    operation.pending = pending;
    return pending;
  }
  private receipt(operation: Operation, status: CanvasImageAttachmentResult['status'], message: string): CanvasImageAttachmentResult {
    return { requestId: operation.input.requestId, taskId: operation.input.taskId, blockId: operation.input.blockId, status, assetId: operation.assetId, message };
  }
  private async capture(operation: Operation) {
    if (operation.cancelled) throw new Error('Image attachment cancelled.');
    if (!this.dependencies.available()) throw new Error('This attachment can no longer change the canvas.');
    const snapshot = await this.dependencies.snapshot(), input = operation.input;
    const task = snapshot.tasks.find(item => item.id === input.taskId);
    const block = task?.canvas?.document?.blocks.find(item => item.id === input.blockId);
    if (operation.cancelled) throw new Error('Image attachment cancelled.');
    if (!this.dependencies.available() || snapshot.activeTaskId !== input.taskId || task?.epoch !== input.expectedEpoch ||
        task.canvas?.revision !== input.expectedRevision || !task.canvas.document || block?.kind !== 'image' || block.assetId !== null)
      throw new Error('The canvas changed. Choose the image again for the current empty slot.');
    return task.canvas.document;
  }
  private async prepare(operation: Operation) {
    await this.capture(operation);
    const input = operation.input;
    if (input.source.kind === 'import') {
      const file = await this.dependencies.chooseImage();
      if (!file || operation.cancelled) return this.receipt(operation, 'cancelled', 'Image attachment cancelled.');
      // The picker never holds the write queue. Revalidate before copying, then
      // release the queue before the separate final canvas change.
      await this.dependencies.mutate(async () => {
        await this.capture(operation);
        const asset = await this.dependencies.importImage(input.taskId, file);
        operation.assetId = asset.id;
        operation.imported = true;
        if (asset.taskId !== input.taskId || !asset.mediaType.startsWith('image/')) throw new Error('Choose a supported image file.');
      });
    } else operation.assetId = input.source.assetId;
    return this.commit(operation, false);
  }
  private async commit(operation: Operation, retry: boolean): Promise<CanvasImageAttachmentResult> {
    return this.dependencies.mutate(async () => {
      if (retry) {
        if (!operation.command) throw new Error('There is no attachment receipt to check.');
        // Query the core's durable receipt before deciding whether any retry is
        // needed. Cancellation can settle history but never authorize a new write.
        const checked = await this.dependencies.preflight(operation.command);
        if (checked.ok && checked.duplicate) return this.receipt(operation, 'attached', 'Image attachment was saved. The original is preserved.');
        if (!checked.ok || operation.cancelled || !this.dependencies.available()) {
          operation.command = undefined;
          return this.receipt(operation, operation.imported ? 'not-attached' : operation.cancelled ? 'cancelled' : 'failed', operation.imported
            ? 'The image is saved in this space, but was not attached. Your current work is unchanged.'
            : operation.cancelled ? 'Image attachment cancelled.' : checked.ok ? 'This attachment can no longer change the canvas.' : checked.error.message);
        }
        const command = operation.command;
        operation.command = undefined;
        await this.capture(operation);
        operation.command = command;
      } else {
        const document = await this.capture(operation);
        const asset = (await this.dependencies.records(operation.input.taskId)).find(item => item.id === operation.assetId);
        if (!asset || asset.taskId !== operation.input.taskId || !asset.mediaType.startsWith('image/')) throw new Error('Choose an image saved in this space.');
        await this.capture(operation);
        operation.command = { type: 'UpdateCanvas', requestId: operation.input.requestId, taskId: operation.input.taskId,
          expectedEpoch: operation.input.expectedEpoch, expectedRevision: operation.input.expectedRevision,
          document: { ...document, blocks: document.blocks.map(block => block.id === operation.input.blockId && block.kind === 'image' ? { ...block, assetId: asset.id } : block) },
        };
      }
      const result = await this.dependencies.dispatch(operation.command!);
      if (!result.ok) {
        operation.command = undefined;
        return this.receipt(operation, operation.imported ? 'not-attached' : 'failed', operation.imported
          ? 'The image is saved in this space, but was not attached. Your current work is unchanged.' : result.error.message);
      }
      return this.receipt(operation, 'attached', 'Image attached. The original is preserved.');
    });
  }
}
