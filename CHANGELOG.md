# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning starts at 0.x until the Stage-8 release.

## [0.1.0] — 2026-10-16

Stage 1 skeleton of the static client-side TS port of
[open-referee](https://github.com/paluigi/open-referee).

### Added

- Vite + vanilla TypeScript project (strict mode), Vitest suite (happy-dom),
  ESLint flat config + Prettier, GitHub Actions CI (lint, typecheck, test,
  build).
- Typed settings schema with deep-merge `localStorage` persistence; API keys
  are stripped on save (session-only secrets until the Stage-2 vault).
- Provider layer: base contracts, scripted `FakeProvider` test double,
  OpenAI-compatible `fetch` adapter (retry with exponential backoff,
  `Retry-After` both seconds and HTTP-date, machine-readable `LLMError.status`),
  **min-delay rate limiter** (per-provider, concurrency-safe), and a
  `UsageLedger` with cost estimation and a `BudgetExceeded` spend cap.
- Ingestion: `Document`/`Section`/`Block` model with NFKC text normalization
  and content hashing (pure-JS SHA-256, verified against Python vectors),
  markdown reader with the upstream regexes ported exactly.
- Prompts ported **verbatim** from the Python referee (25/25 strings
  character-identical), including persona, severity rubric, and comment schema.
- Pipeline: `RunState` stage machine (triage → survey → challenge → meta →
  validate → assemble) with an append-only event log; robust JSON extraction
  from LLM responses; orchestrator implemented as an async generator with
  per-section progress, budget drain into a **partial report**, graceful stage
  failure, and crash recovery (an unexpected error persists a failed run
  instead of leaving it running); IndexedDB persistence of runs + events.
- Report model + markdown renderer mirroring the Python output; UI app shell
  with settings panel, markdown file ingest, **progress bar** (determinate
  per-section, indeterminate otherwise) with stage checklist, sanitized
  report view (marked + DOMPurify), and `.md` download.
