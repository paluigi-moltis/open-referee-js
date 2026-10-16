# open-referee-js Implementation Plan

> **For Hermes:** Execute stage-by-stage (owner decision #4). Within a stage,
> work task-by-task with TDD; commit after every green run; one PR per stage.

**Goal:** Port `paluigi/open-referee` (Python/FastAPI @ b72f55e) to a fully
static, client-side TypeScript PWA where the only network traffic is the
user's own LLM calls plus CORS-open literature APIs.

**Architecture:** Vite + vanilla TS SPA; async state-machine pipeline with
runs persisted in IndexedDB; thin `fetch` provider adapters; prompts ported
verbatim; Workbox PWA (network-first, hashed-precache invalidation).

**Tech Stack:** TypeScript 5, Vite 7, Vitest, pdf.js, mammoth, idb,
marked + dompurify, vite-plugin-pwa (workbox), GitHub Actions + Pages.

**Reference:** `docs/exploration.md` (owner decisions in §7, quoted below).

---

## Owner decisions (from exploration PR review — binding)

1. **Brave Search: excluded** from the JS/TS version entirely.
2. **Anthropic:** send `anthropic-dangerous-direct-browser-access: true`;
   README + settings-UI note for Ollama users (`OLLAMA_ORIGINS=*`).
3. **Scout sources:** drop any source whose CORS check fails (verify
   OpenReview/PubPeer/PREreview live at Stage 5 start).
4. **Table extraction:** heuristic port only in v1.
5. **Key persistence:** strictly session-only by default + **opt-in
   passphrase-encrypted local storage** (WebCrypto AES-GCM, non-extractable
   key material).
6. **Delivery:** stage-by-stage, full test-suite parity each stage.
7. **Repo convention:** fork-based (`paluigi-moltis/open-referee-js`), PRs
   into `paluigi/open-referee-js`.
8. **New features:** ① configurable **minimum delay between LLM API calls**
   (rate limiting); ② **progress bar** for the review process.

## Stage roadmap (one PR each)

| Stage | PR  | Scope                                                                                                                                                        |
| ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | #2  | Skeleton: config, fake+openai providers, usage ledger, **rate limiter**, md ingestion, prompts, state machine, minimal pipeline e2e, report render, UI shell |
| 2     | #3  | Full providers (anthropic/gemini/ollama/vllm), secrets vault, settings UI                                                                                    |
| 3     | #4  | DOCX + PDF ingestion (worker), definitions pack, artifact extraction                                                                                         |
| 4     | #5  | Claims decomposition, lenses, verify fan-out, defense–adjudication gate                                                                                      |
| 5     | #6  | Literature: OpenAlex, Crossref, Tavily-only router, scout (CORS-checked)                                                                                     |
| 6     | #7  | Report exports (print→PDF), anchoring, sanitization, **full progress UI**, run history/resume                                                                |
| 7     | #8  | PWA: network-first SW, hashed precache invalidation, update toast, cache rules, CSP                                                                          |
| 8     | #9  | Depth presets, config parity, docs, Pages release                                                                                                            |

**Every stage's definition of done:** `pnpm lint && pnpm typecheck && pnpm
test && pnpm build` all green; test suite ported for every ported module
(parity with the corresponding Python tests); README/CHANGELOG updated;
conventional commits; pushed to fork; PR open with CI green.

---

## Stage 1 — detailed tasks

Working dir: `~/coding/open-referee-js`, branch off `docs/exploration`
(fork remote = `paluigi-moltis/open-referee-js`). Node ≥ 20, pnpm ≥ 9.

### Task 1: Scaffold Vite + TS + Vitest project

**Files:** `package.json`, `tsconfig.json`, `vite.config.ts`,
`index.html`, `src/main.ts`, `.gitignore`, `.eslintrc`→flat `eslint.config.js`,
`.prettierrc`, `.github/workflows/ci.yml`.

- `pnpm create vite@latest . --template vanilla-ts` inside the repo (keep
  `docs/`, `LICENSE`); add dev deps: `vitest`, `@vitest/coverage-v8`,
  `eslint`, `typescript-eslint`, `prettier`.
- `vite.config.ts`: `base: './'` (Pages subpath-safe), `test: { environment:
'happy-dom' }`.
- CI workflow: on push/PR → `pnpm i --frozen-lockfile`, lint, typecheck,
  test, build. (Pages deploy workflow comes at Stage 7.)

**Verify:** `pnpm test` (0 tests ok), `pnpm build` emits `dist/`.
**Commit:** `chore: scaffold vite+ts+vitest project with CI`.

### Task 2: Config schema + storage

**Files:** `src/config/schema.ts`, `src/config/storage.ts`,
`tests/config.test.ts`.

Port the subset of `ReviewConfig` needed in Stage 1 (upstream:
`config/__init__.py`):

```ts
export type ProviderType =
  'openai_compatible' | 'anthropic' | 'gemini' | 'ollama' | 'vllm' | 'fake';
export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
}
export interface RoleConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}
export interface AppSettings {
  version: 1;
  providers: Record<string, ProviderConfig>;
  roles: { strong: RoleConfig; small: RoleConfig; vision: RoleConfig };
  pricing: Record<string, { input: number; output: number }>;
  requestTimeoutS: number; // default 300
  maxRetries: number; // default 3
  minDelayS: number; // FEATURE ①: default 0 (rate limiting)
  maxCostUsd: number; // UsageLedger cap
  searchOrder: string[]; // default ['tavily', 'tinyfish']  (Brave excluded — decision 1)
}
```

`storage.ts`: `loadSettings()/saveSettings()` over `localStorage` key
`openreferee.settings.v1`, deep-merged onto `DEFAULT_SETTINGS`; secrets are
**stripped on save** (stored separately in Stage 2's vault). Tests: defaults,
merge, secret-stripping, corrupt-JSON fallback to defaults.

**Commit:** `feat(config): typed settings schema + localStorage persistence`.

### Task 3: Provider base types + FakeProvider

**Files:** `src/providers/base.ts`, `src/providers/fake.ts`,
`tests/providers_fake.test.ts`.

Port contracts from `providers/base.py` exactly:

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}
export interface LLMResponse {
  content: string;
  usage: Usage;
  model: string;
}
export interface ModelSpec {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}
export class LLMError extends Error {}
export interface ChatProvider {
  complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse>;
  close(): void;
}
```

