import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VaultError,
  deleteSecret,
  destroyVault,
  getSecret,
  lockVault,
  setSecret,
  unlockVault,
  vaultIsUnlocked,
} from '../src/config/secrets';

const VAULT_KEY = 'openreferee.vault.v1';

beforeEach(() => {
  localStorage.clear();
  lockVault();
});

afterEach(() => {
  lockVault();
});

describe('secrets vault', () => {
  it('creates the vault on first unlock and roundtrips secrets', async () => {
    expect(vaultIsUnlocked()).toBe(false);
    await unlockVault('correct horse battery staple');
    expect(vaultIsUnlocked()).toBe(true);
    // Creation wrote an (empty) encrypted payload.
    expect(localStorage.getItem(VAULT_KEY)).not.toBeNull();

    await setSecret('anthropic', 'sk-ant-test-123');
    await setSecret('openai-main', 'sk-oai-456');
    await expect(getSecret('anthropic')).resolves.toBe('sk-ant-test-123');
    await expect(getSecret('openai-main')).resolves.toBe('sk-oai-456');
  });

  it('rejects a wrong passphrase on an existing vault with VaultError', async () => {
    await unlockVault('right-passphrase');
    await setSecret('anthropic', 'sk-ant-test-123');
    lockVault();

    await expect(unlockVault('wrong-passphrase')).rejects.toThrow(VaultError);
    await expect(unlockVault('wrong-passphrase')).rejects.toThrow('invalid passphrase');
    expect(vaultIsUnlocked()).toBe(false);
    // Correct passphrase still opens it.
    await expect(unlockVault('right-passphrase')).resolves.toBeUndefined();
    await expect(getSecret('anthropic')).resolves.toBe('sk-ant-test-123');
  });

  it('lock clears state; re-unlock serves secrets again', async () => {
    await unlockVault('pw');
    await setSecret('k', 'v1');
    lockVault();
    expect(vaultIsUnlocked()).toBe(false);
    await expect(getSecret('k')).rejects.toThrow(VaultError);

    await unlockVault('pw');
    await expect(getSecret('k')).resolves.toBe('v1');
  });

  it('set requires unlocked, delete removes, unknown name is undefined', async () => {
    await expect(setSecret('x', 'y')).rejects.toThrow(VaultError);
    await expect(getSecret('x')).rejects.toThrow(VaultError);
    await expect(deleteSecret('x')).rejects.toThrow(VaultError);

    await unlockVault('pw');
    await expect(getSecret('nope')).resolves.toBeUndefined();
    await setSecret('a', '1');
    await setSecret('b', '2');
    await deleteSecret('a');
    await expect(getSecret('a')).resolves.toBeUndefined();
    await expect(getSecret('b')).resolves.toBe('2');
  });

  it('destroyVault removes the payload and locks', async () => {
    await unlockVault('pw');
    await setSecret('anthropic', 'sk-ant-test-123');
    expect(localStorage.getItem(VAULT_KEY)).not.toBeNull();
    destroyVault();
    expect(localStorage.getItem(VAULT_KEY)).toBeNull();
    expect(vaultIsUnlocked()).toBe(false);
  });

  it('payload in localStorage is encrypted — no plaintext leaks', async () => {
    await unlockVault('pw');
    await setSecret('anthropic', 'sk-ant-super-secret-value');
    const raw = localStorage.getItem(VAULT_KEY) ?? '';
    expect(raw).not.toContain('sk-ant-super-secret-value');
    expect(raw).not.toContain('anthropic');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toMatchObject({ v: 1 });
    expect(typeof parsed['salt']).toBe('string');
    expect(typeof parsed['iv']).toBe('string');
    expect(typeof parsed['ct']).toBe('string');
    // base64 ciphertext is not the plaintext either
    expect(atob(parsed['ct'] as string)).not.toContain('sk-ant-super-secret-value');
  });
});
