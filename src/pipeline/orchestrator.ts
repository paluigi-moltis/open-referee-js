/**
 * The review pipeline orchestrator (Stage 1 minimal flow).
 *
 * Port of Python `open_referee/pipeline/orchestrator.py`, narrowed to:
 * triage -> survey -> challenge (per section) -> meta -> validate -> assemble.
 *
 * Implemented as an async generator: every StageEvent is yielded AND passed
 * to `onEvent`; the generator's return value is the final RunState with the
 * assembled ReviewReport. The run never throws away its work: a stage whose
 * response fails to parse is marked failed (partial=true) and the pipeline
 * continues; a tripped budget cap marks the run partial, skips the remaining
 * stages, and still assembles a report from whatever exists.
 */

import type { AppSettings } from '../config/schema';
import type { Document } from '../ingestion/document';
import type { ChatMessage, ChatProvider, ModelSpec } from '../providers/base';
import { LLMError } from '../providers/base';
import { BudgetExceeded, UsageLedger } from '../providers/usage';
import { appendEvent, saveRun } from '../runs/store';
import type { ReviewComment, ReviewReport, UsageSummary } from '../report/models';
import {
  challengerPrompt,
  challengerSystem,
  metaPrompt,
  metaSystem,
  triagePrompt,
  triageSystem,
  validatorPrompt,
  validatorSystem,
} from './prompts';
import { extractJson } from './json';
import type { RunState, Stage, StageEvent } from './state';
import { createRunState, setStage, stageStatus } from './state';

const MAX_MANUSCRIPT_CHARS = 120_000;
const MAX_SECTION_CHARS = 40_000;

export interface StageProgress {
  unitsDone: number;
  unitsTotal: number;
}

export interface RunReviewOptions {
  doc: Document;
  settings: AppSettings;
  /**
   * Stage 1 calls only the `strong` role; `small` is accepted now so callers
   * are wired for the later stages (claims/verify/defense) that use it.
   */
  providers: { strong: ChatProvider; small: ChatProvider };
  onEvent?: (e: StageEvent, progress?: StageProgress) => void;
}

/** Role name as used in settings.roles and ledger bookkeeping. */
type Role = 'strong' | 'small';

type CallResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'invalid_json' }
  | { kind: 'llm_error'; error: LLMError }
  | { kind: 'budget'; error: BudgetExceeded };

/** Internal pipeline artifacts accumulated across stages. */
interface Artifacts {
  triage?: Record<string, unknown>;
  survey?: unknown;
  /** challenge comments, before validation */
  candidates: ReviewComment[];
  /** meta-review markdown */
  overall: string;
  recommendation?: string;
}

/**
 * Sections worth challenging: (title, text) pairs; falls back to one big
 * chunk. Mirrors Python `_reviewable_sections`.
 */
function reviewableSections(doc: Document): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  for (const s of doc.sections) {
    const text = doc.blocks
      .slice(s.startBlock, s.endBlock)
      .map((b) => b.text)
      .join('\n\n');
    if (text.length > 400) {
      out.push({ title: s.title, text });
    }
  }
  if (out.length === 0) {
    out.push({ title: 'Full manuscript', text: doc.fullText() });
  }
  return out;
}

function newRunId(): string {
  // Parity with Python: uuid4().hex[:12] — full hex, no hyphens.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return Math.random().toString(16).slice(2, 14);
}

/**
 * Run the Stage-1 review pipeline.
 *
 * Yields every StageEvent (also forwarded to `opts.onEvent`); the return
 * value is the final RunState (`result.value.report` holds the report).
 */
