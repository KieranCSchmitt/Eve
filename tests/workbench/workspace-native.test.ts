import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { CoreStore } from '@eve/core';
import { ALL_CAPABILITIES, type WorkspaceEditDispatch, type WorkspaceEditReceipt } from '@eve/contracts';
import { startWorkbench, type WorkbenchService } from '../../apps/desktop/host/workbench';
import { captureWorkspace, planWorkspaceEdit, type WorkspaceOwner } from '../../apps/desktop/host/workspace-plan';
import { WorkspaceEdits, type WorkspaceEditReview } from '../../apps/desktop/host/workspace-edits';
import type { DocumentState } from '../../extensions/eve-workbench/src/protocol';

const enabled = process.env.EVE_RUN_WORKBENCH_NATIVE === '1';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const auth = { actorId: 'desktop', origin: 'trusted-ui' as const, capabilities: [...ALL_CAPABILITIES] };
const must = <T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> => {
  expect(value.ok, JSON.stringify(value)).toBe(true); return value as Extract<T, { ok: true }>;
};

it.skipIf(!enabled).each(['two existing files', 'CRLF multiline replacement'] as const)('qualifies real workspace coordinator, durable receipt and native Undo: %s', async scenario => {
  const temporary = await realpath(await mkdtemp('/tmp/eve-workspace-native-'));
  const project = path.join(temporary, 'project'), profile = path.join(temporary, 'editor');
  await mkdir(project, { mode: 0o700 });
  const originals = scenario === 'two existing files'
    ? [{ relativePath: 'app.ts', text: 'const speed = 1;\n' }, { relativePath: 'style.css', text: '.card { opacity: 0.5; }\n' }]
    : [{ relativePath: 'app.ts', text: 'const speed = 1;\r\nconst label = "before";\r\n' }];
  await Promise.all(originals.map(file => writeFile(path.join(project, file.relativePath), file.text, { mode: 0o600 })));
  let service: WorkbenchService | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let core: CoreStore | undefined;
  try {
    core = new CoreStore({ dbPath: path.join(temporary, 'core/eve.db'), seed: false });
    const created = must(core.dispatch({ type: 'CreateTask', requestId: 'create-task', title: 'Native workspace qualification', kind: 'project' }, auth));
    const task = created.snapshot.tasks.find(task => task.id === created.snapshot.activeTaskId)!;
    const root = await stat(project, { bigint: true });
    const identity = { device: String(root.dev), inode: String(root.ino) };
    const registered = must(core.registerProject({ requestId: 'register-project', taskId: task.id, expectedEpoch: task.epoch, expectedTaskRevision: task.revision,
      project: { id: 'native-project', canonicalRoot: project, rootIdentity: identity, kind: 'external', adapter: 'generic', preview: { kind: 'none' } } }, auth));
    const currentTask = registered.snapshot.tasks.find(task => task.id === created.snapshot.activeTaskId)!;
    service = await startWorkbench({
      codeServerExecutable: process.env.EVE_CODE_SERVER ?? path.resolve(`.runtime/code-server/code-server-4.138.0-${process.platform === 'darwin' ? 'macos' : 'linux'}-arm64/bin/code-server`),
      extensionDirectory: path.resolve('extensions/eve-workbench'), profileDirectory: profile, projectRoot: project, trustedProject: true,
    });
    const processOwner = JSON.parse(await readFile(path.join(profile, 'workbench-owner.json'), 'utf8')) as { instance: string };
    const owner: WorkspaceOwner = { taskId: currentTask.id, taskEpoch: currentTask.epoch, taskRevision: currentTask.revision, policyRevision: currentTask.policy.revision,
      processing: currentTask.policy.processing, project: registered.project, serviceInstanceId: processOwner.instance, serviceGeneration: 1 };
    browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    await service.authenticate({ cookies: { set: async cookie => context.addCookies([{ name: cookie.name, value: cookie.value, url: cookie.url, httpOnly: true, sameSite: 'Lax' }]) } });
    const page = await context.newPage(); await page.goto(service.url); await service.waitUntilConnected();
    const inputs = [];
    for (const file of originals) {
      const filePath = path.join(project, file.relativePath), uri = pathToFileURL(filePath).href;
      const selectedText = file.text.split(/\r?\n/)[0]!;
      const selection = { anchor: { line: 0, character: 0 }, active: { line: 0, character: selectedText.length } };
      await service.restoreCheckpoint({ uri, selections: [selection], visibleRanges: [], viewColumn: 1, version: 0 });
      const document = await service.call<DocumentState>('document.inspect', { uri });
      expect(document.text).toBe(file.text);
      expect(document.eol).toBe(scenario === 'CRLF multiline replacement' ? 'crlf' : 'lf');
      await expect(service.call('document.inspect', { uri, maxBytes: document.bytes - 1 })).rejects.toThrow('capture limit');
      expect(await service.call('document.inspect', { uri, maxBytes: document.bytes })).toEqual(document);
      const fileStat = await stat(filePath, { bigint: true });
      inputs.push({ relativePath: file.relativePath, document: { ...document, text: document.text! }, selection, selectedText,
        fileIdentity: { device: String(fileStat.dev), inode: String(fileStat.ino), ancestors: [{ relativePath: '', ...identity }] } });
    }
    const capture = captureWorkspace({ owner, documents: inputs });
    const planned = planWorkspaceEdit(capture, { type: 'ProposeWorkspaceEdit', targetId: capture.target.id, expectedRevision: capture.target.revision,
      edits: scenario === 'two existing files'
        ? [{ path: 'app.ts', before: 'speed = 1', after: 'speed = 2' }, { path: 'style.css', before: 'opacity: 0.5', after: 'opacity: 0.8' }]
        : [{ path: 'app.ts', before: 'const speed = 1;', after: 'const speed = 2;\nconst doubled = speed * 2;' }],
    });
    if (scenario === 'CRLF multiline replacement') expect(planned.documents[0]!.afterText).toBe('const speed = 2;\r\nconst doubled = speed * 2;\r\nconst label = "before";\r\n');
    const review: WorkspaceEditReview = { requestId: 'native-reviewed-edit', intentRequestId: 'native-intent', proposalId: 'native-proposal', contextSnapshotId: 'native-context',
      contextHash: hash(JSON.stringify([capture.target, owner])), label: 'Apply explicitly reviewed native fixture' };
    let nativeCalls = 0;
    const coordinator = new WorkspaceEdits({
      // This fixture explicitly grants the literal reviewed plan. No provider or fake native reply participates.
      assertReview: async (candidate, reviewed) => { expect(candidate).toEqual(planned); expect(reviewed).toEqual(review); },
      editor: async () => ({ owner,
        inspect: uri => service!.call<DocumentState | null>('document.inspect', { uri }),
        assertCurrent: async () => {
          expect(service!.connected).toBe(true);
          const liveRoot = await stat(project, { bigint: true }); expect({ device: String(liveRoot.dev), inode: String(liveRoot.ino) }).toEqual(identity);
          for (const document of planned.documents) {
            expect(await realpath(fileURLToPath(document.uri))).toBe(fileURLToPath(document.uri));
            const live = await stat(fileURLToPath(document.uri), { bigint: true });
            expect({ device: String(live.dev), inode: String(live.ino) }).toEqual({ device: document.fileIdentity!.device, inode: document.fileIdentity!.inode });
          }
        },
        apply: async request => { nativeCalls++; return service!.call('edit.apply', request); },
      }),
      core: async <T>(method: string, payload?: unknown): Promise<T> => {
        let value: unknown;
        if (method === 'lookup-workspace-edit') value = core!.lookupWorkspaceEdit(payload, auth);
        else if (method === 'prepare-workspace-edit') value = core!.prepareWorkspaceEdit(payload, auth);
        else if (method === 'read-workspace-edit') value = core!.readWorkspaceEdit(String(payload), auth);
        else if (method === 'read-workspace-edit-request') value = core!.readWorkspaceEditRequest(String(payload), auth);
        else if (method === 'dispatch-workspace-edit' || method === 'cancel-prepared-workspace-edit') {
          const input = payload as { editId: string; dispatch: WorkspaceEditDispatch };
          value = method === 'dispatch-workspace-edit' ? core!.markWorkspaceEditDispatched(input.editId, input.dispatch, auth) : core!.cancelPreparedWorkspaceEdit(input.editId, input.dispatch, auth);
        } else if (method === 'record-workspace-receipt') {
          const input = payload as { editId: string; receipt: WorkspaceEditReceipt }; value = core!.recordWorkspaceEditReceipt(input.editId, input.receipt, auth);
        } else if (method === 'finalize-workspace-edit') value = core!.finalizeWorkspaceEdit(String(payload), auth);
        else throw new Error(`Unexpected core method: ${method}`);
        return value as T;
      },
    });
    const result = await coordinator.apply(planned, review);
    const actual = await Promise.all(planned.documents.map(document => service!.call<DocumentState>('document.inspect', { uri: document.uri })));
    expect(result.status, JSON.stringify({ planned: planned.documents.map(document => document.afterText), actual: actual.map(document => document.text), journal: result.edit.status })).toBe('applied');
    expect(nativeCalls).toBe(1);
    expect(actual.map(document => document.text)).toEqual(planned.documents.map(document => document.afterText));
    expect(result.edit.receipt?.documents.map(document => document.afterHash)).toEqual(actual.map(document => document.hash));
    // The real orphan is already durable at acknowledgement, with no poll/capture to mask a delayed write.
    const orphan = JSON.parse(await readFile(path.join(profile, 'recovery', `orphan-${processOwner.instance}.json`), 'utf8'));
    for (const document of actual) expect(orphan.documents).toContainEqual(expect.objectContaining({ uri: document.uri, version: document.version, text: document.text, hash: document.hash }));
    expect(orphan.documents.every((document: object) => !Object.hasOwn(document, 'eol'))).toBe(true);
    for (const file of originals) expect(await readFile(path.join(project, file.relativePath), 'utf8')).toBe(file.text);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    // Some VS Code versions confirm a multi-file undo; accepting it is the user's native Undo action.
    const undoAll = page.getByRole('button', { name: /Undo in (?:All|\d+) Files/i });
    if (await undoAll.isVisible().catch(() => false)) await undoAll.click();
    await expect.poll(async () => Promise.all(originals.map(file => service!.inspect(path.join(project, file.relativePath)).then(document => document?.text))), { timeout: 10_000 }).toEqual(originals.map(file => file.text));
    expect(must(core.listPendingWorkspaceEdits(auth)).value).toEqual([]);
    expect((await coordinator.apply(planned, review)).status).toBe('applied'); expect(nativeCalls).toBe(1);
    expect((await service.inspect(path.join(project, originals[0]!.relativePath)))?.text).toBe(originals[0]!.text);
  } finally {
    await browser?.close(); await service?.close(); core?.close(); await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);
