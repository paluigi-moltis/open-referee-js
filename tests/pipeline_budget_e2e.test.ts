/**
 * Stage 7c budget e2e: budget-exhaustion wrap-up -> raise cap -> resume
 * completes; copyedit skip when the knobs exclude it. Conventions follow
 * tests/pipeline_resume_e2e.test.ts (ScriptedProvider queues recomputed
 * from ACTUAL call sequences, no-network fetch thrower, makeSettings).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { runReview } from '../src/pipeline/orchestrator';
import type { RunState, StageEvent } from '../src/pipeline/state';
import { loadRun } from '../src/runs/store';
import { readMarkdown } from '../src/ingestion/readers_md';
import type { Document } from '../src/ingestion/document';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/config/schema';
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
${'The key insight is that the constraint set admits a decomposition into convex components. '.repeat(8)}
## Methods

The estimator uses a two-stage procedure with clustering at the unit level.
${'Standard errors are computed by bootstrap with 999 replications and clustering. '.repeat(8)}

References

[1] Smith, J. (2001). A paper. Journal of Papers.
`;

function makeDoc(): Document {
  return readMarkdown(MD);
}

/** Low per-call pricing so a small cap actually trips mid-run. */
function makeSettings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    pricing: { 'm-strong': { input: 2, output: 8 } },
    roles: {
      strong: { provider: 'strong', model: 'm-strong' },
      small: { provider: 'small', model: 'm-small' },
      vision: { provider: '', model: '' },
    },
    review: { perSectionLenses: false, wholePaperPasses: false, defenseRound: false },
    ...partial,
  };
}

/** Scriptable provider that records every completed call. */
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
  const g = globalThis as unknown as Record<string, unknown>;
  g.fetch = () => Promise.reject(new TypeError('no network in budget e2e'));
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

/** A triage + claims + worker queue shared by the fixture runs. */
function queueHead(strong: ScriptedProvider): void {
  strong.queue(
    j({ mathematical_density: 'light', summary: 's' }),
    j({
      claims: [
        {
          id: 'cl001',
          type: 'logical',
          importance: 'central',
          components: { statement: 's' },
          anchor: 'bootstrap with 999 replications',
          section: 'Methods',
        },
      ],
    }),
    // claim worker (logical -> strong)
    j({ comments: [] }),
    // challengers: e5eedfa — the parsed section list is a single degenerate
    // section, so the heading-heuristic fallback splits the raw text into 2
    // reviewable chunks + the whole-paper pass = 3 challenger calls.
    j({ validated: [], new_comments: [] }),
    j({ validated: [], new_comments: [] }),
    j({ validated: [], new_comments: [] }),
  );
}

