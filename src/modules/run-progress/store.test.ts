import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { RunProgressSnapshot } from './snapshot.js';
import {
  listOpenRunCards,
  pruneFinishedRunCards,
  recordRunCardSnapshot,
  saveRunCard,
  type RunCardRow,
} from './store.js';

function row(overrides: Partial<RunCardRow> = {}): RunCardRow {
  return {
    session_id: 'sess-1',
    run_id: 'run-1',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    thread_id: 'slack:C1:1.0',
    instance: 'slack',
    platform_message_id: 'ts-1',
    status: 'running',
    seq: 1,
    snapshot_json: '{"seq":1}',
    closed: 0,
    created_at: '2026-11-12T10:00:00.000Z',
    updated_at: '2026-11-12T10:00:00.000Z',
    ...overrides,
  };
}

function snap(seq: number, status: RunProgressSnapshot['status']): RunProgressSnapshot {
  return {
    version: 1,
    runId: 'run-1',
    seq,
    startedAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    status,
    stage: null,
    plan: [],
    steps: [],
    earlierSteps: 0,
    waiting: null,
    statusText: null,
  };
}

async function stored(runId = 'run-1') {
  return getDb().get<RunCardRow>('SELECT * FROM run_progress_cards WHERE run_id = ?', runId);
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('run card store', () => {
  it('upserts a card and lists only cards not yet closed', async () => {
    await saveRunCard(row());
    await saveRunCard(row({ run_id: 'run-2', status: 'done', closed: 1 }));
    await saveRunCard(row({ status: 'waiting', seq: 2, snapshot_json: '{"seq":2}' }));
    const open = await listOpenRunCards();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ run_id: 'run-1', status: 'waiting', seq: 2, snapshot_json: '{"seq":2}' });
    // created_at is kept from the first save.
    expect(open[0].created_at).toBe('2026-11-12T10:00:00.000Z');
  });

  it('never moves a snapshot backwards or reopens a closed card', async () => {
    await saveRunCard(row({ seq: 5, status: 'done', snapshot_json: '{"seq":5}' }));
    // A slow edit of an older snapshot lands after the newer one was recorded.
    await saveRunCard(row({ seq: 4, status: 'running', snapshot_json: '{"seq":4}', platform_message_id: 'ts-1' }));
    expect(await stored()).toMatchObject({ seq: 5, status: 'done', snapshot_json: '{"seq":5}', closed: 0 });

    await saveRunCard(row({ seq: 5, status: 'done', closed: 1 }));
    await saveRunCard(row({ seq: 6, status: 'running', closed: 0 }));
    expect((await stored())?.closed).toBe(1);
  });

  it('records a newer snapshot only for an open, posted card', async () => {
    // No card row yet (not posted): nothing to record.
    await recordRunCardSnapshot('sess-1', snap(3, 'done'), '2026-11-12T10:00:09.000Z');
    expect(await stored()).toBeUndefined();

    await saveRunCard(row({ seq: 2 }));
    await recordRunCardSnapshot('sess-1', snap(1, 'failed'), '2026-11-12T10:00:09.000Z');
    expect((await stored())?.seq).toBe(2);

    await recordRunCardSnapshot('sess-1', snap(3, 'done'), '2026-11-12T10:00:09.000Z');
    const r = await stored();
    expect(r).toMatchObject({ seq: 3, status: 'done', closed: 0 });
    expect(JSON.parse(r!.snapshot_json).status).toBe('done');
    // Still listed: its card hasn't shown the final state yet.
    expect((await listOpenRunCards()).map((x) => x.run_id)).toEqual(['run-1']);

    await saveRunCard(row({ seq: 3, status: 'done', closed: 1 }));
    await recordRunCardSnapshot('sess-1', snap(4, 'running'), '2026-11-12T10:00:10.000Z');
    expect((await stored())?.seq).toBe(3);
  });

  it('prunes only closed cards older than the cutoff', async () => {
    await saveRunCard(row({ run_id: 'old-closed', closed: 1, updated_at: '2026-11-01T00:00:00.000Z' }));
    await saveRunCard(row({ run_id: 'new-closed', closed: 1, updated_at: '2026-11-12T00:00:00.000Z' }));
    await saveRunCard(row({ run_id: 'old-open', status: 'done', updated_at: '2026-11-01T00:00:00.000Z' }));
    await pruneFinishedRunCards('2026-11-05T00:00:00.000Z');
    const ids = (await getDb().all<{ run_id: string }>('SELECT run_id FROM run_progress_cards ORDER BY run_id')).map(
      (r) => r.run_id,
    );
    expect(ids).toEqual(['new-closed', 'old-open']);
  });
});
