/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import {
  holdTypingRefresh,
  isTypingHeld,
  releaseHeldTyping,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
} from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('clearing the indicator', () => {
  function clearingAdapter() {
    const cleared: Call[] = [];
    setTypingAdapter({
      async setTyping() {},
      async clearTyping(channelType, platformId, threadId, instance) {
        cleared.push({ channelType, platformId, threadId, instance });
      },
    });
    return cleared;
  }

  it('clears when the agent stops without having posted', async () => {
    // Live-hit: the agent read "@Lise …", stayed silent, and Slack showed
    // "Typing…" for minutes.
    const cleared = clearingAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(0);
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(cleared).toEqual([{ channelType: 'slack', platformId: 'slack:C1', threadId: 'T1', instance: 'slack' }]);
  });

  it('clears when the refresh ends on its own because the agent went idle', async () => {
    const cleared = clearingAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    // No heartbeat file: once the 15 s grace is over, the next tick stops,
    // clears, and clears once more a second later.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cleared).toHaveLength(2);
  });

  it('clears even right after a delivery, then once more a second later', async () => {
    // Live-hit: CodeBot had answered, but a typing tick that reached Slack
    // just after the reply left "Typing…" under it for minutes.
    const { pauseTypingRefreshAfterDelivery } = await import('./index.js');
    const cleared = clearingAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(1_000);
    pauseTypingRefreshAfterDelivery('sess-1');
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(cleared).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cleared).toHaveLength(2);
  });

  it('clears a second after a delivery, while the refresh is still paused', async () => {
    // A tick sent just before the reply can reach Slack after it; without
    // this the clear waited for the first tick after the 10 s pause.
    const { pauseTypingRefreshAfterDelivery } = await import('./index.js');
    const cleared = clearingAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(1_000);
    pauseTypingRefreshAfterDelivery('sess-1');
    await vi.advanceTimersByTimeAsync(999);
    expect(cleared).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cleared).toEqual([{ channelType: 'slack', platformId: 'slack:C1', threadId: 'T1', instance: 'slack' }]);
    stopTypingRefresh('sess-1');
  });

  it('skips the post-delivery clear when a new message restarts typing first', async () => {
    const { pauseTypingRefreshAfterDelivery } = await import('./index.js');
    const cleared = clearingAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    pauseTypingRefreshAfterDelivery('sess-1');
    await vi.advanceTimersByTimeAsync(500);
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cleared).toEqual([]);
    stopTypingRefresh('sess-1');
  });

  it('skips the second clear when a new refresh started in between', async () => {
    const cleared = clearingAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cleared).toHaveLength(1);
    stopTypingRefresh('sess-1');
  });

  it('clearTypingNow clears even right after a delivery, then once more a second later', async () => {
    const { clearTypingNow, pauseTypingRefreshAfterDelivery } = await import('./index.js');
    const cleared = clearingAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(1_000);
    pauseTypingRefreshAfterDelivery('sess-1');
    clearTypingNow('sess-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(0);
    expect(cleared).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cleared).toEqual([
      { channelType: 'slack', platformId: 'slack:C1', threadId: 'T1', instance: 'slack' },
      { channelType: 'slack', platformId: 'slack:C1', threadId: 'T1', instance: 'slack' },
    ]);
    // The refresh is gone: no more typing ticks after Stop.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cleared).toHaveLength(2);
  });
});

describe('held typing', () => {
  it('shows nothing while held, and starts when a run begins after the hold', async () => {
    const calls = captureAdapter();
    holdTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(0);

    expect(releaseHeldTyping('sess-1', Date.now())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ channelType: 'slack', platformId: 'slack:C1', threadId: 'T1', instance: 'slack' }]);
    expect(isTypingHeld('sess-1')).toBe(false);
  });

  it('a run that started before the hold does not release it', async () => {
    const calls = captureAdapter();
    const runStarted = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    holdTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    expect(releaseHeldTyping('sess-1', runStarted)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    expect(isTypingHeld('sess-1')).toBe(true);
  });

  it('a hold lapses after ten minutes, and stopping drops it', async () => {
    captureAdapter();
    holdTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(releaseHeldTyping('sess-1', Date.now())).toBe(false);
    expect(isTypingHeld('sess-1')).toBe(false);

    holdTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    stopTypingRefresh('sess-1');
    expect(isTypingHeld('sess-1')).toBe(false);
  });

  it('does not hold while typing already shows', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    holdTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    expect(isTypingHeld('sess-1')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });
});
