/**
 * Failure alerts: one DM card per thread whose agent run failed, holding the
 * messages a Retry re-sends. Later failures in the same thread within the
 * grouping window join the open alert instead of sending another DM.
 */
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';

registerMigration({
  version: 1,
  name: 'module:failure-alerts:alerts',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS failure_alerts (
        alert_id      TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        message_ids   TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        title         TEXT NOT NULL,
        question      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        resolved_at   TEXT,
        resolution    TEXT
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_failure_alerts_session ON failure_alerts (session_id, resolved_at)`);
  },
});

export interface FailureAlertRow {
  alert_id: string;
  session_id: string;
  /** JSON array of inbound row ids. */
  message_ids: string;
  owner_user_id: string;
  title: string;
  question: string;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

export async function createAlert(row: Omit<FailureAlertRow, 'resolved_at' | 'resolution'>): Promise<void> {
  await getDb().run(
    `INSERT INTO failure_alerts (alert_id, session_id, message_ids, owner_user_id, title, question, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.alert_id,
    row.session_id,
    row.message_ids,
    row.owner_user_id,
    row.title,
    row.question,
    row.created_at,
  );
}

export async function getAlert(alertId: string): Promise<FailureAlertRow | undefined> {
  return getDb().get<FailureAlertRow>('SELECT * FROM failure_alerts WHERE alert_id = ?', alertId);
}

/** The thread's unresolved alert created at or after `since`, newest first. */
export async function getOpenAlert(sessionId: string, since: string): Promise<FailureAlertRow | undefined> {
  return getDb().get<FailureAlertRow>(
    `SELECT * FROM failure_alerts
      WHERE session_id = ? AND resolved_at IS NULL AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1`,
    sessionId,
    since,
  );
}

export function alertMessageIds(row: FailureAlertRow): string[] {
  const ids: unknown = JSON.parse(row.message_ids);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export async function setAlertMessages(alertId: string, ids: string[]): Promise<void> {
  await getDb().run('UPDATE failure_alerts SET message_ids = ? WHERE alert_id = ?', JSON.stringify(ids), alertId);
}

/** Resolve an open alert. Returns false when it was already resolved (a second click). */
export async function resolveAlert(alertId: string, resolution: string): Promise<boolean> {
  const res = await getDb().run(
    'UPDATE failure_alerts SET resolved_at = ?, resolution = ? WHERE alert_id = ? AND resolved_at IS NULL',
    new Date().toISOString(),
    resolution,
    alertId,
  );
  return (res.changes ?? 0) > 0;
}
