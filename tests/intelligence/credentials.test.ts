import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialVault, configureProviderSchema, type SafeStorageBackend, type ConfigureProviderInput } from '../../apps/desktop/host/credentials';

export function testBackend(selected = 'gnome_libsecret', available = true): SafeStorageBackend {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available, getSelectedStorageBackend: () => selected,
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const content = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), content]); },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0,12)); decipher.setAuthTag(value.subarray(12,28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(); },
  };
}
export const cloudSetup: ConfigureProviderInput = { provider: { id: 'cloud', kind: 'openai', model: 'explicit-test-model', protocol: 'openai-responses', enabled: true, roles: ['explain'] }, storage: 'secure' };
let profile: string;
beforeEach(async () => { profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eve-credentials-'))); });
afterEach(async () => { await rm(profile, { recursive: true, force: true }); });

describe('host credential vault', () => {
  it('round-trips optional qualified local effort without enabling it or inventing authentication, and can restore the runtime default', async () => {
    const backend = testBackend();
    const configuration: ConfigureProviderInput = { storage: 'secure', provider: { id: 'local', kind: 'nemotron', model: 'qualified-checkpoint', endpoint: 'http://127.0.0.1:8112/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', roles: ['explain'], authentication: 'none', reasoningEffort: 'none' } };
    const vault = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await vault.initialize();
    await vault.configure(configuration);
    const reopened = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await reopened.initialize();
    expect(reopened.workerProviders()[0]).toMatchObject({ config: { reasoningEffort: 'none', enabled: false, authentication: { type: 'none' } } });
    expect(reopened.workerProviders()[0]).not.toHaveProperty('credential');
    expect(reopened.publicSettings()[0]).toMatchObject({ enabled: false, authentication: 'none', credentialPresent: false });
    const { reasoningEffort: _effort, ...runtimeDefault } = configuration.provider;
    await reopened.configure({ ...configuration, provider: runtimeDefault });
    const defaultReopened = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await defaultReopened.initialize();
    expect(defaultReopened.workerProviders()[0].config).not.toHaveProperty('reasoningEffort');
  });
  it('rejects cross-protocol or unknown effort before replacing stored configuration', async () => {
    const backend = testBackend(); const vault = new CredentialVault({ profilePath: profile, backend }); await vault.initialize();
    const valid: ConfigureProviderInput = { storage: 'secure', provider: { id: 'local', kind: 'nemotron', model: 'qualified-checkpoint', endpoint: 'http://127.0.0.1:8112/v1/chat/completions', protocol: 'openai-chat-completions', outputMode: 'json-schema', roles: ['explain'], authentication: 'none', reasoningEffort: 'none' } };
    await vault.configure(valid);
    const before = await readFile(path.join(profile, 'intelligence/providers.enc'));
    for (const replacement of [{ protocol: 'openai-responses' }, { reasoningEffort: 'xhigh' }]) {
      const invalid = { ...valid, provider: { ...valid.provider, ...replacement } };
      expect(configureProviderSchema.safeParse(invalid).success).toBe(false);
      await expect(vault.configure(invalid as ConfigureProviderInput)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
      expect(await readFile(path.join(profile, 'intelligence/providers.enc'))).toEqual(before);
    }
    expect(vault.workerProviders()[0].config).toMatchObject({ reasoningEffort: 'none', protocol: 'openai-chat-completions' });
  });
  it('encrypts configuration and credential together, reopens it, and exposes no secret/ref in settings', async () => {
    const backend = testBackend(); const vault = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await vault.initialize();
    await vault.configure({ ...cloudSetup, credential: 'private-test-key' });
    const bytes = await readFile(path.join(profile, 'intelligence/providers.enc'));
    expect(bytes.includes(Buffer.from('private-test-key'))).toBe(false); expect(bytes.includes(Buffer.from('explicit-test-model'))).toBe(false);
    expect(JSON.stringify(vault.publicSettings())).not.toMatch(/private-test-key|credentialRef|eve-provider/);
    const reopened = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await reopened.initialize();
    expect(reopened.workerProviders()[0].credential).toBe('private-test-key');
    expect(reopened.publicSettings()[0]).toMatchObject({ model: 'explicit-test-model', credentialPresent: true, storage: 'secure' });
  });
  it('rejects Linux basic_text even if Electron says encryption is available, with explicit memory-only fallback', async () => {
    const backend = testBackend('basic_text'); const vault = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await vault.initialize();
    expect(vault.storageStatus().available).toBe(false);
    await expect(vault.configure({ ...cloudSetup, credential: 'private-test-key' })).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
    await vault.configure({ ...cloudSetup, storage: 'runtime-only', credential: 'memory-test-key' });
    expect(vault.workerProviders()[0].credential).toBe('memory-test-key');
    await expect(readFile(path.join(profile, 'intelligence/providers.enc'))).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await reopened.initialize(); expect(reopened.publicSettings()).toEqual([]);
  });
  it('preserves locked/corrupt settings instead of overwriting them or silently resetting', async () => {
    const backend = testBackend(); const vault = new CredentialVault({ profilePath: profile, backend, platform: 'linux' }); await vault.initialize();
    await vault.configure({ ...cloudSetup, credential: 'old-private-key' });
    const file = path.join(profile, 'intelligence/providers.enc'); const original = await readFile(file);
    const locked = new CredentialVault({ profilePath: profile, backend: testBackend('basic_text'), platform: 'linux' }); await locked.initialize();
    expect(locked.storageStatus().state).toBe('locked');
    await expect(locked.configure({ ...cloudSetup, storage: 'runtime-only', credential: 'replacement' })).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
    expect(await readFile(file)).toEqual(original);
    await writeFile(file, 'corrupt'); const corrupt = new CredentialVault({ profilePath: profile, backend }); await corrupt.initialize();
    expect(corrupt.storageStatus().state).toBe('locked'); expect(await readFile(file, 'utf8')).toBe('corrupt');
  });
  it('removes the stored secret when switching explicitly to runtime-only, without restoring it on restart', async () => {
    const backend = testBackend(); const vault = new CredentialVault({ profilePath: profile, backend }); await vault.initialize();
    await vault.configure({ ...cloudSetup, credential: 'persisted-secret' });
    await vault.configure({ ...cloudSetup, storage: 'runtime-only', credential: 'session-secret' });
    expect(vault.workerProviders()[0].credential).toBe('session-secret');
    const reopened = new CredentialVault({ profilePath: profile, backend }); await reopened.initialize(); expect(reopened.publicSettings()).toEqual([]);
  });
  it('validates explicit model/protocol and rejects remote or credential-bearing local endpoints', async () => {
    const vault = new CredentialVault({ profilePath: profile, backend: testBackend() }); await vault.initialize();
    await expect(vault.configure({ ...cloudSetup, provider: { ...cloudSetup.provider, model: '' } })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    for (const endpoint of ['https://remote.example/v1/chat/completions', 'http://secret@127.0.0.1:123/v1', 'http://127.0.0.1:123/v1?key=x']) {
      await expect(vault.configure({ storage: 'runtime-only', provider: { id: 'local', kind: 'nemotron', model: 'observed-model', roles: ['explain'], enabled: true, endpoint, protocol: 'openai-chat-completions', outputMode: 'json-object', authentication: 'none' } })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    }
    expect(vault.publicSettings()).toEqual([]);
  });
  it('does not replace existing settings when encryption fails', async () => {
    const backend = testBackend(); const vault = new CredentialVault({ profilePath: profile, backend }); await vault.initialize(); await vault.configure(cloudSetup);
    const before = await readFile(path.join(profile, 'intelligence/providers.enc')); backend.encryptString = () => { throw new Error('not public'); };
    await expect(vault.configure({ ...cloudSetup, credential: 'new-key' })).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' });
    expect(await readFile(path.join(profile, 'intelligence/providers.enc'))).toEqual(before); expect(vault.publicSettings()[0].credentialPresent).toBe(false);
  });
  it('rejects a symlinked secret file and persists non-secret local recovery markers independently', async () => {
    const vault = new CredentialVault({ profilePath: profile, backend: testBackend('basic_text'), platform: 'linux' }); await vault.initialize();
    await vault.markLocalUncertain(['local']); const file = path.join(profile, 'outside'); await writeFile(file, 'not a vault'); await symlink(file, path.join(profile, 'intelligence/providers.enc'));
    const reopened = new CredentialVault({ profilePath: profile, backend: testBackend() }); await reopened.initialize();
    expect(reopened.uncertainLocalProviders()).toEqual(['local']); expect(reopened.storageStatus().state).toBe('locked'); expect(await readFile(file, 'utf8')).toBe('not a vault');
  });
});