export async function* runReview(
  opts: RunReviewOptions,
): AsyncGenerator<StageEvent, RunState, undefined> {
  const { doc, settings, providers, onEvent } = opts;
  const state: RunState = createRunState(newRunId(), doc.title);
  const ledger = new UsageLedger(settings.maxCostUsd, settings.pricing);

  await saveRun(state);

  /**
   * The stage sequence. Unexpected exceptions (IndexedDB failure in emit, a
   * non-LLMError throw from a provider) propagate to the driver below, which
   * fails the run persistently before rethrowing — a run must never stay in
   * 'running' forever.
   */
  const pipeline = async function* (): AsyncGenerator<StageEvent, void, undefined> {
    const artifacts: Artifacts = { candidates: [], overall: '' };
    let budgetError: BudgetExceeded | undefined;

    const spec = (role: Role): ModelSpec => {
      const rc = settings.roles[role];
      return {
        provider: role,
        model: rc.model,
        temperature: rc.temperature ?? 0.2,
        maxTokens: rc.maxTokens ?? 4096,
      };
    };

    /** Persist + fan out one stage transition; yields it back to the caller. */
    async function* emit(
      stage: Stage,
      status: StageEvent['status'],
      detail?: string,
      progress?: StageProgress,
    ): AsyncGenerator<StageEvent, void, undefined> {
      const e: StageEvent = setStage(state, stage, status, detail);
      await saveRun(state);
      await appendEvent(state.runId, e);
      onEvent?.(e, progress);
      yield e;
    }

    const manuscript = doc.fullText().slice(0, MAX_MANUSCRIPT_CHARS);

    /** One budget-checked, usage-recorded, JSON-parsed completion. */
    async function callJson(
      role: Role,
      system: string,
      user: string,
    ): Promise<CallResult> {
      const s = spec(role);
      // Budget check BEFORE the call; unpriced models project 0.
      const pricing = settings.pricing[s.model];
      const estIn = (system.length + user.length) / 3;
      const estOut = Math.min(s.maxTokens, Math.max(1000, estIn / 4));
      const projected = pricing
        ? (estIn * pricing.input + estOut * pricing.output) / 1_000_000
        : 0;
      try {
        ledger.checkBudget(projected);
      } catch (err) {
        if (err instanceof BudgetExceeded) return { kind: 'budget', error: err };
        throw err;
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      let resp;
      try {
        resp = await providers[role].complete(messages, s);
      } catch (err) {
        if (err instanceof LLMError) return { kind: 'llm_error', error: err };
        throw err;
      }
      ledger.record(s.model, role, resp);
      try {
        return { kind: 'ok', value: extractJson(resp.content) };
      } catch {
        return { kind: 'invalid_json' };
      }
    }

    /** Settle a stage result; true when the pipeline should keep going. */
    async function* settle(
      stage: Stage,
      result: CallResult,
      onOk: (value: unknown) => void,
      progress?: StageProgress,
    ): AsyncGenerator<StageEvent, boolean, undefined> {
      if (result.kind === 'ok') {
        onOk(result.value);
        yield* emit(stage, 'done', undefined, progress);
        return true;
      }
      if (result.kind === 'budget') {
        // The caller handles the global budget drain; do not mark the stage here.
        return false;
      }
      if (result.kind === 'invalid_json') {
        state.partial = true;
        await saveRun(state);
        yield* emit(stage, 'failed', 'invalid JSON in model response', progress);
        return true;
      }
      state.partial = true;
      await saveRun(state);
      yield* emit(stage, 'failed', `LLM error: ${result.error.message}`, progress);
      return true;
    }

    // ------------------------------------------------------------ 1. triage --
    yield* emit('triage', 'running');
    const triageRes = await callJson(
      'strong',
      triageSystem,
      triagePrompt(doc.title, manuscript),
    );
    {
      const keep = yield* settle('triage', triageRes, (v) => {
        artifacts.triage = (v ?? {}) as Record<string, unknown>;
      });
      if (!keep) {
        budgetError = triageRes.kind === 'budget' ? triageRes.error : undefined;
      }
    }

    // ------------------------------------------------------------ 2. survey --
    if (!budgetError) {
      yield* emit('survey', 'running');
      const summary = String(artifacts.triage?.summary ?? doc.title);
      const surveyRes = await callJson(
        'strong',
        '',
        `Survey the literature context for: ${summary}`,
      );
      const keep = yield* settle('survey', surveyRes, (v) => {
        // Stage 1: store the raw skeleton; no network search.
        artifacts.survey = v;
      });
      if (!keep && surveyRes.kind === 'budget') budgetError = surveyRes.error;
    }

    // --------------------------------------------------------- 3. challenge --
    if (!budgetError) {
      yield* emit('challenge', 'running');
      const sections = reviewableSections(doc);
      let unitsDone = 0;
      let stageBroken = false;
      for (const sec of sections) {
        const res = await callJson(
          'strong',
          challengerSystem,
          challengerPrompt(sec.title, '', sec.text.slice(0, MAX_SECTION_CHARS), '[]'),
        );
        unitsDone += 1;
        const nowProgress: StageProgress = { unitsDone, unitsTotal: sections.length };
        if (res.kind === 'ok') {
          const raw = (res.value as { comments?: unknown }).comments;
          if (Array.isArray(raw)) {
            for (const c of raw) {
              if (typeof c !== 'object' || c === null) continue;
              const o = c as Record<string, unknown>;
              const severity =
                typeof o['severity'] === 'number'
                  ? Math.min(1, Math.max(0, o['severity']))
                  : 0.3;
              artifacts.candidates.push({
                section: typeof o['section'] === 'string' ? o['section'] : sec.title,
                quote: typeof o['quote'] === 'string' ? o['quote'] : '',
                comment: typeof o['comment'] === 'string' ? o['comment'] : '',
                severity,
              });
            }
          }
          yield* emit('challenge', 'running', `challenged: ${sec.title}`, nowProgress);
        } else if (res.kind === 'budget') {
          budgetError = res.error;
          break;
        } else {
          stageBroken = true;
          if (res.kind === 'invalid_json') {
            yield* emit(
              'challenge',
              'running',
              `invalid JSON for section: ${sec.title}`,
              nowProgress,
            );
          } else {
            yield* emit(
              'challenge',
              'running',
              `LLM error on section ${sec.title}: ${res.error.message}`,
              nowProgress,
            );
          }
        }
      }
      if (stageBroken) {
        state.partial = true;
        await saveRun(state);
        yield* emit('challenge', 'failed', 'one or more sections failed');
      } else if (!budgetError) {
        yield* emit('challenge', 'done', undefined, {
          unitsDone,
          unitsTotal: sections.length,
        });
      }
    }

    // -------------------------------------------------------------- 4. meta --
    if (!budgetError) {
      yield* emit('meta', 'running');
      const commentsJson = JSON.stringify(artifacts.candidates);
      const metaRes = await callJson(
        'strong',
        metaSystem,
        metaPrompt(
          doc.title,
          JSON.stringify(artifacts.triage ?? {}),
          commentsJson,
          '',
          '',
        ),
      );
      if (metaRes.kind === 'ok') {
        const v = metaRes.value;
        if (typeof v === 'object' && v !== null && 'overall_feedback' in v) {
          const o = v as Record<string, unknown>;
          artifacts.overall =
            typeof o['overall_feedback'] === 'string' ? o['overall_feedback'] : '';
          if (typeof o['recommendation'] === 'string')
            artifacts.recommendation = o['recommendation'];
        } else if (typeof v === 'string') {
          artifacts.overall = v;
        } else {
          artifacts.overall = '';
        }
        yield* emit('meta', 'done');
      } else if (metaRes.kind === 'budget') {
        budgetError = metaRes.error;
      } else if (metaRes.kind === 'invalid_json') {
        // The meta stage may legitimately answer in plain markdown: use it.
        artifacts.overall = '(meta review unparseable)';
        state.partial = true;
        await saveRun(state);
        yield* emit('meta', 'failed', 'invalid JSON in model response');
      } else {
        artifacts.overall = '';
        state.partial = true;
        await saveRun(state);
        yield* emit('meta', 'failed', `LLM error: ${metaRes.error.message}`);
      }
    }

    // ---------------------------------------------------------- 5. validate --
    const validated: ReviewComment[] = [];
    if (!budgetError && artifacts.candidates.length > 0) {
      yield* emit('validate', 'running');
      const commentsJson = JSON.stringify(artifacts.candidates);
      const valRes = await callJson(
        'strong',
        validatorSystem,
        validatorPrompt(doc.title, manuscript, commentsJson, artifacts.overall),
      );
      if (valRes.kind === 'ok') {
        const o = (valRes.value ?? {}) as Record<string, unknown>;
        const rejected = new Set<number>();
        if (Array.isArray(o['rejected'])) {
          for (const r of o['rejected']) {
            if (typeof r === 'number') rejected.add(r);
          }
        }
        // A fabricated criticism is worse than a missed one: drop rejected.
        artifacts.candidates.forEach((c, i) => {
          if (!rejected.has(i)) validated.push(c);
        });
        yield* emit('validate', 'done');
      } else if (valRes.kind === 'budget') {
        budgetError = valRes.error;
      } else {
        // Keep all candidates when validation itself fails.
        validated.push(...artifacts.candidates);
        state.partial = true;
        await saveRun(state);
        yield* emit(
          'validate',
          'failed',
          valRes.kind === 'invalid_json'
            ? 'invalid JSON in model response'
            : `LLM error: ${valRes.error.message}`,
        );
      }
    } else if (!budgetError) {
      yield* emit('validate', 'skipped', 'no candidates to validate');
    }

    // ---------------------------------------------------------- 6. assemble --
    if (budgetError) {
      // Mark the never-started stages skipped so the state machine is explicit.
      const order: Stage[] = ['triage', 'survey', 'challenge', 'meta', 'validate'];
      for (const stage of order) {
        if (stageStatus(state, stage) === 'pending') {
          yield* emit(stage, 'skipped', 'budget cap reached earlier in the run');
        }
      }
      state.partial = true;
      await saveRun(state);
      yield* emit('assemble', 'skipped', `budget cap reached: ${budgetError.message}`);
    } else {
      yield* emit('assemble', 'running');
    }

    const recommendation =
      artifacts.recommendation ??
      /(?:^|\W)(major revision|minor revision|reject|accept)(?=\W|$)/i
        .exec(artifacts.overall)?.[1]
        ?.toLowerCase();

    const byRole = ledger.byRole();
    const totals = ledger.totalTokens();
    const usage: UsageSummary = {
      byRole,
      estimatedCostUsd: Math.round(ledger.totalCost() * 10_000) / 10_000,
      totalPromptTokens: totals.prompt,
      totalCompletionTokens: totals.completion,
    };

    const report: ReviewReport = {
      paperTitle: doc.title,
      recommendation,
      overall: artifacts.overall || '_(no meta-review produced)_',
      comments: validated,
      usage,
      partial: state.partial || budgetError !== undefined,
      generatedAt: new Date().toISOString(),
    };
    state.report = report;
    await saveRun(state);
    yield* emit(
      'assemble',
      'done',
      budgetError ? 'partial report assembled' : 'report ready',
    );
  }; // end pipeline

  // Driver: an unexpected error inside the pipeline fails the current stage,
  // marks the run partial+failed, persists that terminal state, and rethrows —
  // the run never remains 'running' in IndexedDB.
  try {
    yield* pipeline();
  } catch (err) {
    const stuck: Stage | undefined = (
      ['triage', 'survey', 'challenge', 'meta', 'validate', 'assemble'] as Stage[]
    ).find((s) => stageStatus(state, s) === 'running');
    if (stuck) {
      state.partial = true;
      const e = setStage(
        state,
        stuck,
        'failed',
        `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
      onEvent?.(e);
      // Best-effort persistence; if IndexedDB itself is down there is
      // nothing more we can do.
      await saveRun(state).catch(() => undefined);
      await appendEvent(state.runId, e).catch(() => undefined);
    } else {
      state.partial = true;
      await saveRun(state).catch(() => undefined);
    }
    throw err;
  }

  return state;
}
