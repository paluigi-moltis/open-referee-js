/**
 * IndexedDB persistence for review runs.
 *
 * DB `openreferee` v1 with two stores:
 * - `runs`: keyed by runId — one snapshot of the RunState per run.
 * - `events`: auto-incremented append-only event log, indexed by runId.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RunState, StageEvent } from '../pipeline/state';

interface OpenRefereeDB extends DBSchema {
  runs: {
    key: string;
    value: RunState;
  };
  events: {
    key: number;
    value: StageEvent & { runId: string };
    indexes: { byRunId: string };
  };
}

const DB_NAME = 'openreferee';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<OpenRefereeDB>> | undefined;

function db(): Promise<IDBPDatabase<OpenRefereeDB>> {
  dbPromise ??= openDB<OpenRefereeDB>(DB_NAME, DB_VERSION, {
    upgrade(d) {
      d.createObjectStore('runs', { keyPath: 'runId' });
      const events = d.createObjectStore('events', { autoIncrement: true });
      events.createIndex('byRunId', 'runId');
    },
  });
  return dbPromise;
}

/** Persist the full run state (upsert by runId). */
export async function saveRun(state: RunState): Promise<void> {
  const d = await db();
  await d.put('runs', structuredClone(state));
}

/** Load a run state by id; undefined when the run does not exist. */
export async function loadRun(runId: string): Promise<RunState | undefined> {
  const d = await db();
  return d.get('runs', runId);
}

/** Append a stage event to the run's event log. Throws when the run is missing. */
export async function appendEvent(runId: string, event: StageEvent): Promise<void> {
  const d = await db();
  const existing = await d.get('runs', runId);
  if (existing === undefined) {
    throw new Error(`appendEvent: missing run ${runId}`);
  }
  await d.add('events', { ...event, runId });
}

/** All saved runs, most recently started first. */
export async function listRuns(): Promise<RunState[]> {
  const d = await db();
  const all = await d.getAll('runs');
  return all.sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  );
}
