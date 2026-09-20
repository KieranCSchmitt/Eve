import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CoreStore } from '../../packages/core/src/index';
import { ProjectEdits, type CoreClient } from '../../apps/desktop/host/project-edits';
import {
  contentHash, parseOrbitConfig, serializeOrbitConfig,
  type BufferRevision, type EditorCoordinator,
} from '../../adapters/orbit/src/index';
import {
  ALL_CAPABILITIES, type AuthenticatedContext, type CoreCommandInput, type DispatchResult,
  type OrbitParameters, type ProjectEditObservation, type ProjectEditPreparation,
  type ProjectEditReceipt, type ProjectEditRecord,
} from '../../packages/contracts/src/index';

const auth: AuthenticatedContext = { actorId: 'desktop', origin: 'trusted-ui', capabilities: [...ALL_CAPABILITIES] };
let directory: string;
let file: string;
let dbPath: string;
let core: CoreStore;
let coordinator: ProjectEdits;
let editor: EditorCoordinator | null;
let editorFree: boolean;
let sequence = 0;
let calls: string[];
let beforeCall: ((method: string, payload: unknown) => void | Promise<void>) | undefined;
let afterCall: ((method: string, payload: unknown, result: unknown) => void | Promise<void>) | undefined;
let overrideCall: ((method: string, payload: unknown) => { value: unknown } | undefined) | undefined;

const task = () => core.snapshot().tasks.find(item => item.id === 'orbit')!;
const requestId = () => `host-edit-${++sequence}`;
const command = (value = 510): CoreCommandInput => ({
  type: 'SetParameter', requestId: requestId(), taskId: 'orbit',
  expectedEpoch: task().epoch, expectedRevision: task().parameters!.revision,
  name: 'transitionMs', value,
});
function success(result: DispatchResult) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

const client: CoreClient = async <T>(method: string, payload?: unknown): Promise<T> => {
  calls.push(method);
  await beforeCall?.(method, payload);
  const overridden = overrideCall?.(method, payload);
  if (overridden) return overridden.value as T;
  let result: unknown;
  switch (method) {
    case 'preflight': result = core.preflight(payload, auth); break;
    case 'dispatch': result = core.dispatch(payload, auth); break;
    case 'prepare-project-edit': {
      const p = payload as { command: CoreCommandInput; preparation: ProjectEditPreparation };
      result = core.prepareProjectEdit(p.command, auth, p.preparation); break;
    }
    case 'record-project-receipt': {
      const p = payload as { editId: string; receipt: ProjectEditReceipt };
      result = core.recordProjectEditReceipt(p.editId, p.receipt, auth); break;
    }
    case 'finalize-project-edit': result = core.finalizeProjectEdit(String(payload), auth); break;
    case 'pending-project-edits': result = core.listPendingProjectEdits(); break;
    case 'reconcile-project-edit': {
      const p = payload as { editId: string; observation: ProjectEditObservation };
      result = core.reconcileProjectEdit(p.editId, p.observation, auth); break;
    }
    case 'abort-project-edit': {
      const p = payload as { editId: string; observation: ProjectEditObservation };
      result = core.abortProjectEdit(p.editId, p.observation, auth); break;
    }
    default: throw new Error(`Unexpected coordinator method: ${method}`);
  }
  await afterCall?.(method, payload, result);
  return result as T;
};

/** Simulates only the public editor boundary; core, coordinator, adapter and disk are real. */
class DirtyBuffer implements EditorCoordinator {
  value: BufferRevision;
  replacements: { operationId: string; version: number }[] = [];
  inspectCount = 0;
  loseNextReply = false;
  typeBeforeNextReplace = false;

