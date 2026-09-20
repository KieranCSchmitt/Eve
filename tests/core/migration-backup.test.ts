import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreStore } from '../../packages/core/src/index';

const fault = vi.hoisted(() => ({ open: null as ((file: string) => void) | null }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, openSync: ((...args: Parameters<typeof actual.openSync>) => { fault.open?.(String(args[0])); return actual.openSync(...args); }) };
});
let directory: string, dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'eve-migration-fault-')); dbPath = path.join(directory, 'eve.db');
  const core = new CoreStore({ dbPath, orbitProjectPath: path.join(directory, 'orbit') }); core.close();
  const database = new Database(dbPath);
  database.exec('DROP TABLE canvases; DROP TABLE workspace_edits; UPDATE tasks SET project_path=(SELECT p.canonical_root FROM projects p JOIN task_projects b ON b.project_id=p.id WHERE b.task_id=tasks.id); DROP TABLE project_requests; DROP TABLE task_projects; DROP TABLE projects; PRAGMA user_version=3;');
  database.pragma('wal_checkpoint(TRUNCATE)'); database.pragma('journal_mode=DELETE'); database.close();
});
afterEach(() => { fault.open = null; rmSync(directory, { recursive: true, force: true }); });

it('preserves a replaced rollback directory when receipt publication fails', () => {
  const before = readFileSync(dbPath); let replacement: string | undefined;
  fault.open = file => {
    if (!file.endsWith('/receipt.json')) return;
    fault.open = null;
    const stage = path.dirname(file); renameSync(stage, stage + '-original'); mkdirSync(stage, { mode: 0o700 });
    replacement = path.join(stage, 'must-survive.txt'); writeFileSync(replacement, 'Unrelated replacement content');
    throw new Error('Injected receipt failure after directory replacement');
  };
  expect(() => new CoreStore({ dbPath })).toThrow(/migration was refused/i);
  expect(replacement).toBeDefined(); expect(readFileSync(replacement!, 'utf8')).toBe('Unrelated replacement content');
  expect(readFileSync(dbPath)).toEqual(before);
  const database = new Database(dbPath, { readonly: true }); expect(database.pragma('user_version', { simple: true })).toBe(3); database.close();
});

it('removes only its own incomplete snapshot and leaves the old DB unchanged after disk failure', () => {
  const before = readFileSync(dbPath);
  fault.open = file => { if (file.endsWith('/receipt.json')) throw Object.assign(new Error('Injected disk full'), { code: 'ENOSPC' }); };
  expect(() => new CoreStore({ dbPath })).toThrow(/migration was refused/i);
  expect(readdirSync(path.join(directory, 'migration-backups'))).toEqual([]);
  expect(readFileSync(dbPath)).toEqual(before);
});

it('refuses a snapshot whose bytes change after hashing and never writes the source migration', () => {
  const before = readFileSync(dbPath);
  fault.open = file => {
    if (!file.endsWith('/receipt.json')) return;
    fault.open = null;
    writeFileSync(path.join(path.dirname(file), 'eve.db'), 'Changed after verification');
  };
  expect(() => new CoreStore({ dbPath })).toThrow(/migration was refused/i);
  expect(readdirSync(path.join(directory, 'migration-backups'))).toEqual([]);
  expect(readFileSync(dbPath)).toEqual(before);
});
