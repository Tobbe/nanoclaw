import { describe, expect, it } from 'vitest';

import { RunCardManager, type CardTarget, type RunCardConfig } from './manager.js';
import type { RunProgressSnapshot } from './snapshot.js';
import type { RunCardRow } from './store.js';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const TARGET: CardTarget = {
  channelType: 'slack',
  platformId: 'slack:C1',
  threadId: 'slack:C1:1.0',
  instance: 'slack',
};

function snap(seq: number, overrides: Partial<RunProgressSnapshot> = {}): RunProgressSnapshot {
  return {
    version: 1,
    runId: 'run-1',
    seq,
    startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    status: 'running',
    stage: 'inspect',
    plan: [],
    steps: [{ id: `s${seq}`, title: `Step ${seq}`, state: 'running', category: 'inspect' }],
    earlierSteps: 0,
    waiting: null,
    statusText: null,
    ...overrides,
  };
}

interface Call {
  op: 'post' | 'edit';
  messageId?: string;
  title: string;
  at: number;
}

function harness(
  opts: { config?: Partial<RunCardConfig>; running?: boolean; failEdits?: number; hangEdits?: boolean } = {},
) {
  let clock = T0;
  let running = opts.running ?? true;
  let failEdits = opts.failEdits ?? 0;
  const calls: Call[] = [];
  const saved: RunCardRow[] = [];
  const manager = new RunCardManager({
    io: {
      async post(_target, content) {
        calls.push({ op: 'post', title: content.card.title, at: clock });
        return 'ts-1';
      },
      async edit(_target, messageId, content) {
        if (opts.hangEdits) return new Promise<void>(() => {});
        if (failEdits > 0) {
          failEdits--;
          throw new Error('ratelimited');
        }
        calls.push({ op: 'edit', messageId, title: content.card.title, at: clock });
      },
    },
    save: async (row) => {
      saved.push(row);
    },
    isContainerRunning: () => running,
    now: () => clock,
    config: { editTimeoutMs: 50, ...opts.config },
  });
  /** Advance the clock one second at a time, ticking like the host's interval. */
  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      clock += 1000;
      await manager.tick();
    }
  };
  return {
    manager,
    calls,
    saved,
    run,
    setRunning: (v: boolean) => {
      running = v;
    },
    now: () => clock,
  };
}

