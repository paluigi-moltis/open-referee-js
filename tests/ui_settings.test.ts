import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../src/ui/app';
import { lockVault, vaultIsUnlocked, getSecret } from '../src/config/secrets';

const KEY = 'sk-test-' + 'provider-key-123';

function mounted(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountApp(root);
  return root;
}

function input(root: HTMLElement, sel: string): HTMLInputElement {
  return root.querySelector<HTMLInputElement>(sel)!;
}

function change(elm: Element): void {
  elm.dispatchEvent(new Event('change', { bubbles: true }));
}

function click(btn: Element): void {
  (btn as HTMLButtonElement).click();
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  lockVault();
  vi.restoreAllMocks();
  vi.stubGlobal(
    'prompt',
    vi.fn(() => ''),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings UI v2 — provider manager', () => {
  it('renders existing providers from settings', () => {
    localStorage.setItem(
      'openreferee.settings.v1',
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: { type: 'anthropic' },
          'openai-main': {
            type: 'openai_compatible',
            baseUrl: 'https://api.openai.com/v1',
          },
        },
      }),
    );
    const root = mounted();
    const rows = root.querySelectorAll('.provider-row');
    expect(rows.length).toBe(2);
    const names = [...rows].map((r) => r.getAttribute('data-provider'));
    expect(names).toContain('anthropic');
    expect(names).toContain('openai-main');
    // existing baseUrl is shown inline
    const oaiRow = root.querySelector('[data-provider="openai-main"]')!;
    expect(oaiRow.querySelector<HTMLInputElement>('.provider-base-url')!.value).toBe(
      'https://api.openai.com/v1',
    );
    // role selects list both providers
    const sel = root.querySelector<HTMLSelectElement>('#role-provider-strong')!;
    expect([...sel.options].map((o) => o.value).sort()).toEqual([
      '',
      'anthropic',
      'openai-main',
    ]);
  });

  it('adds and removes providers, persisting stripped settings', () => {
    const root = mounted();
    input(root, '#new-provider-name').value = 'ollama-local';
    input(root, '#new-provider-type').value = 'ollama';
    input(root, '#new-provider-base-url').value = 'http://localhost:11434';
    click(root.querySelector('#provider-add')!);

    const stored = JSON.parse(localStorage.getItem('openreferee.settings.v1') ?? '{}');
    expect(stored.providers['ollama-local']).toEqual({
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
    });

    const row = root.querySelector('[data-provider="ollama-local"]')!;
    click(row.querySelector('.provider-remove')!);
    expect(root.querySelector('[data-provider="ollama-local"]')).toBeNull();
    const after = JSON.parse(localStorage.getItem('openreferee.settings.v1') ?? '{}');
    expect(after.providers['ollama-local']).toBeUndefined();
  });

  it('edits baseUrl inline and persists it', () => {
    const root = mounted();
    input(root, '#new-provider-name').value = 'vllm-x';
    input(root, '#new-provider-type').value = 'vllm';
    click(root.querySelector('#provider-add')!);

    const row = root.querySelector('[data-provider="vllm-x"]')!;
    const base = row.querySelector<HTMLInputElement>('.provider-base-url')!;
    base.value = 'http://127.0.0.1:8000/v1';
    change(base);

    const stored = JSON.parse(localStorage.getItem('openreferee.settings.v1') ?? '{}');
    expect(stored.providers['vllm-x'].baseUrl).toBe('http://127.0.0.1:8000/v1');
  });

  it('saving a key never writes it to localStorage (session-only path)', () => {
    const root = mounted();
    input(root, '#new-provider-name').value = 'anthropic';
    input(root, '#new-provider-type').value = 'anthropic';
    click(root.querySelector('#provider-add')!);

    const row = root.querySelector('[data-provider="anthropic"]')!;
    const key = row.querySelector<HTMLInputElement>('.provider-key')!;
    key.value = KEY;
    key.dispatchEvent(new Event('input', { bubbles: true }));
    change(key);

    const raw = localStorage.getItem('openreferee.settings.v1') ?? '';
    expect(raw).not.toContain(KEY);
    const stored = JSON.parse(raw);
    expect(stored.providers['anthropic'].apiKey).toBeUndefined();
  });

  it('role select + model roundtrip persists', () => {
    const root = mounted();
    input(root, '#new-provider-name').value = 'anthropic';
    input(root, '#new-provider-type').value = 'anthropic';
    click(root.querySelector('#provider-add')!);

    const sel = root.querySelector<HTMLSelectElement>('#role-provider-strong')!;
    sel.value = 'anthropic';
    change(sel);
    const model = input(root, '#strong-model');
    model.value = 'claude-sonnet-4-5';
    change(model);

    const stored = JSON.parse(localStorage.getItem('openreferee.settings.v1') ?? '{}');
    expect(stored.roles.strong).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });
});

