import { describe, expect, it } from 'vitest';

import { getDeliveryAction } from '../../delivery.js';
import { latestRunProgress, parseRunProgressSnapshot, recordRunProgress } from './index.js';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: 'run-1',
    seq: 1,
    startedAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:01.000Z',
    status: 'running',
    stage: 'inspect',
    plan: [{ title: 'Edit headline', state: 'running' }],
    steps: [{ id: 'tu1', title: 'Read index.astro', state: 'running', category: 'inspect' }],
    earlierSteps: 0,
    waiting: null,
    statusText: null,
    ...overrides,
  };
}

describe('parseRunProgressSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(parseRunProgressSnapshot(snapshot())).toEqual(snapshot());
  });

  it('rejects malformed input', () => {
    expect(parseRunProgressSnapshot(null)).toBeNull();
    expect(parseRunProgressSnapshot(snapshot({ version: 2 }))).toBeNull();
    expect(parseRunProgressSnapshot(snapshot({ seq: 0 }))).toBeNull();
    expect(parseRunProgressSnapshot(snapshot({ status: 'exploded' }))).toBeNull();
    expect(parseRunProgressSnapshot(snapshot({ runId: '' }))).toBeNull();
  });

  it('drops bad items, normalizes categories and caps text', () => {
    const parsed = parseRunProgressSnapshot(
      snapshot({
        steps: [
          { id: 'ok', title: 'x'.repeat(500), state: 'done', category: 'weird' },
          { id: 'bad', title: 'no state' },
          'junk',
        ],
        plan: [
          { title: 'fine', state: 'pending' },
          { title: '', state: 'done' },
        ],
        waiting: { on: 'question', summary: '  Which   one? ' },
      }),
    )!;
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].category).toBe('other');
    expect(parsed.steps[0].title.length).toBeLessThanOrEqual(200);
    expect(parsed.plan).toEqual([{ title: 'fine', state: 'pending' }]);
    expect(parsed.waiting).toEqual({ on: 'question', summary: 'Which one?' });
  });
});

describe('recordRunProgress', () => {
  it('keeps only the newest seq per run', () => {
    const s2 = parseRunProgressSnapshot(snapshot({ runId: 'run-seq', seq: 2, status: 'waiting' }))!;
    const s1 = parseRunProgressSnapshot(snapshot({ runId: 'run-seq', seq: 1 }))!;
    expect(recordRunProgress('sess-1', s2)).toBe(true);
    expect(recordRunProgress('sess-1', s1)).toBe(false);
    expect(recordRunProgress('sess-1', s2)).toBe(false);
    expect(latestRunProgress('sess-1', 'run-seq')?.status).toBe('waiting');
  });
});

describe('run_progress delivery action', () => {
  it('is registered and records snapshots', async () => {
    const handler = getDeliveryAction('run_progress');
    expect(handler).toBeDefined();
    await handler!({ action: 'run_progress', snapshot: snapshot({ runId: 'run-h', seq: 3 }) }, {
      id: 'sess-h',
    } as never);
    expect(latestRunProgress('sess-h', 'run-h')?.seq).toBe(3);
  });

  it('ignores malformed snapshots without throwing', async () => {
    const handler = getDeliveryAction('run_progress')!;
    await expect(
      handler({ action: 'run_progress', snapshot: 'nope' }, { id: 'sess-x' } as never),
    ).resolves.toBeUndefined();
  });
});
