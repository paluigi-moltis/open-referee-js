/**
 * Opt-in passphrase-encrypted secret storage (Stage 2).
 *
 * Owner decision: session-only in-memory keys are the DEFAULT; this vault is
 * a pure opt-in. WebCrypto: PBKDF2-SHA256 (310k iters, 16-byte random salt)
 * stretches the passphrase into an AES-GCM 256 key; the payload is stored in
 * localStorage under 'openreferee.vault.v1' as
 * `{v:1, salt: b64, iv: b64, ct: b64}`. Plaintext names/values NEVER touch
 * localStorage and NEVER appear in loadSettings/saveSettings output.
 */

const VAULT_KEY = 'openreferee.vault.v1';
const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

interface VaultPayload {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new VaultError('WebCrypto (crypto.subtle) is not available');
  }
  return s;
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(passphrase);
  const base = await subtle().importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function readPayload(): VaultPayload | null {
  const raw = localStorage.getItem(VAULT_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as VaultPayload).v === 1 &&
      typeof (parsed as VaultPayload).salt === 'string' &&
      typeof (parsed as VaultPayload).iv === 'string' &&
      typeof (parsed as VaultPayload).ct === 'string'
    ) {
      return parsed as VaultPayload;
    }
  } catch {
    /* fall through */
  }
  throw new VaultError('vault payload is corrupted');
}

function writePayload(
  secrets: Record<string, string>,
  key: CryptoKey,
  salt: Uint8Array,
): Promise<void> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  return subtle()
    .encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext)
    .then((ct) => {
      localStorage.setItem(
        VAULT_KEY,
        JSON.stringify({
          v: 1,
          salt: toB64(salt),
          iv: toB64(iv),
          ct: toB64(new Uint8Array(ct)),
        }),
      );
    });
}

// ------------------------------------------------------------- module state --

let vaultKey: CryptoKey | null = null;
/** Salt of the currently-open vault; reused for every re-encryption. */
let activeSalt: Uint8Array | null = null;
/** Plaintext cache; populated on first getSecret after unlock, dropped on lock. */
let cachedSecrets: Record<string, string> | null = null;

/**
 * Create-or-open the vault. First unlock with no stored payload CREATES it
 * (generates a salt, derives the key, stores an empty dict). Wrong passphrase
 * on an existing vault throws VaultError('invalid passphrase').
 */
export async function unlockVault(passphrase: string): Promise<void> {
  const payload = readPayload();
  if (payload === null) {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, salt);
    await writePayload({}, key, salt);
    vaultKey = key;
    activeSalt = salt;
    cachedSecrets = {};
    return;
  }
  const key = await deriveKey(passphrase, fromB64(payload.salt));
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromB64(payload.iv) as BufferSource },
      key,
      fromB64(payload.ct) as BufferSource,
    );
    cachedSecrets = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>;
    vaultKey = key;
    activeSalt = fromB64(payload.salt);
  } catch {
    throw new VaultError('invalid passphrase');
  }
}

export function lockVault(): void {
  vaultKey = null;
  activeSalt = null;
  cachedSecrets = null;
}

export function vaultIsUnlocked(): boolean {
  return vaultKey !== null;
}

/** Requires an unlocked vault; re-encrypts the whole dict with a fresh IV. */
export async function setSecret(name: string, value: string): Promise<void> {
  if (vaultKey === null) {
    throw new VaultError('vault is locked');
  }
  const next = { ...(cachedSecrets ?? {}), [name]: value };
  await writePayload(next, vaultKey, activeSalt as Uint8Array);
  cachedSecrets = next;
}

/** Decrypts once per unlock, then serves from the in-memory cache. */
export async function getSecret(name: string): Promise<string | undefined> {
  if (vaultKey === null) {
    throw new VaultError('vault is locked');
  }
  return cachedSecrets?.[name];
}

export async function deleteSecret(name: string): Promise<void> {
  if (vaultKey === null) {
    throw new VaultError('vault is locked');
  }
  if (cachedSecrets !== null && name in cachedSecrets) {
    const next = { ...cachedSecrets };
    delete next[name];
    await writePayload(next, vaultKey, activeSalt as Uint8Array);
    cachedSecrets = next;
  }
}

/** Removes the localStorage entry and locks (drops key + cached plaintexts). */
export function destroyVault(): void {
  localStorage.removeItem(VAULT_KEY);
  lockVault();
}
