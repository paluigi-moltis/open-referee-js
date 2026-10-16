# Stage 2 — Full providers + secrets vault + settings UI

Branch `stage/2-providers-secrets` off fork `main` (sits on top of the Stage-1
PR #2 branch content, which PR #2 merges into main).

## Scope (from the 8-stage plan)

1. **Provider factory** — `src/providers/factory.ts`: `createProvider(role,
   settings, {rateLimiter, sessionKeys})` mirroring Python `factory.py`:
   resolves role → provider config → adapter by `ProviderType`. Unknown role
   or missing key → `LLMError` with the Python wording.
2. **New adapters** (retry/backoff/timeout parity with the openai adapter,
   injected `fetchImpl`/`sleep` for tests):
   - `src/providers/anthropic.ts` — `POST api.anthropic.com/v1/messages`,
     headers `x-api-key` + `anthropic-version: 2023-06-01` +
     **`anthropic-dangerous-direct-browser-access: true`** (owner decision);
     system messages joined into top-level `system`; JSON mode via assistant
     prefill `{` (Anthropic has no JSON mode); usage from
     `input_tokens/output_tokens`; no images in Stage 2.
   - `src/providers/gemini.ts` — `v1beta/models/{model}:generateContent`,
     key in `x-goog-api-key` header (browser quirk note: keeps keys out of
     URLs); system → `systemInstruction`; assistant role → `'model'`;
     JSON mode via `generationConfig.responseMimeType`; usage from
     `usageMetadata.promptTokenCount/candidatesTokenCount`.
   - `src/providers/ollama.ts` — native `/api/chat`, `stream:false`, options
     `{temperature, num_predict}`, usage from `prompt_eval_count/eval_count`,
     no auth header, default base URL `http://localhost:11434`.
   - vLLM: openai-compatible adapter with base URL (no new file).
3. **Secrets vault** — `src/config/secrets.ts`: session-only by default;
   opt-in passphrase encryption (owner decision): WebCrypto PBKDF2-SHA256
   (310k iters, random 16B salt) → AES-GCM 256, payload
   `{salt, iv, ct}` base64 in localStorage key `openreferee.vault.v1`;
   `unlockVault(passphrase)` / `lockVault()` / `setSecret(name, value)` /
   `getSecret(name)`; wrong passphrase = OperationError → `VaultError`;
   auto-lock optional (Stage 2: lock on page unload). The factory pulls keys
   from the vault, falling back to the session in-memory map.
4. **Settings UI v2** — extend `src/ui/app.ts`: provider manager (add/remove
   named providers with type/baseUrl; key fields go to vault/session, never
   localStorage), role binding (strong/small/vision → provider+model),
   passphrase set/unlock UI, lock button, clear indication of lock state.
5. **Ollama/Anthropic notes in README** (Ollama CORS note exists; add
   Anthropic header mention).

## Design decisions (Stage-1 review carryovers)

- `ModelSpec.provider` keeps carrying the **role name** for ledger
  bookkeeping; the *provider id* rides on `ProviderConfig` resolution inside
  the factory. A rename is a breaking export change — the factory isolates
  it.
- `RateLimiter` keyed by provider **baseUrl** (roles sharing an endpoint
  share the delay budget) — documented in factory.
- `AppSettings.version` stays 1; providers map shape unchanged
  (`Record<string, ProviderConfig>` with `type` union incl. new types
  already present).

## Tasks

T1 factory + unit tests · T2 anthropic adapter + tests · T3 gemini adapter +
tests · T4 ollama adapter + tests · T5 vault + tests · T6 settings UI v2 +
tests · T7 docs + integration review + PR.

DoD: same as Stage 1 — lint/typecheck/test/build green, review waves passed,
PR open into `paluigi/open-referee-js`.
