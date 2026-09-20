import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { FrameDecoder, encodeFrame, type BridgeMessage, type BridgeRequest, type DocumentState, type EditorCheckpoint, type EditRequest, type Point, type RecoveryDocument, type WorkbenchContext, type WorkbenchMethod } from './protocol';
import { DurableEditAcknowledgements } from './durable-edits';
import { OrphanRecoveryWriter } from './recovery-journal';

const capabilities: WorkbenchMethod[] = ['context', 'document.inspect', 'checkpoint.capture', 'checkpoint.restore', 'edit.apply', 'dirty.list', 'files.saveAll', 'files.closeWithPrompt', 'recovery.capture', 'recovery.restore'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const point = (position: vscode.Position): Point => ({ line: position.line, character: position.character });
const range = (value: vscode.Range) => ({ start: point(value.start), end: point(value.end) });
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

function documentState(document: vscode.TextDocument, withText = false): DocumentState {
  const text = document.getText();
  if (withText && Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error('A dirty buffer exceeds the recovery size limit. Save it in the workbench before leaving.');
  return { uri: document.uri.toString(), version: document.version, hash: hash(text), languageId: document.languageId, dirty: document.isDirty, untitled: document.isUntitled, bytes: Buffer.byteLength(text), ...(withText ? { text } : {}) };
}

function context(): WorkbenchContext {
  const editor = vscode.window.activeTextEditor;
  const selectedText = editor ? editor.selections.map(selection => editor.document.getText(selection)).join('\n') : '';
  return {
    workspace: (vscode.workspace.workspaceFolders ?? []).map(folder => ({ uri: folder.uri.toString(), name: folder.name })),
    active: editor ? { ...documentState(editor.document), selections: editor.selections.map(selection => ({ anchor: point(selection.anchor), active: point(selection.active) })), selectedText: selectedText.slice(0, 65536), selectionTruncated: selectedText.length > 65536, visibleRanges: editor.visibleRanges.map(range) } : null,
    documents: vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' || document.isUntitled).map(document => documentState(document)),
    diagnostics: vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => diagnostics.map(diagnostic => ({ uri: uri.toString(), message: diagnostic.message.slice(0, 2048), severity: diagnostic.severity, range: range(diagnostic.range) }))).slice(0, 200),
  };
}

function captureCheckpoint(): EditorCheckpoint | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  return { uri: editor.document.uri.toString(), selections: editor.selections.map(selection => ({ anchor: point(selection.anchor), active: point(selection.active) })), visibleRanges: editor.visibleRanges.map(range), viewColumn: editor.viewColumn ?? 1, version: editor.document.version };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 8192): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid text parameter.');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error('Invalid nonnegative integer parameter.');
  return value as number;
}
function position(value: unknown): vscode.Position {
  const p = record(value);
  return new vscode.Position(integer(p.line), integer(p.character));
}

async function scopedUri(value: unknown): Promise<vscode.Uri> {
  const uri = vscode.Uri.parse(text(value));
  if (uri.scheme === 'untitled' && vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString())) return uri;
  if (uri.scheme !== 'file') throw new Error('Only project files and existing untitled buffers may be accessed.');
  const resolved = await realpath(uri.fsPath);
  const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => realpath(folder.uri.fsPath)));
  if (!roots.some(root => resolved.startsWith(`${root}${path.sep}`))) throw new Error('This document is outside the authorized workspace.');
  return vscode.Uri.file(resolved);
}

async function restoreCheckpoint(value: unknown) {
  const snapshot = record(value);
  const document = await vscode.workspace.openTextDocument(await scopedUri(snapshot.uri));
  const editor = await vscode.window.showTextDocument(document, { viewColumn: Math.max(1, Math.min(9, integer(snapshot.viewColumn))), preserveFocus: false, preview: false });
  if (!Array.isArray(snapshot.selections) || snapshot.selections.length === 0 || snapshot.selections.length > 100) throw new Error('Invalid checkpoint selection.');
  editor.selections = snapshot.selections.map(value => {
    const selection = record(value);
    return new vscode.Selection(document.validatePosition(position(selection.anchor)), document.validatePosition(position(selection.active)));
  });
  if (Array.isArray(snapshot.visibleRanges) && snapshot.visibleRanges.length) {
    const first = record(snapshot.visibleRanges[0]);
    const start = document.validatePosition(position(first.start));
    editor.revealRange(new vscode.Range(start, start), vscode.TextEditorRevealType.AtTop);
  }
  return { restored: true, checkpoint: captureCheckpoint(), precision: 'logical-selection-and-vertical-anchor' };
}

