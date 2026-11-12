/**
 * Persistence for run cards: which platform message shows which run, and the
 * last snapshot rendered into it. Lets a restarted host close cards left
 * mid-run ("Interrupted") instead of leaving them saying "Working" forever.
 */
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import type { RunProgressSnapshot } from './snapshot.js';

export const RUN_CARDS_TABLE = 'run_progress_cards';

registerMigration({
  version: 1,
  name: 'module:run-progress:cards',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS run_progress_cards (
        session_id          TEXT NOT NULL,
        run_id              TEXT NOT NULL,
        channel_type        TEXT NOT NULL,
        platform_id         TEXT NOT NULL,
        thread_id           TEXT,
        instance            TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        status              TEXT NOT NULL,
        snapshot_json       TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, run_id)
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_run_progress_cards_status ON run_progress_cards (status)`);
  },
});

export interface RunCardRow {
  session_id: string;
  run_id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  instance: string;
  platform_message_id: string;
  status: string;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
}

const TERMINAL = ['done', 'failed', 'cancelled'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.includes(status);
}

export async function saveRunCard(row: RunCardRow): Promise<void> {
  await getDb().run(
    `INSERT INTO run_progress_cards
       (session_id, run_id, channel_type, platform_id, thread_id, instance, platform_message_id,
        status, snapshot_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, run_id) DO UPDATE SET
       platform_message_id = excluded.platform_message_id,
       status = excluded.status,
       snapshot_json = excluded.snapshot_json,
       updated_at = excluded.updated_at`,
    row.session_id,
    row.run_id,
    row.channel_type,
    row.platform_id,
    row.thread_id,
    row.instance,
    row.platform_message_id,
    row.status,
    row.snapshot_json,
    row.created_at,
    row.updated_at,
  );
}

/** Cards a previous host left showing a live run. */
export async function listOpenRunCards(): Promise<RunCardRow[]> {
  return getDb().all<RunCardRow>(
    `SELECT * FROM run_progress_cards WHERE status NOT IN ('done', 'failed', 'cancelled') ORDER BY created_at`,
  );
}

/** Drop finished cards older than `beforeIso` — they are history, nothing reads them. */
export async function pruneFinishedRunCards(beforeIso: string): Promise<void> {
  await getDb().run(
    `DELETE FROM run_progress_cards WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?`,
    beforeIso,
  );
}

export function rowSnapshot(row: RunCardRow): RunProgressSnapshot | null {
  try {
    return JSON.parse(row.snapshot_json) as RunProgressSnapshot;
  } catch {
    return null;
  }
}
