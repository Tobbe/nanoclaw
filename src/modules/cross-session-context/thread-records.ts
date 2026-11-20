/**
 * Thread records — what was discussed in each thread of a conversation.
 *
 * The runner keeps a short running record of its thread (topics in the order
 * they came up, decisions, what is still open) and sends it as a
 * `thread_record` system action after each answered turn
 * (container/agent-runner/src/thread-record.ts). The host keeps the newest
 * record per session here, and:
 *   - hands a brand-new thread the records of its conversation's other
 *     threads, so it knows what happened where without being asked;
 *   - serves them on demand (`ncl sessions records`) and to search.
 *
 * Audience: a thread is only ever given records from the SAME messaging
 * group (same channel or DM = same audience), like the rest of this module.
 */
import { TIMEZONE } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE } from './config.js';

/** Echo surface of the seeded block; the runner renders it as <channel-threads>. */
export const THREAD_RECORDS_SURFACE = 'thread-records';
/** Longest record kept (the runner caps at the same size). */
export const THREAD_RECORD_MAX_CHARS = 2_000;
/** How far back records reach: a thread untouched for longer drops out of the list. */
export const THREAD_RECORDS_MAX_AGE_DAYS = 60;
/** Records in one seeded block, newest first. */
export const THREAD_RECORDS_LIMIT = 40;
/** Size cap of the seeded block. */
export const THREAD_RECORDS_BLOCK_MAX_CHARS = 24_000;

registerMigration({
  version: 1,
  name: 'module:thread-records:records',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS thread_records (
        session_id         TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        thread_id          TEXT,
        record             TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      )
    `);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_thread_records_conversation
         ON thread_records (agent_group_id, messaging_group_id, updated_at)`,
    );
  },
});

export interface ThreadRecordRow {
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string;
  thread_id: string | null;
  record: string;
  updated_at: string;
}

/** Keep a session's newest record. Sessions without a conversation have none. */
export async function saveThreadRecord(session: Session, record: string, now = new Date()): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  const text = record.trim().slice(0, THREAD_RECORD_MAX_CHARS);
  if (!text) return false;
  await getDb().run(
    `INSERT INTO thread_records (session_id, agent_group_id, messaging_group_id, thread_id, record, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
    session.id,
    session.agent_group_id,
    session.messaging_group_id,
    session.thread_id,
    text,
    now.toISOString(),
  );
  return true;
}

/** A conversation's records, newest first, within the age limit. */
export async function listThreadRecords(
  agentGroupId: string,
  messagingGroupId: string,
  options: { excludeSessionId?: string; now?: number; limit?: number } = {},
): Promise<ThreadRecordRow[]> {
  const since = new Date((options.now ?? Date.now()) - THREAD_RECORDS_MAX_AGE_DAYS * 86_400_000).toISOString();
  const rows = await getDb().all<ThreadRecordRow>(
    `SELECT * FROM thread_records
      WHERE agent_group_id = ? AND messaging_group_id = ? AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT ?`,
    agentGroupId,
    messagingGroupId,
    since,
    (options.limit ?? THREAD_RECORDS_LIMIT) + 1,
  );
  return rows.filter((r) => r.session_id !== options.excludeSessionId).slice(0, options.limit ?? THREAD_RECORDS_LIMIT);
}

/** All of an agent group's records (any conversation), for search. */
export async function listGroupThreadRecords(agentGroupId: string): Promise<ThreadRecordRow[]> {
  return getDb().all<ThreadRecordRow>(
    `SELECT * FROM thread_records WHERE agent_group_id = ? ORDER BY updated_at DESC`,
    agentGroupId,
  );
}

/**
 * The block a thread reads: one entry per thread, newest first, each headed
 * by when it was last touched and its session id (for `ncl sessions history`).
 * Stops before the size cap rather than cutting a record in half.
 */
export function formatThreadRecords(rows: ThreadRecordRow[], timezone: string = TIMEZONE): string {
  const parts: string[] = [];
  let size = 0;
  for (const row of rows) {
    const entry = `[${formatLocalStamp(new Date(row.updated_at), timezone)} · ${row.session_id}]\n${row.record.trim()}`;
    if (size + entry.length > THREAD_RECORDS_BLOCK_MAX_CHARS) break;
    parts.push(entry);
    size += entry.length + 2;
  }
  return parts.join('\n\n');
}

/**
 * Give a brand-new thread the records of its conversation's other threads,
 * as one trigger=0 row written BEFORE its first message. Never throws.
 */
export async function seedThreadRecords(
  agentGroup: AgentGroup,
  session: Session,
  mg: MessagingGroup,
  options: { created: boolean; now?: number },
): Promise<void> {
  if (!options.created) return;
  try {
    const rows = await listThreadRecords(agentGroup.id, mg.id, { excludeSessionId: session.id, now: options.now });
    const text = formatThreadRecords(rows);
    if (!text) return;
    const timestamp = new Date(options.now ?? Date.now()).toISOString();
    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      await mailbox.insertMessage({
        id: `${session.id}:thread-records:${timestamp}`,
        kind: 'chat',
        timestamp,
        platformId: null,
        channelType: ECHO_CHANNEL_TYPE,
        threadId: null,
        content: JSON.stringify({
          text,
          sender: agentGroup.name,
          senderId: agentGroup.id,
          self: true,
          echo: { surface: THREAD_RECORDS_SURFACE, label: 'records of the other threads here' },
        }),
        processAfter: null,
        recurrence: null,
        trigger: false,
        sourceSessionId: null,
        onWake: false,
      });
    });
    log.debug('Seeded thread records', { sessionId: session.id, records: rows.length });
  } catch (err) {
    log.warn('Thread records seed failed (continuing without them)', { sessionId: session.id, err });
  }
}