type AppliedRecovery = (documents: readonly vscode.TextDocument[], fallback: readonly DocumentState[]) => Promise<RecoveryDocument[]>;
function editRecoveryCallbacks(documents: readonly vscode.TextDocument[], recoverApplied: AppliedRecovery) {
  // Separate closure scope from replacement strings; closed documents need not stay alive in this cache.
  const references = documents.map(document => new WeakRef(document));
  const current = () => references.flatMap(reference => { const document = reference.deref(); return document && !document.isClosed ? [document] : []; });
  return {
    inspect: () => current().map(document => documentState(document, true)),
    recover: (fallback: readonly DocumentState[]) => recoverApplied(current(), fallback),
  };
}
async function applyEdit(value: unknown, acknowledgements: DurableEditAcknowledgements, recoverApplied: AppliedRecovery) {
  const request = record(value);
  const operationId = text(request.operationId, 128);
  if (!operationId) throw new Error('An operation ID is required.');
  if (!Array.isArray(request.documents) || request.documents.length < 1 || request.documents.length > 20) throw new Error('Invalid document edit collection.');
  const edits: EditRequest['documents'] = request.documents.map(value => {
    const document = record(value);
    return { uri: text(document.uri), expectedVersion: integer(document.expectedVersion), expectedHash: text(document.expectedHash, 64), text: text(document.text, MAX_DOCUMENT_BYTES) };
  });
  if (edits.some(edit => Buffer.byteLength(edit.text) > MAX_DOCUMENT_BYTES)) throw new Error('A replacement exceeds the document recovery size limit.');
  if (new Set(edits.map(edit => edit.uri)).size !== edits.length) throw new Error('Duplicate document targets are not allowed.');
  const fingerprint = hash(JSON.stringify(edits));
  return acknowledgements.run(operationId, fingerprint, async () => {
    const documents = await Promise.all(edits.map(async edit => vscode.workspace.openTextDocument(await scopedUri(edit.uri))));
    if (new Set(documents.map(document => document.uri.toString())).size !== documents.length) throw new Error('Duplicate canonical document targets are not allowed.');
    const validateVersions = () => {
      for (let index = 0; index < edits.length; index++) {
        const edit = edits[index]!;
        const document = documents[index]!;
        if (document.isClosed || document.version !== edit.expectedVersion || hash(document.getText()) !== edit.expectedHash) throw new Error('STALE_DOCUMENT: The document changed after this edit was prepared.');
      }
    };
    validateVersions();
    return {
      intended: documents.map((document, index) => ({ uri: document.uri.toString(), hash: hash(edits[index]!.text) })),
      maximumRecoveryBytes: documents.reduce((bytes, document) => bytes + 2 * MAX_DOCUMENT_BYTES + 2 * document.uri.toString().length + 4096, 0),
      ...editRecoveryCallbacks(documents, recoverApplied),
      apply: () => {
        const workspaceEdit = new vscode.WorkspaceEdit();
        // No await between checking every version and dispatching the one WorkspaceEdit.
        validateVersions();
        for (let index = 0; index < edits.length; index++) {
          const edit = edits[index]!;
          const document = documents[index]!;
          workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), edit.text);
        }
        return Promise.resolve(vscode.workspace.applyEdit(workspaceEdit));
      },
    };
  });
}