`FakeProvider` mirrors the pytest FakeProvider scripting model: queue of
scripted responses popped in call order; **empty queue throws `LLMError`**;
`queue(...jsons)` pushes; records every call (`calls: {messages, spec}[]`).
Tests: pop order, LLMError on dry queue, call recording.

**Commit:** `feat(providers): base contracts + scripted FakeProvider`.

### Task 4: OpenAI-compatible adapter (fetch, retry, rate limit hook)

**Files:** `src/providers/openai.ts`, `tests/providers_openai.test.ts`.

`fetch` POST to `${baseUrl}/chat/completions` with
`Authorization: Bearer ${apiKey}`; parse `choices[0].message.content` and
`usage.prompt_tokens/completion_tokens`. Retry on 429/5xx/network with
exponential backoff (`maxRetries`, honoring `Retry-After` if present).
Non-2xx → `LLMError` with status + body snippet. Constructor takes
`{ config, rateLimiter, fetchImpl? }` — `fetchImpl` injectable for tests.

Tests with injected fetch mock: happy path, 429-then-success (backoff faked
by injecting `setTimeout` spy), terminal 500 → LLMError, malformed JSON →
LLMError.

**Commit:** `feat(providers): openai-compatible fetch adapter with retry`.

### Task 5: UsageLedger (budget)

**Files:** `src/providers/usage.ts`, `tests/usage.test.ts`.

Port `providers/usage.py`: `estimateCost(spec, usage, pricing)`,
`checkBudget()` throws `BudgetExceeded` with `{estimatedCostUsd, capUsd}`,
`record()` appends `CallRecord`, `totalCost()`, `byRole()`. Tests: port the
assertions of `tests/test_providers.py` budget cases.

**Commit:** `feat(providers): usage ledger with budget enforcement`.

### Task 6: RateLimiter — FEATURE ①

**Files:** `src/providers/rate_limit.ts`, `tests/rate_limit.test.ts`.

