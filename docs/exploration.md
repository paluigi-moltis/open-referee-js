# Exploration: open-referee-js

A fully static, client-side TypeScript port of [open-referee](https://github.com/paluigi/open-referee)
(Python/FastAPI). Everything — PDF/DOCX parsing, the agentic review pipeline, the
literature scouting, the report rendering — runs in the browser. The **only**
network traffic besides static asset loads is the user's own calls to their
configured LLM endpoints (plus CORS-open APIs: OpenAlex, Crossref, Tavily).
No backend, hostable on GitHub Pages / Netlify / any static CDN.

This document is the porting exploration requested before implementation.
Reference upstream: `paluigi/open-referee` @ `b72f55e` (main, post PR #1 —
verified aligned with local checkout).

---

## 1. Verdict

**No blocking issues found.** The whole Python surface has viable browser-side
equivalents. Two **design constraints** (not blockers) shape the architecture:

- **C1 — Brave Search is browser-CORS-blocked.** Verified live: its API sends
  no `Access-Control-Allow-Origin` on preflight or simple GET. OpenAlex,
  Crossref and Tavily all pass (verified `*` / reflected origins). The
  `SearchRouter` must therefore ship with Brave disabled (or proxied by an
  optional user-owned Cloudflare Worker — see §7) while OpenAlex/Crossref/Tavily
  work directly from the page. >> Exclude Brave from the JS/Typescript version
- **C2 — Anthropic requires an explicit browser header.**
  `anthropic-dangerous-direct-browser-access: true`. Gemini/OpenAI-compatible
  endpoints need no special handling; Ollama needs `OLLAMA_ORIGINS=*` on the
  user's host (documented, not codeable around). >> Add this header for Anthropic endpoints, leave a note in the readme.md and on the web page for Ollama users

## 2. Target stack

| Concern | Choice | Rationale |
|---|---|---|
| Build | **Vite 7** + vanilla TS (no framework) | The upstream UI is server-rendered htmx/Alpine; the port is a JS app that talks to LLMs — a framework buys nothing at this size, and the whole JS bundle must be vendored/bundled for the static-site + SW-cache goal. |
| Tests | **Vitest** | Mirrors the 74-test pytest surface 1:1 (same FakeProvider scripting model, same tolerant-provider shim pattern for e2e). |
| Lint/format | ESLint flat + Prettier | CI parity with ruff/black. |
| Package | pnpm | Fast, strict, Pages-friendly. |
| CI | GitHub Actions: lint + typecheck + test + build | Same role as the Python repo's. |
| Hosting | GitHub Pages (workflow included) | Fully static; PWA served from root. |

## 3. Component-by-component port map

Python module → browser equivalent, with the load-bearing notes.

### 3.1 Ingestion (`ingestion/readers.py`, `artifacts.py`, `document.py`)
- **PDF** (`pymupdf`/`fitz`) → **pdf.js** (Mozilla, ~350 KB lazy chunk).
  Text extraction per page is direct. Two upstream features need real work:
  - *Table extraction* (`find_tables` parsed cells) → **un-pdf** has no table
    parser; port the heuristic line-clusterer over pdf.js text items, or ship
    [table-transformer](https://huggingface.co/microsoft/table-transformer-detection)
    via transformers.js behind a depth-preset flag (heavy, ~50 MB model —
    v1: heuristics only).
  - *Figure region renders* (150 dpi) → pdf.js canvas render of the viewport
    clip; direct equivalent.
- **DOCX** (`python-docx`) → **mammoth** (docx→HTML) + a small style-map, or
  **docx4js** for raw XML. v1: mammoth → markdown, mirroring upstream's
  markdown-normalized intermediate.
- **Definitions pack** (`artifacts.py`: theorem environments + symbol-matched
  definitions) → pure string/regex logic, ports mechanically.
- *Caveat:* PDF text-order fidelity differs between pymupdf and pdf.js; the
  quote-anchoring matcher (§3.5) must use fuzzy matching already present
  upstream (exact → quote → token-overlap), which absorbs most of it. Known
  risk: multi-column layouts. Mitigation: reuse upstream's reading-order
  heuristics; accept degraded anchoring on exotic layouts (degrades to section
  level by design, never drops a comment).

### 3.2 Providers (`providers/`)
- `ChatProvider` (openai_compatible, anthropic, gemini, ollama, vllm, fake) →
  thin `fetch` adapters. **Streaming (SSE) parsing in the browser** is
  straightforward (`fetch` + `ReadableStream`).
- `UsageLedger` / `BudgetExceeded` → identical logic, `localStorage`-persisted
  per session; budget overrun must drain into a **partial report** (contract
  kept).
- API keys: **never** persisted. Session-only (in-memory, optional
  per-tab `sessionStorage`), with an explicit opt-in "remember on this device"
  using WebCrypto AES-GCM keyed by a user passphrase (non-extractable key
  material; a stolen `localStorage` blob is useless without the passphrase).
  Default is *not remembered*.
- Anthropic browser header (C2), Gemini's `x-goog-api-key` header (avoids
  `?key=` in URLs/logs), Ollama CORS env documented in the settings UI.

### 3.3 Pipeline (`pipeline/`)
- Orchestrator (triage → claims → survey → scout → verify → challenge →
  bibliography → meta → validator → assemble) → plain TS `async` state machine,
  **not** Web Workers for the LLM phases (they're I/O-bound). One Worker only
  for PDF ingestion (keeps the UI thread free during parsing).
- **Runs/resume** (`~/.open-referee/runs/<id>/`) → **IndexedDB** (idb wrapper).
  Artifacts, events, partial reports all persist; "resume a run" = reopen the
  state machine from IndexedDB. Export/import of a run as a `.json` file for
  durability beyond browser storage.
- **Events/SSE replay** → same event log in IndexedDB; the progress UI
  subscribes in-process (no SSE needed — it was transport, not architecture).
- Prompts (`prompts.py`, `prompts_claims.py`) → port verbatim. **Keep the
  `%PLACEHOLDER%` + `.replace()` construction** — the upstream lesson about
  `str.format()` vs literal JSON schemas applies equally to any templating
  layer we might reach for. Vitest ports of `test_prompts.py` guard persona,
  rubric bands, lens coverage.
- Claim decomposition + verify fan-out (one call per claim, definitions pack
  for math/theory→strong, mechanical→small) → direct port. Concurrency:
  keep upstream semantics; browser-friendly pool of ~4 parallel claim calls.
- Depth presets `fast/standard/deep` → same config shape.

### 3.4 Literature (`literature/`)
- `OpenAlexClient` (+ raw-REST fallback) → direct `fetch` port (CORS ✓).
- Crossref polite pool (mailto in UA) → direct (CORS ✓).
- `SearchRouter` (user-ordered failover) → direct; **Tavily ✓, Brave ✗ (C1)**.
- PubPeer/OpenReview/PREreview scout → PubPeer has an API+JSONP history but
  **no guaranteed CORS**; OpenReview API is CORS-open (API v2 sends
  `access-control-allow-origin: *`); PREreview needs checking at
  implementation time. Treat scout sources as individually optional: a
  browser-blocked source is skipped with a visible notice, never fails the
  run (upstream best-effort contract).

### 3.5 Report (`report/`)
- Canonical `ReviewReport` JSON → same schema (shared contract with Python
  repo; add a JSON-Schema file so both repos can validate).
- Markdown export → trivial. **PDF export** (`weasyprint`) → the one place
  browser > server: `window.print()` on a print-styled report view
  (zero-dependency, "Save as PDF"). No weasyprint-class fidelity needed.

### 3.6 Config & server → settings UI only
- `config.yaml`/env-var indirection disappears: there is no server. Settings =
  Typed TS object persisted in `localStorage` (llm endpoints, roles→models,
  search-engine order, depth, budget). Secrets per §3.2. Provide
  export/import + a "reset" like the Python settings UI.
- `server/app.py`, `cli.py`, Docker, PyPI packaging → **dropped** (goal 2).

## 4. PWA & caching (goal 1)

- **Vite PWA plugin** (`workbox-window` + `vite-plugin-pwa`) with a generated
  service worker emitted at **root scope** (upstream lesson: an SW not at root
  controls nothing; with Pages project-sites, ensure scope handling — use a
  custom-domain-friendly base or `Service-Worker-Allowed` header isn't
  available on Pages, so root emission under the site subpath is the plan).
- **Network-first for the app shell** with cache fallback, per requirement:
  every navigation/versioned asset tries network, falls back to cache offline.
- **Update invalidation:** the SW precache manifest is content-hashed per
  build; a new deploy produces new hashes, `registerType: "autoUpdate"` swaps
  the SW on next load, old caches are purged by Workbox's `cleanupOutdatedCaches`.
  A visible "new version available — reload" toast via `workbox-window`'s
  `onNeedRefresh` (silent auto-update, explicit UX signal). IndexedDB run
  data is keyed with the app version that wrote it; migrations run on boot.
- Runtime caching rules: **never cache** LLM API calls or API-key-bearing
  requests (explicit `NavigationRoute`/denylist); OpenAlex/Crossref GETs may
  use a small stale-while-revalidate cache for offline re-reads.

## 5. Security posture

- All storage client-side; keys session-only by default (§3.2).
- No secrets in URLs; Gemini via header; Anthropic via header.
- The static site is same-origin only; there is no server to leak to.
  CSP `connect-src` limited to: user-configured LLM origins (relaxed — user
  sets them) + `api.openalex.org` + `api.crossref.org` + `api.tavily.com`
  (+ scout hosts as they verify). Ship a `meta` CSP with generous but
  explicit defaults; document that user-added LLM origins extend it at runtime
  (CSP can't be dynamic in meta — enforce instead via the fetch adapter's
  origin allowlist, which is testable).
- XSS: prompts/report content is LLM-produced and user-document-derived —
  render markdown through a sanitizing renderer (e.g. `marked` +
  `dompurify`) everywhere; report view is the main sink.

## 6. Repo layout (proposed)

```
open-referee-js/
├─ docs/exploration.md      ← this file
├─ index.html, vite.config.ts, tsconfig.json
├─ public/ (manifest.webmanifest, icons)
├─ src/
│  ├─ ingestion/ (pdf.ts, docx.ts, document.ts, artifacts.ts)
│  ├─ providers/ (base.ts, openai.ts, anthropic.ts, gemini.ts, ollama.ts, fake.ts, usage.ts)
│  ├─ pipeline/ (orchestrator.ts, claims.ts, prompts.ts, promptsClaims.ts, state.ts, lenses.ts)
│  ├─ literature/ (openalex.ts, crossref.ts, searchRouter.ts, scout.ts)
│  ├─ report/ (models.ts, render.ts, print.ts)
│  ├─ config/ (schema.ts, storage.ts, secrets.ts)
│  ├─ ui/ (app.ts, settings.ts, progress.ts, reportView.ts)
│  └─ sw.ts (via vite-plugin-pwa)
└─ tests/ (mirroring the Python suite: anchors, claims, config, ingestion,
   pipeline-e2e, prompts, providers, regression)
```

## 7. Open questions (need owner decisions before implementation)

1. **Scout sources on day one:** drop PubPeer/PREreview if CORS check fails,
   or accept the Cloudflare-Worker path earlier (§7)? >> Drop if CORS check fails
2. **Table extraction fidelity:** heuristic port only in v1 (recommended), or
   invest in transformers.js table detection now? >> Heuristic only for v1
3. **Key persistence:** is opt-in passphrase-encrypted local storage wanted,
   or strictly session-only (strictly session-only is the safer default)? >> opt-in passphrase is welcome
4. **Parity bar for PR #2 (first code):** happy-path single review run end-to-end
   (DOCX in → report out, fake provider tests green), with PDF/claims/defense
   in follow-ups — or go stage-by-stage with the full test suite ported each
   time? >> go stage by stage
5. **Repository of record:** push directly to `paluigi/open-referee-js`, or
   maintain the fork-based convention (`paluigi-moltis`) from the Python repo?
   (Note: GitHub cannot fork an empty repo, so the fork would have to be a
   standalone repo or the branch pushed directly.) >> maintain the fork based convention

## 9. What is *not* ported

FastAPI server, htmx/Alpine server-rendered pages, SSE transport, Docker/PyPI
packaging, env-var config indirection, `open-referee serve` CLI. Their
responsibilities are absorbed by the browser app (§3.6) and the PWA layer (§4).