async function captureRecovery(include: readonly vscode.TextDocument[] = [], fallback: readonly DocumentState[] = []): Promise<RecoveryDocument[]> {
  const documents = await Promise.all(vscode.workspace.textDocuments.filter(document => document.isDirty || include.includes(document)).map(async document => {
    const state = documentState(document, true);
    let diskHash: string | null = null;
    if (document.uri.scheme === 'file') {
      try { diskHash = hash(await readFile(document.uri.fsPath, 'utf8')); } catch { /* Deleted files recover as untitled. */ }
    }
    return { ...state, text: state.text!, diskHash };
  }));
  // If an applied document closed during persistence, retain its captured text as a recoverable copy.
  // An open, newer version always wins; never overwrite its recovery with a failed attempt's old text.
  for (const state of fallback) {
    if (!documents.some(document => document.uri === state.uri) && typeof state.text === 'string') documents.push({ ...state, text: state.text, diskHash: null });
  }
  return documents;
}

async function restoreRecovery(value: unknown) {
  const snapshot = record(value);
  const content = text(snapshot.text, MAX_DOCUMENT_BYTES);
  const language = text(snapshot.languageId, 128);
  // Recovery always opens a separate unsaved buffer. It never writes older content over disk.
  const recovered = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(recovered, { preview: false });
  return { recoveredUri: recovered.uri.toString(), originalUri: text(snapshot.uri), savedToDisk: false };
}

async function dispatch(request: BridgeRequest, acknowledgements: DurableEditAcknowledgements, recoverApplied: AppliedRecovery, flushRecovery: () => Promise<RecoveryDocument[]>): Promise<unknown> {
  switch (request.method) {
    case 'context': return context();
    case 'document.inspect': {
      const params = record(request.params);
      const uri = await scopedUri(params.uri);
      const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      const maximumBytes = params.maxBytes === undefined ? MAX_DOCUMENT_BYTES : integer(params.maxBytes);
      if (maximumBytes < 1 || maximumBytes > MAX_DOCUMENT_BYTES) throw new Error('Invalid document capture byte limit.');
      if (document && Buffer.byteLength(document.getText(), 'utf8') > maximumBytes) throw new Error('The selected buffer exceeds the requested capture limit. Select a smaller document; its content was not transferred.');
      // Report the editor's actual newline policy even for a single-line buffer.
      // Keep this out of documentState(), which also serializes recovery evidence.
      return document ? { ...documentState(document, true), eol: document.eol === vscode.EndOfLine.CRLF ? 'crlf' : 'lf' } : null;
    }
    case 'checkpoint.capture': return captureCheckpoint();
    case 'checkpoint.restore': return restoreCheckpoint(request.params);
    case 'edit.apply': return applyEdit(request.params, acknowledgements, recoverApplied);
    case 'dirty.list': return vscode.workspace.textDocuments.filter(document => document.isDirty).map(document => documentState(document, true));
    case 'files.saveAll': {
      const saved = await vscode.workspace.saveAll(true);
      // A successful save must not leave this session's old dirty orphan waiting on the timer.
      const remaining = (await flushRecovery()).map(({ text: _text, diskHash: _diskHash, ...document }) => document);
      return { saved: saved && remaining.length === 0, remaining };
    }
    case 'files.closeWithPrompt': {
      const params = record(request.params);
      if (!Array.isArray(params.documents) || params.documents.length > 100) throw new Error('Invalid document list.');
      const requested = params.documents.map(value => { const document = record(value); return { uri: text(document.uri), version: integer(document.version) }; });
      for (const item of requested) {
        const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === item.uri);
        if (!document || document.version !== item.version) throw new Error('The dirty document list changed. Review it before closing.');
      }
      const targets = new Set(requested.map(item => item.uri));
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && targets.has(tab.input.uri.toString()));
      // The documented close API presents the workbench's Save / Don't Save / Cancel UI.
      const closed = await vscode.window.tabGroups.close(tabs, true);
      return { closed, remaining: vscode.workspace.textDocuments.filter(document => document.isDirty).map(document => documentState(document)) };
    }
    case 'recovery.capture': return flushRecovery();
    case 'recovery.restore': return restoreRecovery(request.params);
  }
}

