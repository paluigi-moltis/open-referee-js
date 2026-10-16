import { beforeEach, describe, expect, it } from 'vitest';
import { runReview } from '../src/pipeline/orchestrator';
import type { StageProgress } from '../src/pipeline/orchestrator';
import type { RunState, StageEvent } from '../src/pipeline/state';
import type { Document } from '../src/ingestion/document';
import { readMarkdown } from '../src/ingestion/readers_md';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/config/schema';
import { LLMError } from '../src/providers/base';
import type {
  ChatMessage,
  ChatProvider,
  LLMResponse,
  ModelSpec,
} from '../src/providers/base';
import {
  IDBFactory,
  IDBRequest,
  IDBDatabase,
  IDBObjectStore,
  IDBKeyRange,
  IDBCursor,
  IDBCursorWithValue,
  IDBIndex,
  IDBTransaction,
  IDBOpenDBRequest,
  IDBVersionChangeEvent,
} from 'fake-indexeddb';

const MD = `# Test Paper

## Introduction

We prove the main theorem in this paper and claim novelty over all prior work.
Our method introduces an entirely new bounding technique for the objective
function, which no earlier paper in this literature has attempted to use. The
key insight is that the constraint set admits a decomposition into convex
components, each of which can be handled with classical duality arguments
without any regularity conditions beyond measurability of the underlying
mapping and finiteness of the second moment of the perturbation term.

## Methods

The estimator uses a two-stage procedure with clustering at the unit level.
Standard errors are computed by bootstrap with 999 replications, and all
regressions include stratification by the treatment assignment variable. In
the first stage we estimate the nuisance function on a held-out split and
then plug it into the moment condition; in the second stage we re-center the
score and apply the influence-function correction. The asymptotic variance
estimator follows the standard sandwich form with an additional term that
accounts for the estimated nuisance parameter.
`;

function makeDoc(): Document {
  return readMarkdown(MD);
}

function makeSettings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    // Default test pricing: $2/1M input, $8/1M output.
    pricing: { 'm-strong': { input: 2, output: 8 } },
    roles: {
      strong: { provider: 'strong', model: 'm-strong' },
      small: { provider: 'small', model: 'm-small' },
      vision: { provider: '', model: '' },
    },
    ...partial,
  };
}

/** Scriptable provider that also records specs. */
class ScriptedProvider implements ChatProvider {
  readonly calls: { messages: ChatMessage[]; spec: ModelSpec }[] = [];
  private script: (string | Error)[] = [];

  queue(...contents: (string | Error)[]): void {
    this.script.push(...contents);
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    const item = this.script.shift();
    if (item === undefined) throw new Error('scripted provider queue empty');
    if (item instanceof Error) throw item;
    this.calls.push({ messages, spec });
    return {
      content: item,
      usage: { promptTokens: 100, completionTokens: 50 },
      model: spec.model,
    };
  }

  close(): void {}
}

function j(obj: unknown): string {
  return JSON.stringify(obj);
}

async function drain(gen: AsyncGenerator<StageEvent, RunState, undefined>) {
  const events: StageEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { state: next.value, events };
    events.push(next.value);
  }
}

beforeEach(() => {
  // IndexedDB store writes happen inside the orchestrator (saveRun/appendEvent).
  const g = globalThis as unknown as Record<string, unknown>;
  g.indexedDB = new IDBFactory();
  g.IDBRequest = IDBRequest;
  g.IDBDatabase = IDBDatabase;
  g.IDBObjectStore = IDBObjectStore;
  g.IDBKeyRange = IDBKeyRange;
  g.IDBCursor = IDBCursor;
  g.IDBCursorWithValue = IDBCursorWithValue;
  g.IDBIndex = IDBIndex;
  g.IDBTransaction = IDBTransaction;
  g.IDBOpenDBRequest = IDBOpenDBRequest;
  g.IDBVersionChangeEvent = IDBVersionChangeEvent;
});

