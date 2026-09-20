export const WORKBENCH_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export interface Point { line: number; character: number }
export interface Selection { anchor: Point; active: Point }
export interface VisibleRange { start: Point; end: Point }
export interface DocumentState {
  uri: string; version: number; hash: string; languageId: string; dirty: boolean;
  untitled: boolean; text?: string; bytes: number;
  /** Live document.inspect metadata only; not written into persisted recovery documents. */
  eol?: 'lf' | 'crlf';
}
export interface EditorCheckpoint {
  uri: string; selections: Selection[]; visibleRanges: VisibleRange[];
  viewColumn: number; version: number;
}
export interface WorkbenchContext {
  workspace: Array<{ uri: string; name: string }>;
  active: (DocumentState & { selections: Selection[]; selectedText: string; selectionTruncated: boolean; visibleRanges: VisibleRange[] }) | null;
  documents: DocumentState[];
  diagnostics: Array<{ uri: string; message: string; severity: number; range: VisibleRange }>;
}
export interface RecoveryDocument extends DocumentState { text: string; diskHash: string | null }
export type WorkbenchMethod = 'context' | 'document.inspect' | 'checkpoint.capture' | 'checkpoint.restore' | 'edit.apply' | 'dirty.list' | 'files.saveAll' | 'files.closeWithPrompt' | 'recovery.capture' | 'recovery.restore';
export interface BridgeRequest { version: 1; type: 'request'; id: string; method: WorkbenchMethod; params?: unknown }
export interface BridgeResponse { version: 1; type: 'response'; id: string; result?: unknown; error?: { code: string; message: string } }
export interface BridgeEvent { version: 1; type: 'event'; event: 'context.changed' | 'dirty.changed' | 'intent.selection' | 'checkpoint.saved'; data: unknown }
export interface BridgeHello { version: 1; type: 'hello'; token: string; pid: number; capabilities: WorkbenchMethod[] }
export interface BridgeWelcome { version: 1; type: 'welcome'; accepted: boolean }
export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent | BridgeHello | BridgeWelcome;
export interface ReplaceDocument { uri: string; expectedVersion: number; expectedHash: string; text: string }
export interface EditRequest { operationId: string; documents: ReplaceDocument[] }

/** Bounded newline JSON transport shared by the extension and its host. */
export class FrameDecoder {
  private buffered = Buffer.alloc(0);
  feed(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    let newline;
    while ((newline = this.buffered.indexOf(10)) !== -1) {
      if (newline > MAX_FRAME_BYTES) throw new Error('Workbench message exceeds the size limit.');
      const frame = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      if (frame.length) messages.push(JSON.parse(frame.toString('utf8')));
    }
    if (this.buffered.length > MAX_FRAME_BYTES) throw new Error('Workbench message exceeds the size limit.');
    return messages;
  }
}

export function encodeFrame(message: BridgeMessage): string {
  const serialized = JSON.stringify(message);
  if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) throw new Error('Workbench message exceeds the size limit.');
  return `${serialized}\n`;
}
