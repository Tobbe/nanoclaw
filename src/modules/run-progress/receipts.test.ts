import { describe, expect, it } from 'vitest';

import type { CardTarget } from './manager.js';
import { Receipts, wantsReceipt } from './receipts.js';

const TARGET: CardTarget = { channelType: 'slack', platformId: 'slack:D1', threadId: null, instance: 'slack' };

function harness(opts: { running?: boolean; failOn?: string } = {}) {
  const calls: string[] = [];
  let clock = 0;
  let running = opts.running ?? true;
  const receipts = new Receipts({
    io: {
      async react(_t, messageId, emoji, remove) {
        if (emoji === opts.failOn) throw new Error('slack said no');
        calls.push(`${remove ? '-' : '+'}${emoji} ${messageId}`);
      },
    },
    isContainerRunning: () => running,
    now: () => clock,
    staleAfterMs: 60_000,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    receipts,
    calls,
    settle,
    advance: (ms: number) => (clock += ms),
    setRunning: (v: boolean) => (running = v),
  };
}

describe('Receipts', () => {
  it('reacts 👀 on arrival, once per message', async () => {
    const h = harness();
    h.receipts.received('s', TARGET, '1.0');
    h.receipts.received('s', TARGET, '1.0');
    await h.settle();
    expect(h.calls).toEqual(['+eyes 1.0']);
  });

  it('removes 👀 on reply when no run reported progress, adding nothing', async () => {
    const h = harness();
    h.receipts.received('s', TARGET, '1.0');
    h.receipts.replied('s');
    await h.settle();
    expect(h.calls).toEqual(['+eyes 1.0', '-eyes 1.0']);
    expect(h.receipts.size).toBe(0);
  });

  it('waits for the run to finish when one is live, then marks the outcome', async () => {
    const h = harness();
    h.receipts.received('s', TARGET, '1.0');
    h.receipts.runUpdate('s', 'running');
    h.receipts.replied('s');
    await h.settle();
    expect(h.calls).toEqual(['+eyes 1.0']);

    h.receipts.runUpdate('s', 'failed');
    await h.settle();
    expect(h.calls).toEqual(['+eyes 1.0', '-eyes 1.0', '+warning 1.0']);
  });

  it('only removes 👀 when the run was stopped', async () => {
    const h = harness();
    h.receipts.received('s', TARGET, '1.0');
    h.receipts.runUpdate('s', 'running');
    h.receipts.runUpdate('s', 'cancelled');
    await h.settle();
    expect(h.calls).toEqual(['+eyes 1.0', '-eyes 1.0']);
  });

  it('closes every message that arrived during the turn', async () => {
    const h = harness();
    h.receipts.received('s', TARGET, '1.0');
    h.receipts.received('s', TARGET, '2.0');
    h.receipts.received('other', TARGET, '3.0');
    h.receipts.replied('s');
    await h.settle();
    expect(h.calls.filter((c) => c.startsWith('-eyes'))).toEqual(['-eyes 1.0', '-eyes 2.0']);
    expect(h.receipts.size).toBe(1);
  });

  it('clears 👀 when the session has had no container for a while', async () => {
    const h = harness({ running: false });
    h.receipts.received('s', TARGET, '1.0');
    h.receipts.sweep();
    h.advance(30_000);
    h.receipts.sweep();
    expect(h.receipts.size).toBe(1);

    h.setRunning(true);
    h.receipts.sweep();
    h.setRunning(false);
    h.advance(30_000);
    h.receipts.sweep();
    expect(h.receipts.size).toBe(1); // the clock restarted when the container came back

    h.advance(60_000);
    h.receipts.sweep();
    await h.settle();
    expect(h.receipts.size).toBe(0);
    expect(h.calls).toEqual(['+eyes 1.0', '-eyes 1.0']);
  });

  it('never throws when the platform refuses a reaction', async () => {
    const h = harness({ failOn: 'eyes' });
    expect(() => h.receipts.received('s', TARGET, '1.0')).not.toThrow();
    h.receipts.replied('s');
    await h.settle();
    expect(h.receipts.size).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe('wantsReceipt', () => {
  it('acknowledges top-level chat messages only', () => {
    const base = { kind: 'chat-sdk', redirected: false, threadId: null };
    expect(wantsReceipt(base)).toBe(true);
    // In a thread the typing indicator is the acknowledgement.
    expect(wantsReceipt({ ...base, threadId: 'slack:C1:1.0' })).toBe(false);
    expect(wantsReceipt({ ...base, kind: 'chat' })).toBe(false);
    expect(wantsReceipt({ ...base, redirected: true })).toBe(false);
  });
});