describe('runReview happy path', () => {
  it('runs stages in order, emits shaped events, assembles the report', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j({
        mathematical_density: 'light',
        statistical_content: 'regression',
        summary: 'A test paper.',
      }),
      j({ selected: [], missing_references: [] }),
      // challenge: one response per reviewable section (2 here)
      j({
        comments: [
          {
            quote: 'entirely new bounding technique',
            comment: 'Prior work exists.',
            severity: 0.7,
            section: 'Introduction',
          },
        ],
      }),
      j({ comments: [] }),
      j({
        overall_feedback:
          '## Weaknesses\n\nThe novelty claim is overstated. Recommend major revision.',
        paper_summary: 's',
      }),
      j({ validated: [0], rejected: [], reasons: 'ok' }),
    );
    const small = new ScriptedProvider();
    const settings = makeSettings();

    const progressCalls: (StageProgress | undefined)[] = [];
    const gen = runReview({
      doc: makeDoc(),
      settings,
      providers: { strong, small },
      onEvent: (_e, p) => progressCalls.push(p),
    });
    const { state, events } = await drain(gen);

    // Stage order (deduped: challenge emits intermediate 'running' events too)
    const started = [
      ...new Set(events.filter((e) => e.status === 'running').map((e) => e.stage)),
    ];
    expect(started).toEqual([
      'triage',
      'survey',
      'challenge',
      'meta',
      'validate',
      'assemble',
    ]);

    // Event log shape
    for (const e of events) {
      expect(typeof e.at).toBe('string');
      expect(['pending', 'running', 'done', 'failed', 'skipped']).toContain(e.status);
    }
    expect(events[0]!.stage).toBe('triage');

    // Report assembled
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.paperTitle).toBe('Test Paper');
    expect(report.partial).toBe(false);
    expect(report.overall).toContain('major revision');
    expect(report.recommendation).toBe('major revision');
    expect(report.comments).toHaveLength(1);
    expect(report.comments[0]!.comment).toBe('Prior work exists.');
    expect(report.usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(state.partial).toBe(false);

    // strong provider got the right number of calls with the right model spec
    expect(strong.calls).toHaveLength(6);
    expect(strong.calls[0]!.spec.model).toBe('m-strong');
    expect(strong.calls[0]!.spec.temperature).toBe(0.2);
    expect(strong.calls[0]!.spec.maxTokens).toBe(4096);
    expect(small.calls).toHaveLength(0);

    // challenge progress carries unitsDone/unitsTotal
    const challengeProgress = progressCalls.filter((p) => p !== undefined);
    expect(challengeProgress.some((p) => p!.unitsTotal >= 1)).toBe(true);

    // state machine consistency
    expect(state.stages['assemble']).toBe('done');
    expect(state.events.length).toBe(events.length);
  });
});

describe('runReview budget exhaustion', () => {
  it('produces a partial report when the cap trips mid-run', async () => {
    const strong = new ScriptedProvider();
    strong.queue(j({ mathematical_density: 'light', summary: 'x' }), j({}));
    const small = new ScriptedProvider();
    // Per-call check: ledger actuals (~$0.0006/call) + projection ($0.008-0.012).
    // Cap $0.011: triage (check total ~$0.0101) and survey (~$0.0092) pass,
    // then the first challenge check (~$0.0126) trips mid-run.
    const settings = makeSettings({ maxCostUsd: 0.011 });

    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings,
        providers: { strong, small },
      }),
    );

    expect(state.partial).toBe(true);
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.partial).toBe(true);
    expect(report.comments).toHaveLength(0);
    // triage + survey ran; the challenge budget check tripped before any call
    expect(strong.calls).toHaveLength(2);
    expect(state.stages['meta']).toBe('skipped');
    expect(state.stages['validate']).toBe('skipped');
    // assemble still closes the run out (partial report), so it ends done
    expect(state.stages['assemble']).toBe('done');
    // challenge was entered but produced nothing
    expect(state.stages['challenge']).toBe('running');
  });
});

describe('runReview validator filtering', () => {
  it('drops rejected comments', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({}),
      j({
        comments: [
          { quote: 'a', comment: 'good criticism', severity: 0.8 },
          { quote: 'b', comment: 'fabricated criticism', severity: 0.9 },
          { quote: 'c', comment: 'borderline criticism', severity: 0.4 },
        ],
      }),
      j({ comments: [] }),
      j({ overall_feedback: 'report', recommendation: 'minor revision' }),
      j({ validated: [0, 2], rejected: [1], reasons: 'quote not in manuscript' }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small: new ScriptedProvider() },
      }),
    );
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.comments.map((c) => c.comment)).toEqual([
      'good criticism',
      'borderline criticism',
    ]);
  });
});

describe('runReview malformed JSON', () => {
  it('fails the stage, sets partial, and still completes the run', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      'this is not json at all', // triage: garbage
      j({}), // survey
      j({ comments: [{ quote: 'q', comment: 'kept via challenge', severity: 0.5 }] }),
      j({ comments: [] }), // section 2
      'also {{{ not json', // meta: garbage
      j({ validated: [0], rejected: [] }),
    );
    const settings = makeSettings();
    const { state, events } = await drain(
      runReview({
        doc: makeDoc(),
        settings,
        providers: { strong, small: new ScriptedProvider() },
      }),
    );

    expect(state.stages['triage']).toBe('failed');
    expect(state.stages['meta']).toBe('failed');
    expect(state.stages['assemble']).toBe('done');
    expect(state.partial).toBe(true);
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.partial).toBe(true);
    expect(report.comments.map((c) => c.comment)).toEqual(['kept via challenge']);
    expect(events.some((e) => e.stage === 'triage' && e.status === 'failed')).toBe(
      true,
    );
  });

  it('continues after an LLMError mid-challenge and keeps other sections', async () => {
    const strong = new ScriptedProvider();
    strong.queue(
      j({ summary: 's' }),
      j({}),
      new LLMError('boom'), // section 1
      j({ comments: [{ quote: 'q', comment: 'from section 2', severity: 0.6 }] }),
      j({ overall_feedback: 'ok' }),
      j({ validated: [0], rejected: [] }),
    );
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: makeSettings(),
        providers: { strong, small: new ScriptedProvider() },
      }),
    );
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.partial).toBe(true);
    expect(report.comments).toHaveLength(1);
    expect(state.stages['challenge']).toBe('failed');
    expect(state.stages['assemble']).toBe('done');
  });
});