```ts
export class RateLimiter {
  constructor(
    private minDelayS: number,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}
  private lastCall = new Map<string, number>(); // per provider key
  async gate(key: string): Promise<void> {
    const t = this.now();
    const last = this.lastCall.get(key);
    if (last !== undefined) {
      const waitMs = this.minDelayS * 1000 - (t - last);
      if (waitMs > 0) await this.sleep(waitMs);
    }
    this.lastCall.set(key, this.now());
  }
}
```

Wire: every adapter calls `await rateLimiter.gate(providerName)` as the
first thing in `complete()`. Setting `minDelayS` comes from
`AppSettings.minDelayS` (Task 2). Tests (fake `now`/`sleep`): zero-delay
passthrough, waits between calls, per-provider independence.

**Commit:** `feat(providers): configurable minimum delay between LLM calls`.

### Task 7: Document model + markdown ingestion

**Files:** `src/ingestion/document.ts`, `src/ingestion/readers_md.ts`,
`tests/ingestion_md.test.ts`.

Port `ingestion/document.py` (section model: id, heading level, title, text)
and the **markdown path** of `readers.py` (heading regexes, abstract
detection, reference-section split, numbered-heading matching). PDF/DOCX are
Stage 3 — `readIngest(): Promise<IngestedDocument>` dispatches by extension
and throws `UnsupportedFormatError` for pdf/docx for now.

Tests: port `tests/test_ingestion.py` markdown cases verbatim (fixtures
copied).

**Commit:** `feat(ingestion): document model + markdown reader`.

### Task 8: Prompts (persona, rubric, triage, survey, challenge, meta, validator)

**Files:** `src/pipeline/prompts.ts`, `tests/prompts.test.ts`.

Port `pipeline/prompts.py` strings **verbatim** ( REFEREE_PERSONA,
SEVERITY_RUBRIC bands 0.80–1.00/0.60–0.79/0.35–0.59/0.10–0.34, triage /
survey / challenge / meta / validator templates). Keep `%PLACEHOLDER%` +
`.replace()` construction for any parameterized template — never a templating
engine (upstream pitfall with literal JSON schemas). Tests: port
`tests/test_prompts.py` guarantees (persona presence in every agent prompt,
rubric bands present, placeholder substitution).

**Commit:** `feat(pipeline): referee prompts ported verbatim with guards`.

### Task 9: Run state + IndexedDB persistence

**Files:** `src/pipeline/state.ts`, `src/runs/store.ts`,
`tests/state.test.ts` (idb backed by `fake-indexeddb` dev dep).

Port `pipeline/state.py`: `Stage` enum (triage, survey, challenge,
bibliography, meta, validate, assemble — claims/verify/scout join in later
stages), `StageStatus`, `StageEvent`, `RunState` with `setStage()`,
`stage_status()`. Persistence: instead of `~/.open-referee/runs/<id>/`,
`idb` store `runs` keyed by `runId` (full RunState JSON per save) + `events`
store (append-only, replayable — replaces SSE transport). Tests: save/load
round-trip, event append/replay, list runs.

**Commit:** `feat(pipeline): run state machine + IndexedDB run/event stores`.

### Task 10: Minimal orchestrator (triage → survey → challenge → meta → validate → assemble)

**Files:** `src/pipeline/orchestrator.ts`, `tests/pipeline_e2e.test.ts`.

Async generator `runReview(doc, settings, providers, {onEvent})`:

- triage (strong) → paper profile; survey (strong); challenge: one call per
  section (strong); meta (strong); validator (strong, drops unsupported
  comments); assemble → `ReviewReport`.
- Persists RunState + events after **every** stage transition (resume lands
  Stage 6; state shape ready now).
- Budget: `UsageLedger.checkBudget` before every call; on `BudgetExceeded`
  → drain into **partial report** (`report.partial = true`), never discard.
- Emits progress events — FEATURE ② groundwork: `onEvent({stage, status,
unitsDone?, unitsTotal?})`; the UI progress bar (Task 11) renders from
  this stream.

Tests: port the _tolerant-provider_ pattern from the Python smoke test —
FakeProvider shim pops scripted responses when present, returns benign
defaults (`{"comments": [], "validated": [], "verdict": "major_revision"}`
merged) when dry; assert stage sequence, event log, budget-exceeded →
partial report, validator dropping an unsubstantiated comment.