  constructor(text: string) {
    this.value = { uri: pathToFileURL(file).href, version: 7, hash: contentHash(text), text };
  }
  async inspect(target: string) {
    expect(target).toBe(file);
    this.inspectCount++;
    return { ...this.value };
  }
  async replace(revision: BufferRevision, text: string, operationId: string) {
    if (this.typeBeforeNextReplace) {
      this.typeBeforeNextReplace = false;
      this.type(serializeOrbitConfig({ ...parseOrbitConfig(this.value.text), durationMinutes: 43 }));
    }
    if (revision.version !== this.value.version || revision.hash !== this.value.hash) throw new Error('The user typed before the editor replacement.');
    this.type(text);
    this.replacements.push({ operationId, version: this.value.version });
    if (this.loseNextReply) { this.loseNextReply = false; throw new Error('Editor reply lost after applying the edit.'); }
    return { ...this.value };
  }
  type(text: string) {
    this.value = { ...this.value, text, hash: contentHash(text), version: this.value.version + 1 };
  }
}

function useDirtyBuffer(): DirtyBuffer {
  const config = parseOrbitConfig(readFileSync(file, 'utf8'));
  const buffer = new DirtyBuffer(serializeOrbitConfig({ ...config, name: 'Orbit — my unsaved draft', theme: '#a47051' }));
  editor = buffer;
  editorFree = false;
  const observed = parseOrbitConfig(buffer.value.text);
  const values: OrbitParameters = { theme: observed.theme, durationMinutes: observed.durationMinutes, transitionMs: observed.transitionMs, easing: observed.easing };
  expect(core.observeProjectParameters('orbit', values, auth).ok).toBe(true);
  return buffer;
}

function prepareWithoutWriting(input = command()): ProjectEditRecord {
  const flight = core.preflight(input, auth);
  if (!flight.ok || !flight.projectEdit) throw new Error('Expected a project-edit plan.');
  const beforeText = readFileSync(file, 'utf8');
  const afterText = serializeOrbitConfig({ ...parseOrbitConfig(beforeText), ...flight.projectEdit.after });
  const result = core.prepareProjectEdit(input, auth, { relativePath: 'eve.project.json', location: 'file', beforeText, afterText, beforeHash: contentHash(beforeText), afterHash: contentHash(afterText) });
  if (!result.ok || !result.edit) throw new Error('Expected a prepared journal entry.');
  return result.edit;
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'eve-host-edits-')));
  dbPath = join(directory, 'eve.sqlite');
  file = join(directory, 'eve.project.json');
  core = new CoreStore({ dbPath, orbitProjectPath: directory });
  writeFileSync(file, serializeOrbitConfig({ schemaVersion: 1, adapter: 'eve.orbit', name: 'Orbit', ...task().parameters!.values }));
  editor = null;
  editorFree = true;
  calls = [];
  beforeCall = undefined;
  afterCall = undefined;
  overrideCall = undefined;
  coordinator = new ProjectEdits(client, directory, () => editor, () => editorFree);
});
afterEach(() => { core.close(); rmSync(directory, { recursive: true, force: true }); });

