import { describe, expect, it } from 'bun:test';

import type { RoutingContext } from '../formatter.js';
import type { ProviderEvent } from '../providers/types.js';
import { RunProgressSink, type RunProgressTarget } from './sink.js';
import type { RunProgressSnapshot } from './types.js';

const CHAT: RoutingContext = {
  platformId: 'slack:C1',
  channelType: 'slack',
  threadId: 'slack:C1:1.0',
  inReplyTo: 'm1',
  taskRun: false,
};

function stepEvent(id: string, state: 'running' | 'done' = 'running'): ProviderEvent {
  return {
    type: 'progress',
    message: `step ${id}`,
    detail: { kind: 'step', id, title: `step ${id}`, state, category: 'inspect' },
  };
}

function harness(opts: { enabled?: boolean } = {}) {
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  const writes: Array<{ snapshot: RunProgressSnapshot; target: RunProgressTarget }> = [];
  let runs = 0;
  const sink = new RunProgressSink({
    write: async (snapshot, target) => {
      writes.push({ snapshot, target });
    },
    newRunId: () => `run-${++runs}`,
    enabled: opts.enabled,
    intervalMs: 2500,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (const t of timers) {
      if (!t.cancelled && t.at <= clock) {
        t.cancelled = true;
        t.fn();
      }
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { sink, writes, advance, settle };
}

describe('RunProgressSink', () => {
  it('writes the first change at once, then throttles', async () => {
    const { sink, writes, advance, settle } = harness();
    sink.onEvent(stepEvent('a'), CHAT);
    sink.onEvent(stepEvent('a', 'done'), CHAT);
    sink.onEvent(stepEvent('b'), CHAT);
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0].target).toEqual({
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: 'slack:C1:1.0',
      inReplyTo: 'm1',
    });

    await advance(2500);
    expect(writes).toHaveLength(2);
    // The throttled write carries everything that happened in between.
    expect(writes[1].snapshot.steps.map((s) => `${s.id}:${s.state}`)).toEqual(['a:done', 'b:running']);
    expect(writes[1].snapshot.seq).toBeGreaterThan(writes[0].snapshot.seq);
  });

  it('writes urgent changes immediately', async () => {
    const { sink, writes, settle } = harness();
    sink.onEvent(stepEvent('q'), CHAT);
    sink.onEvent(
      { type: 'progress', message: 'Waiting', detail: { kind: 'waiting', id: 'q', on: 'question', summary: 'Which?' } },
      CHAT,
    );
    await settle();
    expect(writes).toHaveLength(2);
    expect(writes[1].snapshot.status).toBe('waiting');
  });

  it('writes the final state on finish and cancels the pending timer', async () => {
    const { sink, writes, advance } = harness();
    sink.onEvent(stepEvent('a'), CHAT);
    sink.onEvent(stepEvent('b'), CHAT);
    await sink.finish('done');
    expect(writes.map((w) => w.snapshot.status)).toEqual(['running', 'done']);
    await advance(5000);
    expect(writes).toHaveLength(2);
  });

  it('writes nothing for a turn without progress', async () => {
    const { sink, writes } = harness();
    sink.onEvent({ type: 'activity' }, CHAT);
    sink.onEvent({ type: 'text', text: 'hello' }, CHAT);
    await sink.finish('done');
    expect(writes).toHaveLength(0);
  });

  it('starts a fresh run after finish', async () => {
    const { sink, writes } = harness();
    sink.onEvent(stepEvent('a'), CHAT);
    await sink.finish('done');
    sink.onEvent(stepEvent('b'), CHAT);
    await sink.finish('failed');
    expect(writes.map((w) => `${w.snapshot.runId}:${w.snapshot.status}`)).toEqual([
      'run-1:running',
      'run-1:done',
      'run-2:running',
      'run-2:failed',
    ]);
  });

  it('skips task runs, agent routes and disabled sinks', async () => {
    const task = harness();
    task.sink.onEvent(stepEvent('a'), { ...CHAT, taskRun: true });
    task.sink.onEvent(stepEvent('a'), { ...CHAT, channelType: 'agent' });
    task.sink.onEvent(stepEvent('a'), { ...CHAT, platformId: null });
    await task.sink.finish('done');
    expect(task.writes).toHaveLength(0);

    const off = harness({ enabled: false });
    off.sink.onEvent(stepEvent('a'), CHAT);
    await off.sink.finish('done');
    expect(off.writes).toHaveLength(0);
  });

  it('turns detail-less progress into a status line', async () => {
    const { sink, writes, settle } = harness();
    sink.onEvent({ type: 'progress', message: 'status: thinking' }, CHAT);
    await settle();
    expect(writes[0].snapshot.statusText).toBe('status: thinking');
  });
});
