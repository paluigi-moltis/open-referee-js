import { describe, expect, it } from 'vitest';
import {
  createRunState,
  setStage,
  stageStatus,
  type RunState,
  type StageEvent,
} from '../src/pipeline/state';

describe('RunState', () => {
  it('creates a fresh pending state with ISO timestamps', () => {
    const s = createRunState('run1', 'Test Paper');
    expect(s.runId).toBe('run1');
    expect(s.documentTitle).toBe('Test Paper');
    expect(s.stages).toEqual({});
    expect(s.events).toEqual([]);
    expect(s.report).toBeUndefined();
    expect(s.partial).toBe(false);
    expect(() => new Date(s.startedAt).toISOString()).not.toThrow();
    expect(s.startedAt).toBe(s.updatedAt);
  });

  it('setStage appends an event, updates stages, bumps updatedAt', () => {
    const s = createRunState('run1', 'P');
    const before = s.updatedAt;
    const ev = setStage(s, 'triage', 'running');
    expect(s.stages['triage']).toBe('running');
    expect(s.events).toHaveLength(1);
    expect(ev).toEqual(s.events[0]);
    expect(new Date(s.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );

    setStage(s, 'triage', 'done', 'parsed OK');
    expect(s.events).toHaveLength(2);
    expect(s.events[1]).toEqual({
      stage: 'triage',
      status: 'done',
      at: expect.any(String),
      detail: 'parsed OK',
    });
  });

  it('stageStatus returns pending for unknown stages, latest otherwise', () => {
    const s = createRunState('run1', 'P');
    expect(stageStatus(s, 'survey')).toBe('pending');
    setStage(s, 'survey', 'running');
    setStage(s, 'survey', 'failed');
    expect(stageStatus(s, 'survey')).toBe('failed');
  });

  it('event shape matches StageEvent', () => {
    const s: RunState = createRunState('r', 't');
    const ev: StageEvent = setStage(s, 'assemble', 'skipped', 'budget');
    expect(Object.keys(ev).sort()).toEqual(['at', 'detail', 'stage', 'status']);
  });
});