export async function activate(extension: vscode.ExtensionContext) {
  const socketPath = process.env.EVE_WORKBENCH_SOCKET;
  const tokenPath = process.env.EVE_WORKBENCH_TOKEN_FILE;
  const recoveryFile = process.env.EVE_WORKBENCH_RECOVERY_FILE;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  status.text = '$(circle-outline) Eve';
  status.tooltip = 'Eve integration is waiting for its host.';
  status.show();
  extension.subscriptions.push(status);
  if (!socketPath || !tokenPath) return;

  let socket: Socket | undefined;
  let authenticated = false;
  let disposed = false;
  let reconnect: NodeJS.Timeout | undefined;
  let contextTimer: NodeJS.Timeout | undefined;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let handshakeTimer: NodeJS.Timeout | undefined;
  let pendingCommands = 0;
  let commandQueue = Promise.resolve();
  let recoveryQueue = Promise.resolve();
  const acknowledgements = new DurableEditAcknowledgements();
  const orphanWriter = new OrphanRecoveryWriter(recoveryFile);
  // Establish the session's directory identity before a host can request an edit.
  try { await orphanWriter.initialize(); } catch { reportRecoveryFailure(); }
  function reportRecoveryFailure() {
    status.text = '$(warning) Eve recovery';
    status.tooltip = 'A dirty buffer could not be durably captured. Save it in the workbench before leaving.';
    emit('dirty.changed', { error: 'A buffer could not be durably captured. Save it before leaving.', incomplete: true });
  }
  function queueRecovery(include: readonly vscode.TextDocument[] = [], fallback: readonly DocumentState[] = [], explicit = false): Promise<RecoveryDocument[]> {
    const pending = recoveryQueue.then(async () => {
      const documents = await captureRecovery(include, fallback);
      const root = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
      await orphanWriter.persist(root?.uri.fsPath, documents, { writeEmpty: explicit });
      if (explicit) {
        const current = vscode.workspace.textDocuments.filter(document => document.isDirty).map(document => documentState(document));
        if (current.length !== documents.length || current.some(document => !documents.some(captured => captured.uri === document.uri && captured.version === document.version && captured.hash === document.hash))) {
          throw new Error('RECOVERY_CHANGED: Editor buffers changed while recovery was being persisted. Capture them again before closing.');
        }
      }
      emit('dirty.changed', { documents: documents.filter(document => document.dirty), capturedAt: Date.now() });
      return documents;
    });
    recoveryQueue = pending.then(() => {}, reportRecoveryFailure);
    return pending;
  }
  function flushRecovery(): Promise<RecoveryDocument[]> {
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    // Only our own current-session orphan is replaced. Older/pending/unknown journals are untouched.
    return queueRecovery([], [], true);
  }
  const recoverApplied: AppliedRecovery = (documents, fallback) => queueRecovery(documents, fallback);
  function send(message: BridgeMessage) {
    if (!socket || socket.destroyed) return;
    if (socket.writableLength > 32 * 1024 * 1024) { socket.destroy(); return; }
    socket.write(encodeFrame(message));
  }
  function emit(event: 'context.changed' | 'dirty.changed' | 'intent.selection' | 'checkpoint.saved', data: unknown) {
    if (authenticated) send({ version: 1, type: 'event', event, data });
  }
  function scheduleContext() {
    clearTimeout(contextTimer);
    contextTimer = setTimeout(() => emit('context.changed', context()), 80);
  }
  function scheduleRecovery() {
    // Throttle instead of debounce: continuous typing must not indefinitely defer recovery.
    if (recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void queueRecovery().catch(() => { /* Reported by the shared writer. */ });
    }, 180);
  }
  async function connect() {
    if (disposed) return;
    try {
      const [tokenInfo, socketInfo, parentInfo] = await Promise.all([stat(tokenPath!), stat(socketPath!), stat(path.dirname(socketPath!))]);
      const uid = process.getuid?.();
      if (!tokenInfo.isFile() || !socketInfo.isSocket() || (tokenInfo.mode & 0o077) || (socketInfo.mode & 0o077) || (parentInfo.mode & 0o077) || (uid !== undefined && [tokenInfo, socketInfo, parentInfo].some(info => info.uid !== uid))) throw new Error('Unsafe bridge permissions.');
      const token = (await readFile(tokenPath!, 'utf8')).trim();
      if (token.length < 32 || token.length > 256) throw new Error('Invalid bridge token.');
      const decoder = new FrameDecoder();
      socket = createConnection(socketPath!);
      const connection = socket;
      handshakeTimer = setTimeout(() => { if (!authenticated) connection.destroy(); }, 5000);
      socket.once('connect', () => send({ version: 1, type: 'hello', token, pid: process.pid, capabilities }));
      socket.on('data', chunk => {
        try {
          for (const raw of decoder.feed(chunk)) {
            const message = record(raw);
            if (message.version !== 1) throw new Error('Incompatible protocol.');
            if (!authenticated) {
              if (message.type !== 'welcome' || message.accepted !== true) throw new Error('Bridge authentication rejected.');
              authenticated = true;
              clearTimeout(handshakeTimer);
              status.text = '$(check) Eve';
              status.tooltip = 'Connected to Eve. Your place and dirty buffers are shared with your local workspace.';
              scheduleContext(); scheduleRecovery();
              continue;
            }
            if (message.type !== 'request' || typeof message.id !== 'string' || message.id.length > 128 || !capabilities.includes(message.method as WorkbenchMethod)) throw new Error('Invalid bridge request.');
            if (pendingCommands >= 64) throw new Error('Workbench queue is full.');
            const request = message as unknown as BridgeRequest;
            pendingCommands++;
            commandQueue = commandQueue.then(async () => {
              try {
                if (socket !== connection || connection.destroyed || !authenticated) return;
                if (request.method === 'edit.apply' && !recoveryFile) throw new Error('Durable editor recovery must be configured before applying edits.');
                const result = await dispatch(request, acknowledgements, recoverApplied, flushRecovery);
                if (socket === connection && !connection.destroyed) send({ version: 1, type: 'response', id: request.id, result });
              }
              catch (error) {
                if (socket === connection && !connection.destroyed) send({ version: 1, type: 'response', id: request.id, error: { code: 'WORKBENCH_REJECTED', message: error instanceof Error ? error.message : 'The workbench request failed.' } });
              } finally { pendingCommands--; }
            });
          }
        } catch { socket?.destroy(); }
      });
      socket.on('error', () => {});
      socket.once('close', () => {
        clearTimeout(handshakeTimer);
        authenticated = false;
        status.text = '$(circle-outline) Eve';
        status.tooltip = 'Eve connection interrupted. Editing and native saves still work.';
        if (!disposed) reconnect = setTimeout(connect, 1500);
      });
    } catch {
      if (!disposed) reconnect = setTimeout(connect, 2000);
    }
  }
  extension.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(scheduleContext),
    vscode.window.onDidChangeTextEditorSelection(scheduleContext),
    vscode.window.onDidChangeTextEditorVisibleRanges(scheduleContext),
    vscode.workspace.onDidOpenTextDocument(() => { scheduleContext(); scheduleRecovery(); }),
    vscode.workspace.onDidCloseTextDocument(() => { scheduleContext(); scheduleRecovery(); }),
    vscode.workspace.onDidChangeTextDocument(() => { scheduleContext(); scheduleRecovery(); }),
    vscode.workspace.onDidSaveTextDocument(() => { scheduleContext(); scheduleRecovery(); }),
    vscode.languages.onDidChangeDiagnostics(scheduleContext),
    vscode.commands.registerCommand('eve.revealContext', () => emit('intent.selection', context())),
    vscode.commands.registerCommand('eve.captureCheckpoint', () => emit('checkpoint.saved', captureCheckpoint())),
    { dispose() { disposed = true; clearTimeout(reconnect); clearTimeout(contextTimer); clearTimeout(recoveryTimer); clearTimeout(handshakeTimer); socket?.destroy(); } },
  );
  void connect();
}

export function deactivate() { /* All handles belong to ExtensionContext subscriptions. */ }
