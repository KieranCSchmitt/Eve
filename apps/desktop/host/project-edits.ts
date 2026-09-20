import path from 'node:path';
import { contentHash, commitOrbitConfig, parseOrbitConfig, readOrbitConfig, serializeOrbitConfig, type EditorCoordinator } from '../../../adapters/orbit/src/index';
import type { CoreCommandInput, DispatchResult, PreflightResult, PrepareProjectEditResult, ProjectEditRecord, ProjectEditResult, ReconcileProjectEditResult } from '@eve/contracts';

export type CoreClient = <T>(method: string, payload?: unknown) => Promise<T>;

/** One coordinator owns the cross-resource boundary; SQLite never pretends a file is atomic with it. */
export class ProjectEdits {
  constructor(private core: CoreClient, private projectRoot: string, private editor: () => EditorCoordinator | null, private editorFree: () => boolean, private assertRootIdentity?: () => Promise<void>) {}

  async current() {
    await this.assertRootIdentity?.();
    const coordinator = this.editor();
    if (!coordinator && !this.editorFree()) throw new Error('The editor connection is recovering. Your project has not been changed.');
    const buffer = await coordinator?.inspect(path.join(this.projectRoot, 'eve.project.json'));
    if (buffer) return { text: buffer.text, hash: buffer.hash, config: parseOrbitConfig(buffer.text), location: 'buffer' as const, documentVersion: buffer.version };
    return { ...await readOrbitConfig(this.projectRoot), location: 'file' as const };
  }

  async reconcile(edit: ProjectEditRecord, allowRetry: boolean): Promise<DispatchResult | null> {
    const current = await this.current();
    const observation = { location: current.location, observedHash: current.hash, ...('documentVersion' in current ? { documentVersion: current.documentVersion } : {}) };
    const result = await this.core<ReconcileProjectEditResult>('reconcile-project-edit', { editId: edit.id, observation });
    if (!result.ok) return result;
    if (result.action === 'finalize' || result.action === 'complete') return this.core<DispatchResult>('finalize-project-edit', edit.id);
    if (result.action === 'retry' && allowRetry) return null;
    if (result.action === 'retry') {
      const aborted = await this.core<ProjectEditResult>('abort-project-edit', { editId: edit.id, observation });
      if (!aborted.ok) return aborted;
      return null;
    }
    throw new Error('A previous project change needs review. Eve preserved both versions and will not overwrite your work.');
  }

  async recover() {
    const edits = await this.core<ProjectEditRecord[]>('pending-project-edits');
    for (const edit of edits) {
      if (edit.projectPath !== this.projectRoot) continue;
      const result = await this.reconcile(edit, false);
      if (result && !result.ok) throw new Error(result.error.message);
    }
  }

  async dispatch(command: CoreCommandInput): Promise<DispatchResult> {
    const check = await this.core<PreflightResult>('preflight', command);
    if (!check.ok) return check;
    if (check.duplicate) return check.duplicate;
    if (!check.projectEdit) return this.core('dispatch', command);
    if (check.projectEdit.projectPath !== this.projectRoot) throw new Error('Open this project before changing its controls.');
    if (check.pendingEdit) { const resumed = await this.reconcile(check.pendingEdit, true); if (resumed) return resumed; }
    const before = await this.current();
    const next = { ...before.config, ...check.projectEdit.after };
    const afterText = serializeOrbitConfig(next);
    const prepared = await this.core<PrepareProjectEditResult>('prepare-project-edit', { command, preparation: { relativePath: 'eve.project.json', beforeHash: before.hash, afterHash: contentHash(afterText), beforeText: before.text, afterText, location: before.location, ...('documentVersion' in before ? { documentVersion: before.documentVersion } : {}) } });
    if (!prepared.ok) return prepared;
    if (prepared.duplicate) return prepared.duplicate;
    const edit = prepared.edit!;
    if (prepared.resumed) { const resumed = await this.reconcile(edit, true); if (resumed) return resumed; }
    try {
      await this.assertRootIdentity?.();
      const receipt = await commitOrbitConfig({ projectRoot: this.projectRoot, expectedHash: edit.beforeHash, next: parseOrbitConfig(edit.afterText), operationId: edit.id, editor: this.editor() ?? undefined, editorFreeLease: this.editorFree() });
      const recorded = await this.core<ProjectEditResult>('record-project-receipt', { editId: edit.id, receipt });
      if (!recorded.ok) return recorded;
      return await this.core<DispatchResult>('finalize-project-edit', edit.id);
    } catch (error) {
      // A lost response can follow a successful buffer write. Inspect, do not blindly retry.
      try { const result = await this.reconcile(edit, false); if (result) return result; } catch { /* The durable journal retains the unresolved conflict. */ }
      throw error;
    }
  }
}
