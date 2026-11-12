import { describe, expect, it } from 'bun:test';

import { RunProgressTracker } from './tracker.js';

const T0 = '2026-11-12T10:00:00.000Z';
const T1 = '2026-11-12T10:00:05.000Z';

function step(id: string, state: 'running' | 'done' | 'failed', category: 'inspect' | 'edit' | 'test' = 'inspect') {
  return { kind: 'step' as const, id, title: `step ${id}`, state, category };
}

describe('RunProgressTracker', () => {
  it('tracks step lifecycle and the current stage', () => {
    const t = new RunProgressTracker('run-1', T0);
    t.apply(step('a', 'running', 'inspect'), T0);
    t.apply(step('a', 'done', 'inspect'), T0);
    t.apply(step('b', 'running', 'edit'), T1);
    const s = t.snapshot();
    expect(s.status).toBe('running');
    expect(s.stage).toBe('edit');
    expect(s.steps.map((x) => `${x.id}:${x.state}`)).toEqual(['a:done', 'b:running']);
    expect(s.updatedAt).toBe(T1);
  });

  it('reports no change for a repeated event', () => {
    const t = new RunProgressTracker('run-1', T0);
    expect(t.apply(step('a', 'running'), T0).changed).toBe(true);
    expect(t.apply(step('a', 'running'), T0).changed).toBe(false);
  });

  it('keeps the newest steps and counts the rest', () => {
    const t = new RunProgressTracker('run-1', T0, 3);
    for (const id of ['1', '2', '3', '4', '5']) t.apply(step(id, 'done'), T0);
    const s = t.snapshot();
    expect(s.steps.map((x) => x.id)).toEqual(['3', '4', '5']);
    expect(s.earlierSteps).toBe(2);
  });

  it('enters and leaves waiting with the resolving step', () => {
    const t = new RunProgressTracker('run-1', T0);
    t.apply({ kind: 'step', id: 'q', title: 'Asked a question', state: 'running', category: 'ask' }, T0);
    expect(t.apply({ kind: 'waiting', id: 'q', on: 'question', summary: 'Which headline?' }, T0)).toEqual({
      changed: true,
      urgent: true,
    });
    expect(t.snapshot()).toMatchObject({ status: 'waiting', stage: 'ask', waiting: { summary: 'Which headline?' } });
    expect(
      t.apply({ kind: 'step', id: 'q', title: 'Asked a question', state: 'done', category: 'ask' }, T1).urgent,
    ).toBe(true);
    expect(t.snapshot()).toMatchObject({ status: 'running', waiting: null });
  });

  it('replaces the plan and treats a new plan as urgent', () => {
    const t = new RunProgressTracker('run-1', T0);
    const plan = { kind: 'plan' as const, items: [{ title: 'Edit headline', state: 'running' as const }] };
    expect(t.apply(plan, T0)).toEqual({ changed: true, urgent: true });
    expect(t.apply(plan, T0).changed).toBe(false);
    expect(t.snapshot().plan).toEqual([{ title: 'Edit headline', state: 'running' }]);
  });

  it('closes running steps on finish and ignores later events', () => {
    const t = new RunProgressTracker('run-1', T0);
    t.apply(step('a', 'running'), T0);
    t.finish('failed', T1);
    expect(t.apply(step('b', 'running'), T1).changed).toBe(false);
    const s = t.snapshot();
    expect(s.status).toBe('failed');
    expect(s.steps).toEqual([{ id: 'a', title: 'step a', state: 'failed', category: 'inspect' }]);
  });

  it('gives every snapshot a higher seq', () => {
    const t = new RunProgressTracker('run-1', T0);
    expect([t.snapshot().seq, t.snapshot().seq, t.snapshot().seq]).toEqual([1, 2, 3]);
  });
});