describe('RunCardManager', () => {
  it('posts no card for a run that finishes before the threshold', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(3000);
    h.manager.accept('sess', snap(2, { status: 'done' }), TARGET);
    await h.run(20_000);
    expect(h.calls).toEqual([]);
    expect(h.manager.size).toBe(0);
  });

  it('ignores a run first seen already finished', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1, { status: 'done' }), TARGET);
    expect(h.manager.size).toBe(0);
  });

  it('posts after 8s and saves the card', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(7000);
    expect(h.calls).toEqual([]);
    await h.run(1000);
    expect(h.calls.map((c) => c.op)).toEqual(['post']);
    expect(h.saved[0]).toMatchObject({
      session_id: 'sess',
      run_id: 'run-1',
      platform_message_id: 'ts-1',
      status: 'running',
    });
  });

  it('posts at once when the run starts waiting on a person', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1, { status: 'waiting', waiting: { on: 'question', summary: 'Which?' } }), TARGET);
    await h.run(1000);
    expect(h.calls.map((c) => c.op)).toEqual(['post']);
    expect(h.calls[0].title).toContain('Waiting for an answer');
  });

  it('edits on change no more than every 3s', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(8000); // post at t=8s
    h.manager.accept('sess', snap(2), TARGET);
    await h.run(1000);
    h.manager.accept('sess', snap(3), TARGET);
    await h.run(1000);
    expect(h.calls.filter((c) => c.op === 'edit')).toHaveLength(0);
    await h.run(1000); // 3s after the post
    const edits = h.calls.filter((c) => c.op === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe('ts-1');
    // Seq 2 and 3 coalesced into one edit; nothing new to show until the refresh.
    await h.run(5000);
    expect(h.calls.filter((c) => c.op === 'edit')).toHaveLength(1);
  });

  it('refreshes the elapsed time every 15s through a long step', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(8000);
    await h.run(45_000);
    const edits = h.calls.filter((c) => c.op === 'edit');
    expect(edits.map((e) => (e.at - T0) / 1000)).toEqual([23, 38, 53]);
    expect(edits.map((e) => e.title)).toEqual([
      '⏳ Working on it · 23s',
      '⏳ Working on it · 38s',
      '⏳ Working on it · 53s',
    ]);
  });

  it('writes the final state, saves it and forgets the card', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(8000);
    h.manager.accept('sess', snap(2, { status: 'done', updatedAt: new Date(T0 + 9000).toISOString() }), TARGET);
    await h.run(1000);
    expect(h.calls.at(-1)).toMatchObject({ op: 'edit', title: '✅ Done · 9s' });
    expect(h.saved.at(-1)?.status).toBe('done');
    await h.run(1000);
    expect(h.manager.size).toBe(0);
    // A straggler snapshot for the finished run changes nothing.
    h.manager.accept('sess', snap(3), TARGET);
    await h.run(20_000);
    expect(h.calls.filter((c) => c.op === 'post')).toHaveLength(1);
  });

  it('spends a short budget on final states before refreshes', async () => {
    const h = harness({ config: { maxOpsPerTick: 1 } });
    h.manager.accept('a', snap(1, { runId: 'run-a' }), TARGET);
    h.manager.accept('b', snap(1, { runId: 'run-b' }), TARGET);
    await h.run(9000); // both posted, one per tick
    expect(h.calls.filter((c) => c.op === 'post')).toHaveLength(2);
    await h.run(13_000); // both near refresh
    h.manager.accept('b', snap(2, { runId: 'run-b', status: 'failed' }), TARGET);
    await h.run(1000);
    expect(h.calls.at(-1)?.title).toContain('Failed');
  });

  it('backs off after a failed edit and gives up on a final state after repeated failures', async () => {
    const h = harness({ failEdits: 99, config: { backoffMs: 5000, maxFinalAttempts: 3 } });
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(8000);
    h.manager.accept('sess', snap(2, { status: 'done' }), TARGET);
    await h.run(30_000);
    expect(h.calls.filter((c) => c.op === 'edit')).toHaveLength(0);
    expect(h.manager.size).toBe(0);
  });

  it('abandons an edit that hangs instead of waiting on it', async () => {
    const h = harness({ hangEdits: true });
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(8000);
    h.manager.accept('sess', snap(2), TARGET);
    // tick() resolves even though the edit never settles (timeout 50ms).
    await h.run(3000);
    expect(h.calls.map((c) => c.op)).toEqual(['post']);
  });

  it('closes a card as Interrupted when its container is gone for 30s', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(8000);
    h.setRunning(false);
    await h.run(29_000);
    expect(h.calls.some((c) => c.title.includes('Interrupted'))).toBe(false);
    await h.run(2000);
    expect(h.calls.at(-1)?.title).toContain('Interrupted');
    expect(h.saved.at(-1)?.status).toBe('cancelled');
  });

  it('drops an unposted card whose container went away', async () => {
    const h = harness({ running: false, config: { staleAfterMs: 2000 } });
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(5000);
    expect(h.calls).toEqual([]);
    expect(h.manager.size).toBe(0);
  });

  it('closes a restored card unless its run reports in', async () => {
    const row: RunCardRow = {
      session_id: 'sess',
      run_id: 'run-1',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      thread_id: 'slack:C1:1.0',
      instance: 'slack',
      platform_message_id: 'ts-old',
      status: 'running',
      seq: 4,
      snapshot_json: '{}',
      closed: 0,
      created_at: new Date(T0).toISOString(),
      updated_at: new Date(T0).toISOString(),
    };
    const gone = harness({ running: false });
    gone.manager.restore(row, snap(4));
    await gone.run(31_000);
    expect(gone.calls.at(-1)).toMatchObject({ op: 'edit', messageId: 'ts-old' });
    expect(gone.calls.at(-1)?.title).toContain('Interrupted');

    const alive = harness({ running: true });
    alive.manager.restore(row, snap(4));
    alive.manager.accept('sess', snap(5), TARGET);
    await alive.run(3000);
    expect(alive.calls).toEqual([expect.objectContaining({ op: 'edit', messageId: 'ts-old' })]);
    expect(alive.calls[0].title).toContain('Working on it');
  });

  it('finishes a restored card whose run ended while the host was down', async () => {
    // The old host accepted the final snapshot (recorded in the row) but
    // restarted before editing the card. The new host must show Done, not
    // wait for the container and guess Interrupted.
    const row: RunCardRow = {
      session_id: 'sess',
      run_id: 'run-1',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      thread_id: 'slack:C1:1.0',
      instance: 'slack',
      platform_message_id: 'ts-old',
      status: 'done',
      seq: 7,
      snapshot_json: '{}',
      closed: 0,
      created_at: new Date(T0).toISOString(),
      updated_at: new Date(T0).toISOString(),
    };
    const h = harness({ running: false });
    h.manager.restore(row, snap(7, { status: 'done', updatedAt: new Date(T0 + 42_000).toISOString() }));
    await h.run(1000);
    expect(h.calls).toEqual([expect.objectContaining({ op: 'edit', messageId: 'ts-old', title: '✅ Done · 42s' })]);
    expect(h.saved.at(-1)).toMatchObject({ status: 'done', seq: 7, closed: 1 });
    await h.run(40_000);
    expect(h.calls).toHaveLength(1);
  });

  it('saves seq and marks the row closed only with the final state', async () => {
    const h = harness();
    h.manager.accept('sess', snap(1), TARGET);
    await h.run(8000);
    expect(h.saved.at(-1)).toMatchObject({ seq: 1, closed: 0 });
    h.manager.accept('sess', snap(2, { status: 'failed' }), TARGET);
    await h.run(1000);
    expect(h.saved.at(-1)).toMatchObject({ seq: 2, status: 'failed', closed: 1 });
  });

  it('ignores stale snapshots', async () => {
    const h = harness();
    h.manager.accept('sess', snap(5), TARGET);
    await h.run(8000);
    h.manager.accept('sess', snap(4, { status: 'done' }), TARGET);
    await h.run(5000);
    expect(h.calls.every((c) => !c.title.includes('Done'))).toBe(true);
  });
});