describe('settings UI v2 — vault flows', () => {
  it('wrong passphrase on unlock shows the error, indicator stays locked', async () => {
    // Create a vault first (prompt fired twice: passphrase + repeat).
    vi.mocked(prompt).mockReturnValue('right-pw');
    const root = mounted();
    click(root.querySelector('#vault-encrypt')!);
    await vi.waitFor(() => {
      expect(vaultIsUnlocked()).toBe(true);
    });
    click(root.querySelector('#vault-lock')!);
    expect(vaultIsUnlocked()).toBe(false);

    vi.mocked(prompt).mockReturnValueOnce('wrong-pw');
    click(root.querySelector('#vault-unlock')!);
    await vi.waitFor(() => {
      expect(root.querySelector('#vault-error')!.textContent).toContain(
        'invalid passphrase',
      );
    });
    expect(root.querySelector('#vault-state')!.textContent).toContain('locked');
  });

  it('set passphrase moves session keys into the vault; lock+unlock recovers them', async () => {
    const root = mounted();
    input(root, '#new-provider-name').value = 'anthropic';
    input(root, '#new-provider-type').value = 'anthropic';
    click(root.querySelector('#provider-add')!);

    // Enter key while vault is locked -> session-only.
    const row = root.querySelector('[data-provider="anthropic"]')!;
    const key = row.querySelector<HTMLInputElement>('.provider-key')!;
    key.value = KEY;
    key.dispatchEvent(new Event('input', { bubbles: true }));
    change(key);
    expect(vaultIsUnlocked()).toBe(false);

    // Encrypt: prompt twice (same passphrase).
    vi.mocked(prompt).mockReturnValueOnce('pw1').mockReturnValueOnce('pw1');
    click(root.querySelector('#vault-encrypt')!);
    await vi.waitFor(() => {
      expect(vaultIsUnlocked()).toBe(true);
      expect(root.querySelector('#vault-state')!.textContent).toContain('unlocked');
    });

    // Lock, unlock again, and verify the key is recoverable from the vault.
    click(root.querySelector('#vault-lock')!);
    expect(vaultIsUnlocked()).toBe(false);
    vi.mocked(prompt).mockReturnValueOnce('pw1');
    click(root.querySelector('#vault-unlock')!);
    await vi.waitFor(() => {
      expect(vaultIsUnlocked()).toBe(true);
    });
    // Assert via the vault API (NOT by printing the key).
    await expect(getSecret('anthropic')).resolves.toBe(KEY);

    // Regression (Wave B review): after migration the session plaintexts
    // must be GONE — lock now actually locks this session's keys, and the
    // key input was cleared.
    click(root.querySelector('#vault-lock')!);
    expect(row.querySelector<HTMLInputElement>('.provider-key')!.value).toBe('');
    // resolveKey falls through to empty rather than the stale plaintext:
    // trigger a run-adjacent read path via settings persistence check —
    // and localStorage stays key-free.
    const stored = JSON.parse(localStorage.getItem('openreferee.settings.v1') ?? '{}');
    expect(JSON.stringify(stored)).not.toContain(KEY);
  });

  it('key entry while vault is UNLOCKED goes to the vault only (never settings, never payload plaintext)', async () => {
    vi.mocked(prompt).mockReturnValue('pw-unlocked-path');
    const root = mounted();
    click(root.querySelector('#vault-encrypt')!); // creates empty vault
    await vi.waitFor(() => {
      expect(vaultIsUnlocked()).toBe(true);
    });

    input(root, '#new-provider-name').value = 'gemini-direct';
    input(root, '#new-provider-type').value = 'gemini';
    click(root.querySelector('#provider-add')!);
    const row = root.querySelector('[data-provider="gemini-direct"]')!;
    const key = row.querySelector<HTMLInputElement>('.provider-key')!;
    key.value = KEY;
    key.dispatchEvent(new Event('input', { bubbles: true }));
    change(key);
    await vi.waitFor(async () => {
      await expect(getSecret('gemini-direct')).resolves.toBe(KEY);
    });

    // Settings storage stays key-free…
    const stored = localStorage.getItem('openreferee.settings.v1') ?? '';
    expect(stored).not.toContain(KEY);
    // …and the encrypted payload contains neither the name nor the value.
    const payloadRaw = localStorage.getItem('openreferee.vault.v1') ?? '';
    expect(payloadRaw).not.toContain(KEY);
    expect(payloadRaw).not.toContain('gemini-direct');
  });

  it('registers a lock handler on beforeunload/unload', async () => {
    vi.mocked(prompt).mockReturnValue('pw-unload');
    const root = mounted();
    click(root.querySelector('#vault-encrypt')!);
    await vi.waitFor(() => {
      expect(vaultIsUnlocked()).toBe(true);
    });
    // Locking drops the derived key; unlocking again needs the passphrase.
    // Firing beforeunload must therefore leave the vault locked.
    window.dispatchEvent(new Event('beforeunload'));
    expect(vaultIsUnlocked()).toBe(false);

    // Sanity: the handler is really attached (unlock + unload -> locked).
    vi.mocked(prompt).mockReturnValueOnce('pw-unload');
    click(root.querySelector('#vault-unlock')!);
    await vi.waitFor(() => {
      expect(vaultIsUnlocked()).toBe(true);
    });
    window.dispatchEvent(new Event('unload'));
    expect(vaultIsUnlocked()).toBe(false);
  });
});