describe('host project-edit integration', () => {
  it('refuses a changed project identity before reading or writing and preserves a prepared journal for review', async () => {
    const original = readFileSync(file, 'utf8');
    let valid = false;
    coordinator = new ProjectEdits(client, directory, () => editor, () => editorFree, async () => {
      if (!valid) throw new Error('The registered project directory was replaced.');
    });
    await expect(coordinator.current()).rejects.toThrow('directory was replaced');
    await expect(coordinator.dispatch(command())).rejects.toThrow('directory was replaced');
    expect(core.listPendingProjectEdits()).toEqual([]);
    valid = true;
    afterCall = method => { if (method === 'prepare-project-edit') valid = false; };
    await expect(coordinator.dispatch(command())).rejects.toThrow('directory was replaced');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(core.listPendingProjectEdits()).toHaveLength(1);
    expect(core.listPendingProjectEdits()[0]?.status).toBe('prepared');
    expect(task().parameters!.values.transitionMs).toBe(280);
  });

  it('applies and undoes a file-backed parameter through real journaled writes', async () => {
    const original = readFileSync(file, 'utf8');
    const applied = success(await coordinator.dispatch(command()));
    expect(parseOrbitConfig(readFileSync(file, 'utf8')).transitionMs).toBe(510);
    expect(task().parameters!.values.transitionMs).toBe(510);
    expect(core.listPendingProjectEdits()).toEqual([]);
    success(await coordinator.dispatch({ type: 'Undo', requestId: requestId(), taskId: 'orbit', expectedEpoch: task().epoch, operationId: applied.operation.id }));
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(task().parameters!.values.transitionMs).toBe(280);
    expect(task().parameters!.revision).toBe(2);
    expect(core.snapshot().recentActions.find(item => item.id === applied.operation.id)!.undone).toBe(true);
  });

  it('returns committed duplicate requests before another file write or journal preparation', async () => {
    const input = command();
    const first = success(await coordinator.dispatch(input));
    const inode = statSync(file).ino;
    calls.length = 0;
    const second = success(await coordinator.dispatch(input));
    expect(second.idempotent).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    expect(task().parameters!.revision).toBe(1);
    expect(statSync(file).ino).toBe(inode);
    expect(calls).toEqual(['preflight']);
  });

  it('rejects invalid input and stale revisions before preparing or changing a project file', async () => {
    const initial = readFileSync(file, 'utf8');
    const bad = await coordinator.dispatch(command(10_000));
    expect(bad.ok).toBe(false);
    expect(calls).toEqual(['preflight']);
    expect(readFileSync(file, 'utf8')).toBe(initial);
    expect(core.listPendingProjectEdits()).toEqual([]);
    const stale = command();
    success(await coordinator.dispatch(command(700)));
    const latest = readFileSync(file, 'utf8');
    expect((await coordinator.dispatch(stale)).ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(latest);
  });

  it('recovers a startup receipt loss without repeating the file write or changing the active task', async () => {
    const input = command();
    beforeCall = method => {
      if (method === 'record-project-receipt' || method === 'reconcile-project-edit') throw new Error('Core connection lost.');
    };
    await expect(coordinator.dispatch(input)).rejects.toThrow('Core connection lost.');
    expect(parseOrbitConfig(readFileSync(file, 'utf8')).transitionMs).toBe(510);
    expect(task().parameters!.values.transitionMs).toBe(280);
    expect(core.listPendingProjectEdits()[0]!.status).toBe('prepared');
    success(core.dispatch({ type: 'RecallTask', requestId: requestId(), taskId: 'photo-walk' }, auth));
    const inode = statSync(file).ino;
    core.close();
    core = new CoreStore({ dbPath });
    beforeCall = undefined;
    await coordinator.recover();
    expect(core.snapshot().activeTaskId).toBe('photo-walk');
    expect(task().parameters!.values.transitionMs).toBe(510);
    expect(core.listPendingProjectEdits()).toEqual([]);
    expect(statSync(file).ino).toBe(inode);
    expect(success(await coordinator.dispatch(input)).idempotent).toBe(true);
  });

  it('reconciles a lost final database response as a committed operation', async () => {
    let loseReply = true;
    afterCall = method => {
      if (method === 'finalize-project-edit' && loseReply) { loseReply = false; throw new Error('Final reply lost.'); }
    };
    const result = success(await coordinator.dispatch(command()));
    expect(result.idempotent).toBe(true);
    expect(task().parameters!.revision).toBe(1);
    expect(core.listPendingProjectEdits()).toEqual([]);
  });

  it('aborts a startup preparation when the original file is still present', async () => {
    const original = readFileSync(file, 'utf8');
    prepareWithoutWriting();
    core.close();
    core = new CoreStore({ dbPath });
    await coordinator.recover();
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(task().parameters!.revision).toBe(0);
    expect(core.listPendingProjectEdits()).toEqual([]);
    success(await coordinator.dispatch(command(620)));
  });

  it('preserves a concurrent disk edit and leaves a visible reconciliation conflict', async () => {
    let externalText = '';
    afterCall = method => {
      if (method === 'prepare-project-edit') {
        externalText = serializeOrbitConfig({ ...parseOrbitConfig(readFileSync(file, 'utf8')), durationMinutes: 42 });
        writeFileSync(file, externalText);
      }
    };
    await expect(coordinator.dispatch(command())).rejects.toThrow(/changed on disk/);
    expect(readFileSync(file, 'utf8')).toBe(externalText);
    expect(task().parameters!.values.durationMinutes).toBe(25);
    expect(task().parameters!.revision).toBe(0);
    expect(core.listPendingProjectEdits()[0]!.status).toBe('conflict');
    await expect(coordinator.recover()).rejects.toThrow(/needs review/);
    expect(readFileSync(file, 'utf8')).toBe(externalText);
  });

  it('applies and undoes an inactive dirty buffer without touching its disk file', async () => {
    const disk = readFileSync(file, 'utf8');
    const buffer = useDirtyBuffer();
    const dirtyOriginal = buffer.value.text;
    const applied = success(await coordinator.dispatch(command()));
    expect(parseOrbitConfig(buffer.value.text).transitionMs).toBe(510);
    expect(parseOrbitConfig(buffer.value.text).name).toBe('Orbit — my unsaved draft');
    expect(readFileSync(file, 'utf8')).toBe(disk);
    success(await coordinator.dispatch({ type: 'Undo', requestId: requestId(), taskId: 'orbit', expectedEpoch: task().epoch, operationId: applied.operation.id }));
    expect(buffer.value.text).toBe(dirtyOriginal);
    expect(buffer.replacements).toHaveLength(2);
    expect(buffer.replacements[0]!.operationId).not.toBe(buffer.replacements[1]!.operationId);
    expect(buffer.value.version).toBe(9);
    expect(task().parameters!.values.theme).toBe('#a47051');
    expect(readFileSync(file, 'utf8')).toBe(disk);
  });

  it('recovers an editor reply lost after a dirty-buffer edit without applying twice', async () => {
    const disk = readFileSync(file, 'utf8');
    const buffer = useDirtyBuffer();
    buffer.loseNextReply = true;
    const input = command();
    success(await coordinator.dispatch(input));
    expect(buffer.replacements).toHaveLength(1);
    expect(task().parameters!.values.transitionMs).toBe(510);
    expect(core.listPendingProjectEdits()).toEqual([]);
    expect(success(await coordinator.dispatch(input)).idempotent).toBe(true);
    expect(buffer.replacements).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(disk);
  });

  it('preserves typing that races an editor replacement', async () => {
    const disk = readFileSync(file, 'utf8');
    const buffer = useDirtyBuffer();
    const coreRevision = task().parameters!.revision;
    buffer.typeBeforeNextReplace = true;
    await expect(coordinator.dispatch(command())).rejects.toThrow(/user typed/);
    expect(parseOrbitConfig(buffer.value.text).durationMinutes).toBe(43);
    expect(buffer.replacements).toEqual([]);
    expect(task().parameters!.revision).toBe(coreRevision);
    expect(core.listPendingProjectEdits()[0]!.status).toBe('conflict');
    expect(readFileSync(file, 'utf8')).toBe(disk);
  });

  it('refuses writes when editor ownership is unknown', async () => {
    editorFree = false;
    const disk = readFileSync(file, 'utf8');
    await expect(coordinator.dispatch(command())).rejects.toThrow(/editor connection is recovering/);
    expect(readFileSync(file, 'utf8')).toBe(disk);
    expect(core.listPendingProjectEdits()).toEqual([]);
  });

  it('does not report startup recovery success when aborting the pending preparation fails', async () => {
    prepareWithoutWriting();
    overrideCall = method => method === 'abort-project-edit' ? { value: { ok: false, snapshot: core.snapshot(), error: { code: 'STORAGE_ERROR', message: 'The journal abort could not be saved.' } } } : undefined;
    await expect(coordinator.recover()).rejects.toThrow('The journal abort could not be saved.');
    expect(core.listPendingProjectEdits()).toHaveLength(1);
    expect(task().parameters!.revision).toBe(0);
  });
});
