import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// The poll loop must hand provider progress to the run-progress sink and
// write it as `run_progress` system rows on the turn's route — and close the
// run with a final snapshot when the turn ends.

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const SLACK_ROUTING = {
  platformId: 'slack:C1',
  channelType: 'slack',
  threadId: 'slack:C1:1.0',
  inReplyTo: 'm1',
  taskRun: false,
};

function seedDest(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('slack-main', 'slack-main', 'channel', 'slack', 'slack:C1', NULL)`,
    )
    .run();
}

function stubQuery(events: AsyncGenerator<ProviderEvent>): AgentQuery {
  return { push: () => {}, end: () => {}, events, abort: () => {} };
}

function step(id: string, state: 'running' | 'done' | 'failed'): ProviderEvent {
  return {
    type: 'progress',
    message: `step ${id}`,
    detail: { kind: 'step', id, title: `Read file-${id}.ts`, state, category: 'inspect' },
  };
}

function progressRows() {
  return getUndeliveredMessages()
    .filter((r) => r.kind === 'system')
    .map((r) => ({ row: r, content: JSON.parse(r.content) as { action: string; snapshot: Record<string, unknown> } }))
    .filter((r) => r.content.action === 'run_progress');
}

describe('poll loop → run progress', () => {
  it('writes snapshots on the turn route and a final done snapshot', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield step('a', 'running');
      yield step('a', 'done');
      yield { type: 'text', text: '<message to="slack-main">All done.</message>' };
      yield { type: 'result', text: null };
    }

    await processQuery(stubQuery(events()), SLACK_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    const rows = progressRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const first = rows[0];
    expect(first.row.platform_id).toBe('slack:C1');
    expect(first.row.channel_type).toBe('slack');
    expect(first.row.thread_id).toBe('slack:C1:1.0');
    const last = rows[rows.length - 1].content.snapshot;
    expect(last.status).toBe('done');
    expect(last.steps).toEqual([{ id: 'a', title: 'Read file-a.ts', state: 'done', category: 'inspect' }]);
    const seqs = rows.map((r) => r.content.snapshot.seq as number);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);

    // The reply itself is still delivered as a normal chat row.
    const chat = getUndeliveredMessages().filter((r) => r.kind === 'chat');
    expect(chat.map((r) => JSON.parse(r.content).text)).toEqual(['All done.']);
  });

  it('marks the run failed on an error result', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield step('a', 'running');
      yield { type: 'result', text: null, isError: true, error: 'quota exceeded' };
    }

    await processQuery(stubQuery(events()), SLACK_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    const rows = progressRows();
    const last = rows[rows.length - 1].content.snapshot;
    expect(last.status).toBe('failed');
    expect((last.steps as Array<{ state: string }>)[0].state).toBe('failed');
  });

  it('marks the run failed when the query throws', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield step('a', 'running');
      throw new Error('boom');
    }

    await expect(
      processQuery(stubQuery(events()), SLACK_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow('boom');

    const rows = progressRows();
    expect(rows[rows.length - 1].content.snapshot.status).toBe('failed');
  });

  it('writes nothing for a task run or a turn without progress', async () => {
    async function* taskEvents(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield step('a', 'running');
      yield { type: 'result', text: 'summary' };
    }
    await processQuery(
      stubQuery(taskEvents()),
      { platformId: null, channelType: null, threadId: 'system:tasks:t', inReplyTo: 't1', taskRun: true },
      ['t1'],
      'claude',
      undefined,
      'prompt',
      undefined,
      true,
    );
    expect(progressRows()).toHaveLength(0);

    seedDest();
    async function* quickEvents(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="slack-main">4</message>' };
      yield { type: 'result', text: null };
    }
    await processQuery(stubQuery(quickEvents()), SLACK_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);
    expect(progressRows()).toHaveLength(0);
  });
});
