/**
 * Persistence for run cards: which platform message shows which run, and the
 * newest snapshot known for that run. Lets a restarted host finish a card
 * properly (Done / Failed) or close it as Interrupted, instead of leaving it
 * saying "Working" forever.
 *
 * Two writers keep a row current: the delivery handler records each newer
 * snapshot BEFORE the outbound row is marked delivered (so an accepted final
 * state is never lost to a restart), and the card manager records what it
 * posted or edited. Snapshot fields only ever move forward (`seq`), and
 * `closed` only ever goes from 0 to 1, so the two can't undo each other.
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
        seq                 INTEGER NOT NULL,
        snapshot_json       TEXT NOT NULL,
        closed              INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, run_id)
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_run_progress_cards_status ON run_progress_cards (closed)`);
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
  /** Status of the newest known snapshot (or 'cancelled' once closed as Interrupted). */
  status: string;
  /** `seq` of the newest known snapshot. */
  seq: number;
  snapshot_json: string;
  /** 1 once the card shows its final state; a closed card is never touched again. */
  closed: number;
  created_at: string;
  updated_at: string;
}

export async function saveRunCard(row: RunCardRow): Promise<void> {
  // RHS expressions see the row's old values, so every CASE compares against
  // the stored seq before this write.
  await getDb().run(
    `INSERT INTO run_progress_cards
       (session_id, run_id, channel_type, platform_id, thread_id, instance, platform_message_id,
        status, seq, snapshot_json, closed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, run_id) DO UPDATE SET
       platform_message_id = excluded.platform_message_id,
       status = CASE WHEN excluded.seq >= run_progress_cards.seq THEN excluded.status ELSE run_progress_cards.status END,
       snapshot_json = CASE WHEN excluded.seq >= run_progress_cards.seq THEN excluded.snapshot_json
                            ELSE run_progress_cards.snapshot_json END,
       seq = MAX(run_progress_cards.seq, excluded.seq),
       closed = MAX(run_progress_cards.closed, excluded.closed),
       updated_at = excluded.updated_at`,
    row.session_id,
    row.run_id,
    row.channel_type,
    row.platform_id,
    row.thread_id,
    row.instance,
    row.platform_message_id,
    row.status,
    row.seq,
    row.snapshot_json,
    row.closed,
    row.created_at,
    row.updated_at,
  );
}

/**
 * Record a newer snapshot for a card that is already posted and still open.
 * No-op when there is no such card (not posted yet, or finished) or the
 * stored snapshot is as new or newer.
 */
export async function recordRunCardSnapshot(
  sessionId: string,
  snapshot: RunProgressSnapshot,
  updatedAt: string,
): Promise<void> {
  await getDb().run(
    `UPDATE run_progress_cards SET status = ?, seq = ?, snapshot_json = ?, updated_at = ?
     WHERE session_id = ? AND run_id = ? AND closed = 0 AND seq < ?`,
    snapshot.status,
    snapshot.seq,
    JSON.stringify(snapshot),
    updatedAt,
    sessionId,
    snapshot.runId,
    snapshot.seq,
  );
}

/** Cards a previous host left without their final state — including runs that finished meanwhile. */
export async function listOpenRunCards(): Promise<RunCardRow[]> {
  return getDb().all<RunCardRow>(`SELECT * FROM run_progress_cards WHERE closed = 0 ORDER BY created_at`);
}

/** Drop closed cards older than `beforeIso` — they are history, nothing reads them. */
export async function pruneFinishedRunCards(beforeIso: string): Promise<void> {
  await getDb().run(`DELETE FROM run_progress_cards WHERE closed = 1 AND updated_at < ?`, beforeIso);
}

export function rowSnapshot(row: RunCardRow): RunProgressSnapshot | null {
  try {
    return JSON.parse(row.snapshot_json) as RunProgressSnapshot;
  } catch {
    return null;
  }
}