describe('budget exhaustion -> top-up -> resume completes', () => {
  it('drains mid-run on the cap, wraps up a partial report, resumes under a raised cap', async () => {
    // ---- attempt 1: cap = $0.01 with $2/$8 pricing. The triage call's
    // projection is ~$0.01046 (system ~2002 + user ~1683 chars / 3 in,
    // est_out clamps to 1000 @ $8) — the FIRST call already exceeds the
    // cap: triage fails on budget, every pending stage is marked skipped,
    // and a PARTIAL report assembles from nothing.
    const strong = new ScriptedProvider();
    const small = new ScriptedProvider();
    const capSettings = makeSettings({ maxCostUsd: 0.01 });
    const gen = runReview({
      doc: makeDoc(),
      settings: capSettings,
      providers: { strong, small },
    });
    const { state } = await drain(gen);

    // The very first projected call exceeds the $0.01 cap: triage fails on
    // budget, every pending stage is marked skipped, and a PARTIAL report
    // assembles from nothing. 7c: the drained run clears state.report (the
    // resume gate) but keeps partial=true and the skipped-stage trail.
    expect(state.partial).toBe(true);
    expect(['failed', 'running']).toContain(state.stages['triage']);
    expect(state.stages['assemble']).toBe('done');
    // The drained state is resume-ready: no report pinning the skips.
    expect(state.report).toBeUndefined();

    // ---- top-up: the run state persisted (with the doc snapshot) — reload
    // exactly like the UI resume flow does, raise the cap, resume.
    const resumeState = await loadRun(state.runId);
    expect(resumeState).toBeDefined();
    expect(resumeState!.docData).toBeDefined();

    const strong2 = new ScriptedProvider();
    const small2 = new ScriptedProvider();
    queueHead(strong2);
    // surveyor (small) + bibliography (small) + meta (strong) + copyedit
    // (small): the drain re-runs triage -> assemble (nothing had completed).
    // NB: bibliography's reply is `items: []`-safe — the audit's shape is
    // entries/in_text_issues/missing_key_references (probe-verified).
    small2.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({ items: [] }),
    );
    strong2.queue(
      j({ overall_feedback: 'topped-up report', recommendation: 'accept' }),
    );

    const raised = makeSettings({ maxCostUsd: 50 });
    const { state: final } = await drain(
      runReview({
        doc: null as unknown as Document,
        settings: raised,
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );

    // The run resumed at triage (it had failed) and completed everything.
    expect(final.stages['assemble']).toBe('done');
    const report2 = final.report as import('../src/report/models').ReviewReport;
    expect(report2.partial).toBe(false);
    expect(report2.overall).toBe('topped-up report');
    // call sequence recomputed from the ACTUAL resume re-entry: NOTHING had
    // completed in attempt 1 (triage failed on the first projection), so the
    // full pipeline replays: triage, claims, worker, 3 challengers, meta on
    // strong; surveyor, bibliography, copyedit on small. Challenger count
    // is 2 section + 1 whole-paper under the e5eedfa fallback split.
    expect(strong2.calls).toHaveLength(7);
    expect(small2.calls).toHaveLength(3);
  });

  it('resumes from the failure point WITHOUT re-calling completed stages', async () => {
    // Run deep enough to complete triage under a cap that trips mid-run
    // ($0.0106: the claims projection ~$0.0106 + the booked triage $0.0006
    // exceeds it), then resume: completed stages must NOT re-call. The
    // resume queues are recomputed from WHICH stages actually finished.
    const capSettings = makeSettings({ maxCostUsd: 0.0106 });
    const strong = new ScriptedProvider();
    const small = new ScriptedProvider();
    queueHead(strong);
    const { state } = await drain(
      runReview({
        doc: makeDoc(),
        settings: capSettings,
        providers: { strong, small },
      }),
    );
    expect(state.partial).toBe(true);
    const doneStages = (['triage', 'claims'] as const).filter(
      (s) => state.stages[s] === 'done',
    );

    const resumeState = await loadRun(state.runId);
    const strong2 = new ScriptedProvider();
    const small2 = new ScriptedProvider();
    // Re-queue ONLY what the resume will actually call: everything after the
    // completed stages (queues recomputed from actuals below via the drain).
    if (doneStages.includes('claims')) {
      // claims done -> resume at survey; worker/claims calls do not repeat.
      small2.queue(
        j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      );
      queueChallengeTail(strong2, small2);
    } else if (doneStages.includes('triage')) {
      strong2.queue(
        j({
          claims: [
            {
              id: 'cl001',
              type: 'logical',
              importance: 'central',
              components: { statement: 's' },
              anchor: 'bootstrap with 999 replications',
              section: 'Methods',
            },
          ],
        }),
      );
      // worker + challengers
      strong2.queue(j({ comments: [] }));
      strong2.queue(j({ validated: [], new_comments: [] }));
      strong2.queue(j({ validated: [], new_comments: [] }));
      strong2.queue(j({ validated: [], new_comments: [] }));
      small2.queue(
        j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      );
      queueChallengeTail(strong2, small2);
    }
    const raised = makeSettings({ maxCostUsd: 50 });
    await drain(
      runReview({
        doc: null as unknown as Document,
        settings: raised,
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );
    // Completed stages did NOT re-call: on this cap only triage completes
    // (claims is gated before its first call), so strong2 must never replay
    // the triage USER prompt (title line + full manuscript).
    if (doneStages.includes('triage')) {
      expect(
        strong2.calls.every(
          (c) =>
            !c.messages[1]!.content.startsWith(
              'Manuscript title: Test Paper\n\nManuscript',
            ),
        ),
      ).toBe(true);
    }
  });
});

/** bibliography + meta + copyedit tail (validate skipped: no comments). */
function queueChallengeTail(strong: ScriptedProvider, small: ScriptedProvider): void {
  small.queue(
    j({
      entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
      in_text_issues: [],
      missing_key_references: [],
    }),
  );
  strong.queue(
    j({ overall_feedback: 'resumed to completion', recommendation: 'minor revision' }),
  );
  small.queue(j({ items: [] }));
}

describe('copyedit knob gates', () => {
  it('knobs excluding copyedit skip the stage without a provider call', async () => {
    const s = makeSettings({
      review: {
        perSectionLenses: false,
        wholePaperPasses: false,
        defenseRound: false,
        copyedit: false,
      },
    });
    const strong = new ScriptedProvider();
    queueHead(strong);
    strong.queue(j({ overall_feedback: 'done', recommendation: 'accept' }));
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      // NO copyedit response queued: a call here would drain the queue and fail
    );
    const { state, events } = await drain(
      runReview({ doc: makeDoc(), settings: s, providers: { strong, small } }),
    );
    expect(state.stages['assemble']).toBe('done');
    expect(state.stages['copyedit']).toBe('skipped');
    expect(
      events.some(
        (e) => e.stage === 'copyedit' && e.detail?.includes('plan knobs exclude'),
      ),
    ).toBe(true);
    expect(small.calls).toHaveLength(2); // surveyor + bibliography only
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.copyeditItems).toBeUndefined();
  });

  it('knobs including copyedit run the annex (and the report carries items)', async () => {
    const s = makeSettings({
      review: {
        perSectionLenses: false,
        wholePaperPasses: false,
        defenseRound: false,
        copyedit: true,
      },
    });
    const strong = new ScriptedProvider();
    queueHead(strong);
    strong.queue(j({ overall_feedback: 'done', recommendation: 'accept' }));
    const small = new ScriptedProvider();
    small.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
      j({
        items: [
          {
            quote: 'Standard errors are computed by bootstrap',
            suggestion: 'Standard errors are computed via the bootstrap',
            kind: 'phrasing',
          },
        ],
      }),
    );
    const { state } = await drain(
      runReview({ doc: makeDoc(), settings: s, providers: { strong, small } }),
    );
    expect(state.stages['copyedit']).toBe('done');
    const report = state.report as import('../src/report/models').ReviewReport;
    expect(report.copyeditItems).toHaveLength(1);
    expect(small.calls).toHaveLength(3);
  });
});

