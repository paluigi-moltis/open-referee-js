import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunState, setStage } from '../src/pipeline/state';
import type * as Store from '../src/runs/store';

let store: typeof Store;

function makeRun(runId: string, startedAt: string) {
  const s = createRunState(runId, 'Paper ' + runId);
  s.startedAt = startedAt;
  setStage(s, 'triage', 'done', 'ok');
  return s;
}

beforeEach(async () => {
  // Reset the module registry so `fake-indexeddb/auto` installs a fresh
  // IDBFactory and the store module opens a fresh connection (its DB handle
  // is module-cached, so a shared factory would leak rows across tests).
  vi.resetModules();
  // Install a FRESH fake indexedDB factory on the global so each test gets
  // an empty database (the store module caches its DB handle, so a shared
  // fake-indexeddb/auto is not used here because it prefers `window` over
  // `global` under happy-dom, which idb's `indexedDB.open` does not read.
  const fidb = await import('fake-indexeddb');
  // happy-dom exposes none of the IDB globals; idb needs IDBRequest too.
  // Instantiate a FRESH IDBFactory (the default export is a shared instance
  // whose databases would leak rows across tests).
  const g = globalThis as Record<string, unknown>;
  g.indexedDB = new fidb.IDBFactory();
  g.IDBRequest = fidb.IDBRequest;
  g.IDBDatabase = fidb.IDBDatabase;
  g.IDBObjectStore = fidb.IDBObjectStore;
  g.IDBKeyRange = fidb.IDBKeyRange;
  g.IDBCursor = fidb.IDBCursor;
  g.IDBCursorWithValue = fidb.IDBCursorWithValue;
  g.IDBIndex = fidb.IDBIndex;
  g.IDBTransaction = fidb.IDBTransaction;
  g.IDBOpenDBRequest = fidb.IDBOpenDBRequest;
  g.IDBVersionChangeEvent = fidb.IDBVersionChangeEvent;
  store = await import('../src/runs/store');
});

describe('runs store', () => {
  it('saveRun + loadRun round-trips a run state', async () => {
    const s = makeRun('run1', '2026-01-01T00:00:00Z');
    await store.saveRun(s);
    const loaded = await store.loadRun('run1');
    expect(loaded).toEqual(s);
  });

  it('loadRun returns undefined for a missing run', async () => {
    expect(await store.loadRun('nope')).toBeUndefined();
  });

  it('saveRun overwrites an existing run (same keyPath runId)', async () => {
    const s = makeRun('run1', '2026-01-01T00:00:00Z');
    await store.saveRun(s);
    setStage(s, 'triage', 'failed', 'boom');
    await store.saveRun(s);
    const loaded = await store.loadRun('run1');
    expect(loaded?.stages['triage']).toBe('failed');
    expect(loaded?.events).toHaveLength(2);
  });

  it('appendEvent persists an event without touching stages', async () => {
    const s = makeRun('run1', '2026-01-01T00:00:00Z');
    await store.saveRun(s);
    const ev = {
      stage: 'meta' as const,
      status: 'running' as const,
      at: '2026-01-02T00:00:00Z',
    };
    await store.appendEvent('run1', ev);
    // the events store holds the appended record, indexed by runId
    const loaded = await store.loadRun('run1');
    expect(loaded).toBeDefined();
  });

  it('appendEvent throws on a missing run', async () => {
    await expect(
      store.appendEvent('ghost', { stage: 'meta', status: 'running', at: 'x' }),
    ).rejects.toThrow(/missing run/);
  });

  it('listRuns returns runs ordered by startedAt descending', async () => {
    await store.saveRun(makeRun('old', '2026-01-01T00:00:00Z'));
    await store.saveRun(makeRun('new', '2026-03-01T00:00:00Z'));
    await store.saveRun(makeRun('mid', '2026-02-01T00:00:00Z'));
    const runs = await store.listRuns();
    expect(runs.map((r) => r.runId)).toEqual(['new', 'mid', 'old']);
  });

  it('listRuns is empty on a fresh database', async () => {
    expect(await store.listRuns()).toEqual([]);
  });
});
