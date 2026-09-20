import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createProvider, nemotronProviderConfigSchema, openAIProviderConfigSchema, validateNemotronReasoningProtocol, type ProviderConfig, type PublicProviderSettings } from '../../../packages/agent/src/index';
import { inspectPath, readChecked, syncDirectory } from '../../../packages/imports/src/filesystem';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const providerSettingsInputSchema = z.union([
  openAIProviderConfigSchema.omit({ credentialRef: true }).extend({ id: identifier, protocol: z.literal('openai-responses') }).strict(),
  z.object({ ...nemotronProviderConfigSchema.shape, id: identifier, authentication: z.enum(['none', 'bearer']) }).strict().superRefine(validateNemotronReasoningProtocol),
]);
export type ProviderSettingsInput = z.input<typeof providerSettingsInputSchema>;
export const configureProviderSchema = z.object({
  provider: providerSettingsInputSchema, storage: z.enum(['secure', 'runtime-only']),
  credential: z.string().min(1).max(4096).refine(value => !/\s/.test(value), 'A bearer credential cannot contain whitespace').nullable().optional(),
  confirmedLocalIdle: z.boolean().optional(),
}).strict();
export type ConfigureProviderInput = z.input<typeof configureProviderSchema>;
export interface SafeStorageBackend {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
// Electron documents basic_text as an unprotected Linux fallback; it must never count as secure storage.
// https://www.electronjs.org/docs/latest/api/safe-storage
export type CredentialStatus = { available: boolean; backend: string; state: 'ready' | 'unavailable' | 'locked'; message?: string };
export class CredentialError extends Error {
  constructor(readonly code: 'INVALID_CONFIGURATION' | 'SECURE_STORAGE_UNAVAILABLE' | 'STORAGE_ERROR', message: string) { super(message); this.name = 'CredentialError'; }
}
export interface PrivateProvider { config: ProviderConfig; credential?: string; storage: 'secure' | 'runtime-only' }
export type PublicConfiguredProvider = PublicProviderSettings & { storage: 'secure' | 'runtime-only'; credentialPresent: boolean };
const storedEntrySchema = z.object({ provider: providerSettingsInputSchema, credential: configureProviderSchema.shape.credential.unwrap().unwrap().optional() }).strict();
const vaultSchema = z.object({ version: z.literal(1), providers: z.array(storedEntrySchema).max(8) }).strict();
type StoredEntry = z.infer<typeof storedEntrySchema> & { storage: 'secure' | 'runtime-only' };

function providerConfig(provider: z.infer<typeof providerSettingsInputSchema>): ProviderConfig {
  const credentialRef = `eve-provider:${provider.id}`;
  if (provider.kind === 'openai') { const { protocol: _protocol, ...rest } = provider; return { ...rest, credentialRef }; }
  return { ...provider, authentication: provider.authentication === 'none' ? { type: 'none' } : { type: 'bearer', credentialRef } };
}

/** Main-process only. No secret getter is exposed through Electron IPC or public settings. */
export class CredentialVault {
  private entries = new Map<string, StoredEntry>();
  private backend?: SafeStorageBackend;
  private status: CredentialStatus = { available: false, backend: 'uninitialized', state: 'unavailable' };
  private initialized = false;
  private localUncertain = new Set<string>();
  private localOrigins = new Set<string>();
  readonly directory: string;
  constructor(private readonly options: { profilePath: string; backend?: SafeStorageBackend; platform?: NodeJS.Platform }) { this.directory = path.join(options.profilePath, 'intelligence'); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await inspectPath(path.dirname(this.directory));
      await mkdir(this.directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const state = await inspectPath(this.directory);
      if (!state.stat.isDirectory() || (state.stat.mode & 0o077) !== 0 || (process.getuid && state.stat.uid !== process.getuid())) throw new Error('Unsafe credential directory');
      this.backend = this.options.backend ?? (await import('electron')).safeStorage;
      const platform = this.options.platform ?? process.platform;
      const selected = platform === 'linux' ? this.backend.getSelectedStorageBackend?.() ?? 'unknown' : platform === 'darwin' ? 'keychain' : 'os-encryption';
      const available = this.backend.isEncryptionAvailable() && !(platform === 'linux' && ['basic_text', 'unknown'].includes(selected));
      this.status = { available, backend: selected, state: available ? 'ready' : 'unavailable', ...(!available ? { message: 'Secure credential storage is unavailable. Explicit runtime-only configuration remains available.' } : {}) };
      const safetyFile = path.join(this.directory, 'local-safety.json');
      try {
        const data = z.union([
          z.object({ version: z.literal(1), uncertain: z.array(identifier).max(8) }).strict(),
          z.object({ version: z.literal(2), uncertain: z.array(identifier).max(32), origins: z.array(z.string().min(1).max(4096)).max(32) }).strict(),
        ]).parse(JSON.parse((await readChecked(safetyFile, 131_072)).toString('utf8')));
        this.localUncertain = new Set(data.uncertain);
        this.localOrigins = new Set(data.version === 2 ? data.origins : data.uncertain.length ? ['unknown (older recovery marker)'] : []);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const file = path.join(this.directory, 'providers.enc');
      try {
        const ciphertext = await readChecked(file, 1_000_000);
        if (!available) this.status = { ...this.status, state: 'locked', message: 'Saved provider settings are locked because secure storage is unavailable. They have not been reset.' };
        else {
          const stored = vaultSchema.parse(JSON.parse(this.backend.decryptString(ciphertext)));
          for (const entry of stored.providers) {
            if (this.entries.has(entry.provider.id)) throw new Error('Duplicate provider identity');
            createProvider(providerConfig(entry.provider));
            this.entries.set(entry.provider.id, { ...entry, storage: 'secure' });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.entries.clear(); this.status = { ...this.status, state: 'locked', message: 'Saved provider settings could not be opened. They have not been replaced.' };
        }
      }
      await syncDirectory(this.directory); await syncDirectory(path.dirname(this.directory));
      this.initialized = true;
    } catch { throw new CredentialError('STORAGE_ERROR', 'Provider storage could not be initialized safely.'); }
  }

  storageStatus(): CredentialStatus { return { ...this.status }; }
  uncertainLocalProviders(): string[] { return [...this.localUncertain]; }
  uncertainLocalOrigins(): string[] { return [...this.localOrigins]; }
  publicSettings(): PublicConfiguredProvider[] {
    return [...this.entries.values()].map(entry => ({ ...createProvider(providerConfig(entry.provider)).publicSettings(), storage: entry.storage, credentialPresent: !!entry.credential }));
  }
  /** The controller passes this only over its private utility-process channel, never as child env. */
  workerProviders(): PrivateProvider[] {
    return [...this.entries.values()].map(entry => ({ config: providerConfig(entry.provider), ...(entry.credential ? { credential: entry.credential } : {}), storage: entry.storage }));
  }

  async configure(input: ConfigureProviderInput): Promise<void> {
    const parsed = configureProviderSchema.safeParse(input);
    if (!parsed.success) throw new CredentialError('INVALID_CONFIGURATION', 'The provider configuration is incomplete or invalid.');
    const value = parsed.data;
    try { createProvider(providerConfig(value.provider)); } catch { throw new CredentialError('INVALID_CONFIGURATION', 'The configured provider endpoint or protocol is invalid.'); }
    if (!this.initialized) throw new CredentialError('STORAGE_ERROR', 'Provider storage is not initialized.');
    if (this.status.state === 'locked') throw new CredentialError('SECURE_STORAGE_UNAVAILABLE', 'Saved settings are locked. Restore secure storage before replacing them.');
    if (value.storage === 'secure' && !this.status.available) throw new CredentialError('SECURE_STORAGE_UNAVAILABLE', 'Secure storage is unavailable; choose runtime-only explicitly to keep a credential in memory.');
    const previous = this.entries.get(value.provider.id);
    if (this.entries.size >= 8 && !previous) throw new CredentialError('INVALID_CONFIGURATION', 'At most eight providers may be configured.');
    const requiresCredential = value.provider.kind === 'openai' || value.provider.authentication === 'bearer';
    const credential = !requiresCredential || value.credential === null ? undefined : value.credential ?? (previous?.provider.kind === value.provider.kind ? previous.credential : undefined);
    const next = new Map(this.entries);
    next.set(value.provider.id, { provider: value.provider, storage: value.storage, ...(credential ? { credential } : {}) });
    if (value.storage === 'secure' || previous?.storage === 'secure') {
      if (!this.status.available) throw new CredentialError('SECURE_STORAGE_UNAVAILABLE', 'Secure storage must be available to replace a previously stored credential.');
      const providers = [...next.values()].filter(entry => entry.storage === 'secure').map(({ storage: _storage, ...entry }) => entry);
      let ciphertext: Buffer;
      try { ciphertext = this.backend!.encryptString(JSON.stringify({ version: 1, providers })); } catch { throw new CredentialError('SECURE_STORAGE_UNAVAILABLE', 'Secure storage could not encrypt these settings.'); }
      await this.atomicWrite('providers.enc', ciphertext);
    }
    this.entries = next;
  }

  /** Non-secret crash marker: set before enabling a local worker, clear only after confirmed drain. */
  async markLocalUncertain(ids: readonly string[], origins: readonly string[] = []): Promise<void> {
    const validated = z.array(identifier).max(32).parse([...new Set(ids)]);
    const validatedOrigins = z.array(z.string().min(1).max(4096)).max(32).parse([...new Set(origins)]);
    await this.atomicWrite('local-safety.json', Buffer.from(JSON.stringify({ version: 2, uncertain: validated, origins: validatedOrigins })));
    this.localUncertain = new Set(validated);
    this.localOrigins = new Set(validatedOrigins);
  }
  clearMemory(): void { this.entries.clear(); }

  private async atomicWrite(name: string, bytes: Buffer): Promise<void> {
    const temporary = path.join(this.directory, `.${name}-${randomUUID()}.tmp`);
    try {
      const state = await inspectPath(this.directory);
      if ((state.stat.mode & 0o077) !== 0 || (process.getuid && state.stat.uid !== process.getuid())) throw new Error('Unsafe storage');
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const destination = path.join(this.directory, name);
      try { if ((await lstat(destination)).isSymbolicLink()) throw new Error('Unsafe credential file'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temporary, destination); await syncDirectory(this.directory);
    } catch { throw new CredentialError('STORAGE_ERROR', 'Provider settings could not be saved durably.'); }
    finally { await unlink(temporary).catch(() => {}); }
  }
}