// ------------------------------------- challenger budget gate (81f5a61) --

describe('challengers respect the budget affordance gate (81f5a61)', () => {
  it('a tripped gate passes candidates through unvalidated without challenger calls', async () => {
    // Deterministic gate trip: run 1 (preset cap) completes triage only.
    // The resume re-enters in AUTO mode with three synthetic expensive
    // section_challenger ledger records restored — the harness's empirical
    // unit cost for that type explodes, allow_call('section_challenger'/
    // 'whole_paper_challenge') goes false, and the challenge stage must pass
    // candidates through unvalidated (no challenger provider calls) while
    // claims/survey/verify/meta still run.
    const capSettings = makeSettings({ maxCostUsd: 0.0106 });
    const strong = new ScriptedProvider();
    const small = new ScriptedProvider();
    queueHead(strong);
    const first = await drain(
      runReview({
        doc: makeDoc(),
        settings: capSettings,
        providers: { strong, small },
      }),
    );
    expect(first.state.partial).toBe(true);

    // Inflate the persisted ledger with synthetic challenger spend.
    const resumeState = await loadRun(first.state.runId);
    resumeState!.ledgerCalls = [
      ...(resumeState!.ledgerCalls ?? []),
      ...Array.from({ length: 3 }, () => ({
        model: 'm-strong',
        role: 'strong',
        callType: 'section_challenger',
        inputTokens: 5_000_000,
        outputTokens: 1_000_000,
        costUsd: 1_000_000,
      })),
    ];
    const autoSettings = makeSettings({
      maxCostUsd: 10_000_000,
      budget: { depth: 'auto', budgetUsd: 52 },
      pricing: {
        'm-strong': { input: 0.01, output: 2000 },
        'm-small': { input: 0.005, output: 500 },
      },
    });
    const strong2 = new ScriptedProvider();
    const small2 = new ScriptedProvider();
    strong2.queue(
      j({
        claims: [
          {
            id: 'cl001',
            type: 'logical',
            importance: 'central',
            components: { statement: 's' },
            anchor: 'bootstrap with 999 replications',
            section: 'Methods',
          },
        ],
      }),
    );
    strong2.queue(
      j({
        comments: [
          {
            quote: 'bootstrap with 999 replications',
            message: 'the count contradicts Table 1',
            score: 0.6,
          },
        ],
      }),
    );
    // NO challenger replies: their gate must trip. Tail order: survey,
    // defense(small)+adjudication(strong) on the surviving candidate,
    // bibliography, meta, copyedit.
    small2.queue(
      j({ selected: [], state_of_the_art_notes: '', missing_references: [] }),
    );
    small2.queue(j({ defense: 'weak', defense_strength: 'weak' }));
    strong2.queue(
      j({
        verdict: 'upheld',
        reason: 'ok',
        comment: {
          title: 'count mismatch',
          paragraph_anchor: 'bootstrap with 999 replications',
          quote: 'bootstrap with 999 replications',
          message: 'the count contradicts Table 1',
          score: 0.6,
          category: 'consistency',
        },
      }),
    );
    small2.queue(
      j({
        entries: [{ raw_entry: '[1] Smith, J. (2001)', status: 'verified' }],
        in_text_issues: [],
        missing_key_references: [],
      }),
    );
    strong2.queue(
      j({ overall_feedback: 'gated but assembled', recommendation: 'minor' }),
    );
    small2.queue(j({ items: [] }));
    const second = await drain(
      runReview({
        doc: null as unknown as Document,
        settings: autoSettings,
        providers: { strong: strong2, small: small2 },
        resume: { state: resumeState! },
      }),
    );
    const state2 = second.state;
    expect(state2.stages['challenge']).toBe('done');
    expect(state2.stages['assemble']).toBe('done');
    const report = state2.report as import('../src/report/models').ReviewReport;
    expect(report.comments.map((c) => c.comment)).toContain(
      'the count contradicts Table 1',
    );
    // strong made exactly: inventory, worker, adjudication, meta — zero
    // challenger calls (their users start with 'Section:').
    expect(strong2.calls).toHaveLength(4);
    expect(
      strong2.calls.every((c) => !c.messages[1]!.content.startsWith('Section:')),
    ).toBe(true);
  });
});