**Commit:** `feat(pipeline): minimal end-to-end review state machine`.

### Task 11: Report model + markdown render + UI shell with progress bar

**Files:** `src/report/models.ts`, `src/report/render.ts`, `src/ui/app.ts`,
`src/ui/progress.ts`, `index.html`, `tests/report.test.ts`.

- `models.ts`: port `report/models.py` (`ReviewComment`, `UsageSummary`,
  `ReviewReport`, `sortedComments()`).
- `render.ts`: `reportToMarkdown()` (port `render.py` md path).
- `app.ts`: file input → ingest → run → render report into the page.
- `progress.ts` — FEATURE ②: binds the orchestrator's event stream to a
  progress bar: determinate where `unitsTotal` known (per-section
  challenge), indeterminate otherwise; stage label + elapsed time.
- All LLM/document-derived content rendered via `marked` + `dompurify`.

Tests: model serialization, md snapshot, progress state transitions.

**Commit:** `feat(report+ui): report rendering, app shell, live progress bar`.

### Task 12: Docs + PR

- README (project purpose, dev commands, **Ollama CORS note** per decision 2,
  roadmap table from this plan), CHANGELOG entry.
- Push branch to fork, PR #2 into `paluigi/open-referee-js`, CI green.

**Commit:** `docs: readme + changelog for stage 1 skeleton`.

---

## Later stages — contracts (detailed plans written at stage start)

- **Stage 2 (providers+secrets):** anthropic adapter with browser header;
  gemini via `x-goog-api-key`; ollama + vllm (openai-compatible variants);
  `src/config/secrets.ts`: opt-in vault — WebCrypto AES-GCM, PBKDF2
  (≥ 310k iters) from user passphrase, ciphertext in `localStorage`, key
  material never extractable, default remains session-only; settings UI
  (roles→providers, pricing, budget, minDelayS, search order).
- **Stage 3 (ingestion heavy):** pdf.js in a Web Worker (page text, viewport
  region renders at 150dpi-equivalent scale); heuristic table clusterer
  (decision 4); mammoth DOCX→md; definitions pack port of
  `ingestion/artifacts.py`.
- **Stage 4 (verification):** port `pipeline/claims.py` + `prompts_claims.py`
  (claim types, definitions-pack prompts, one call per claim, concurrency
  pool 4), verify lenses (`_lenses_for` incl. math/stats triage fields),
  artifact vision passes, whole-paper coherence, defense→adjudication gate.
- **Stage 5 (literature):** `openalex.ts` (+raw REST fallback), `crossref.ts`
  polite pool, SearchRouter over `['tavily', 'tinyfish']` (TinyFish verified
  browser-CORS-open 2026-10: `access-control-allow-origin: *` on preflight
  incl. `X-API-Key` header; endpoint `GET api.search.tinyfish.ai/search`);
  scout sources live-CORS
  probed at stage start, failures dropped silently-with-notice (decision 3).
- **Stage 6 (report UX):** quote→token-overlap anchoring port, print-CSS
  "export PDF", run history/resume from IndexedDB, run export/import JSON,
  full progress bar (per-claim subprogress + ETA from ledger stats).
- **Stage 7 (PWA):** vite-plugin-pwa, `registerType: 'autoUpdate'`,
  network-first app shell + hashed precache, `cleanupOutdatedCaches`,
  `onNeedRefresh` toast, denylist for LLM/API-key requests, Pages deploy
  workflow (root scope; subpath-safe base).
- **Stage 8 (parity+release):** depth presets fast/standard/deep, JSON Schema
  for ReviewReport shared with the Python repo, full docs, tagged release.

## Working conventions (all stages)

- Branch `stage/N-<slug>` off the latest merged main; push to `fork`
  (`paluigi-moltis/open-referee-js`); PR into `paluigi/open-referee-js`.
- TDD: failing test first, minimal implementation, green, commit.
- Never fight exact call counts in provider-scripted tests — tolerant shim.
- Prompts are frozen strings from the Python repo; changes to them are
  upstream-sync decisions, not local edits.
- Node 20+, pnpm; CI must stay green before every push.
