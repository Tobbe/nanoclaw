import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { listOpenRunCards, pruneFinishedRunCards, saveRunCard, type RunCardRow } from './store.js';

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
    snapshot_json: '{"seq":1}',
    created_at: '2026-11-12T10:00:00.000Z',
    updated_at: '2026-11-12T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('run card store', () => {
  it('upserts a card and lists only open ones', async () => {
    await saveRunCard(row());
    await saveRunCard(row({ run_id: 'run-2', status: 'done' }));
    await saveRunCard(row({ status: 'waiting', snapshot_json: '{"seq":2}', updated_at: '2026-11-12T10:01:00.000Z' }));
    const open = await listOpenRunCards();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ run_id: 'run-1', status: 'waiting', snapshot_json: '{"seq":2}' });
    // created_at is kept from the first save.
    expect(open[0].created_at).toBe('2026-11-12T10:00:00.000Z');
  });

  it('prunes only finished cards older than the cutoff', async () => {
    await saveRunCard(row({ run_id: 'old-done', status: 'done', updated_at: '2026-11-01T00:00:00.000Z' }));
    await saveRunCard(row({ run_id: 'new-done', status: 'failed', updated_at: '2026-11-12T00:00:00.000Z' }));
    await saveRunCard(row({ run_id: 'old-open', status: 'running', updated_at: '2026-11-01T00:00:00.000Z' }));
    await pruneFinishedRunCards('2026-11-05T00:00:00.000Z');
    const { getDb } = await import('../../db/connection.js');
    const ids = (await getDb().all<{ run_id: string }>('SELECT run_id FROM run_progress_cards ORDER BY run_id')).map(
      (r) => r.run_id,
    );
    expect(ids).toEqual(['new-done', 'old-open']);
  });
});
