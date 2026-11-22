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
 * Wherever a record is shown, the thread's messages newer than it follow it
 * as written, so a reader never misses what came after the last update.
 *
 * Audience: a thread is only ever given records from the SAME messaging
 * group (same channel or DM = same audience), like the rest of this module.
 */
import { TIMEZONE } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { log } from '../../log.js';
import type { CallerContext } from '../../cli/frame.js';
import { getSession } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE, ECHO_CONCURRENCY } from './config.js';
import { mapConcurrent } from './parallel.js';
import { isOtherConversationsDm, mayReadAgentGroup } from './dm-privacy.js';

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
/** Newer messages shown after a record, the newest kept. */
export const NEWER_MESSAGES_MAX = 10;
/** Each newer message's text cap. */
export const NEWER_MESSAGE_MAX_CHARS = 400;
/** History rows read per thread to find its newer messages. */
const NEWER_SCAN = 50;

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

registerMigration({
  version: 2,
  name: 'module:thread-records:covered',
  async up(db) {
    await db.exec(`ALTER TABLE thread_records ADD COLUMN covered_in_seq INTEGER`);
    await db.exec(`ALTER TABLE thread_records ADD COLUMN covered_out_seq INTEGER`);
  },
});

export interface ThreadRecordRow {
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string;
  thread_id: string | null;
  record: string;
  updated_at: string;
  /** The last inbound / outbound seq the record covers; null for records from before cursors. */
  covered_in_seq?: number | null;
  covered_out_seq?: number | null;
}

/** The last messages a record covers, as the runner sends it. */
export interface CoveredCursor {
  inbound: number;
  outbound: number;
}

/** A record with the thread's messages newer than it, as shown. */
export interface ShownThreadRecord extends ThreadRecordRow {
  /** `lastAt`: the newest one's time (ISO). */
  newer?: { lines: string[]; more: number; lastAt: string };
}

export function parseMessage(raw: string): { text: string; sender: string; ambient: boolean } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      sender: typeof parsed.sender === 'string' ? parsed.sender : '',
      ambient: parsed.echo !== undefined,
    };
  } catch {
    return { text: '', sender: '', ambient: false };
  }
}

/** The runner's `covered` payload, or null when absent or malformed. */
export function parseCovered(value: unknown): CoveredCursor | null {
  if (!value || typeof value !== 'object') return null;
  const { inbound, outbound } = value as Record<string, unknown>;
  return Number.isInteger(inbound) && Number.isInteger(outbound)
    ? { inbound: inbound as number, outbound: outbound as number }
    : null;
}

/** Keep a session's newest record. Sessions without a conversation have none. */
export async function saveThreadRecord(
  session: Session,
  record: string,
  now = new Date(),
  covered: CoveredCursor | null = null,
): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  const text = record.trim().slice(0, THREAD_RECORD_MAX_CHARS);
  if (!text) return false;
  await getDb().run(
    `INSERT INTO thread_records
       (session_id, agent_group_id, messaging_group_id, thread_id, record, updated_at, covered_in_seq, covered_out_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       record = excluded.record, updated_at = excluded.updated_at,
       covered_in_seq = excluded.covered_in_seq, covered_out_seq = excluded.covered_out_seq`,
    session.id,
    session.agent_group_id,
    session.messaging_group_id,
    session.thread_id,
    text,
    now.toISOString(),
    covered?.inbound ?? null,
    covered?.outbound ?? null,
  );
  return true;
}

/**
 * Backfill: keep a record for a session that has none yet, stamped with the
 * thread's own last activity so it ages like a live one. Never replaces a
 * record (a live one may have landed meanwhile).
 */
export async function saveBackfilledThreadRecord(
  session: Session,
  record: string,
  lastAt: Date,
  basedOn?: string,
): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  const text = record.trim().slice(0, THREAD_RECORD_MAX_CHARS);
  if (!text) return false;
  const stamp = Number.isFinite(lastAt.getTime()) && lastAt.getTime() <= Date.now() ? lastAt : new Date();
  if (basedOn) {
    // A rebuild replaces the record it was built from, and nothing newer:
    // a live update meanwhile wins.
    const replaced = await getDb().run(
      // Built from the whole transcript up to `lastAt`: its newer messages
      // go by that time, not by the old record's cursor.
      `UPDATE thread_records SET record = ?, updated_at = ?, covered_in_seq = NULL, covered_out_seq = NULL
        WHERE session_id = ? AND updated_at = ?`,
      text,
      stamp.toISOString(),
      session.id,
      basedOn,
    );
    return (replaced?.changes ?? 0) > 0;
  }
  const result = await getDb().run(
    `INSERT INTO thread_records (session_id, agent_group_id, messaging_group_id, thread_id, record, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO NOTHING`,
    session.id,
    session.agent_group_id,
    session.messaging_group_id,
    session.thread_id,
    text,
    stamp.toISOString(),
  );
  return (result?.changes ?? 0) > 0;
}

/**
 * The host end of `thread_record_backfill`: `sender` hands in a record for
 * another thread, `{ sessionId, record, lastAt }`. Saved only when that
 * thread is readable from the sender (the `ncl sessions history` rules) and
 * has no record yet. Returns whether it was saved.
 */
export async function backfillThreadRecordFrom(sender: Session, content: Record<string, unknown>): Promise<boolean> {
  const targetId = typeof content.sessionId === 'string' ? content.sessionId : '';
  if (!targetId || typeof content.record !== 'string') {
    log.warn('thread_record_backfill: missing sessionId or record', { sessionId: sender.id });
    return false;
  }
  const target = await getSession(targetId);
  const ctx: CallerContext = {
    caller: 'agent',
    sessionId: sender.id,
    agentGroupId: sender.agent_group_id,
    messagingGroupId: sender.messaging_group_id ?? '',
  };
  if (
    !target ||
    !(await mayReadAgentGroup(ctx, target.agent_group_id)) ||
    (await isOtherConversationsDm(target, ctx.messagingGroupId))
  ) {
    log.warn('thread_record_backfill: thread not readable from this session', { sessionId: sender.id, targetId });
    return false;
  }
  const lastAt = new Date(typeof content.lastAt === 'string' ? content.lastAt : NaN);
  const basedOn = typeof content.basedOn === 'string' ? content.basedOn : undefined;
  const saved = await saveBackfilledThreadRecord(target, content.record, lastAt, basedOn);
  if (saved) log.info('Backfilled thread record', { sessionId: targetId, by: sender.id });
  return saved;
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
export function formatThreadRecords(
  rows: ShownThreadRecord[],
  timezone: string = TIMEZONE,
  options: { maxChars?: number; conversationNames?: Map<string, string> } = {},
): string {
  const maxChars = options.maxChars ?? THREAD_RECORDS_BLOCK_MAX_CHARS;
  const parts: string[] = [];
  let size = 0;
  for (const row of rows) {
    const where = options.conversationNames?.get(row.messaging_group_id);
    const head = [formatLocalStamp(new Date(row.updated_at), timezone), ...(where ? [where] : []), row.session_id];
    const newer = row.newer
      ? [
          '',
          `Since this record${row.newer.more > 0 ? ` (the newest ${row.newer.lines.length}; ${row.newer.more} earlier in \`ncl sessions history ${row.session_id}\`)` : ''}:`,
          ...row.newer.lines,
        ]
      : [];
    const entry = [`[${head.join(' · ')}]`, row.record.trim(), ...newer].join('\n');
    if (size + entry.length > maxChars) break;
    parts.push(entry);
    size += entry.length + 2;
  }
  return parts.join('\n\n');
}

/**
 * A thread's chat newer than its record: after the record's cursor, or, for
 * a record from before cursors, after the time it was written. Oldest first,
 * the newest `NEWER_MESSAGES_MAX` kept. Null when there are none.
 */
export async function newerMessages(
  row: ThreadRecordRow,
  timezone: string = TIMEZONE,
): Promise<ShownThreadRecord['newer'] | null> {
  const history = await withExistingMailboxSession(row.agent_group_id, row.session_id, (mailbox) => ({
    inbound: mailbox.getInboundHistory(NEWER_SCAN),
    outbound: mailbox.getOutboundHistory(NEWER_SCAN),
  }));
  if (!history) return null;
  const hasCursor = row.covered_in_seq != null && row.covered_out_seq != null;
  const isNewer = (seq: number | undefined, timestamp: string, covered: number | null | undefined): boolean =>
    hasCursor ? (seq ?? 0) > (covered ?? 0) : timestamp > row.updated_at;
  const found: Array<{ timestamp: string; line: string }> = [];
  const add = (timestamp: string, who: string, text: string): void => {
    const flat = text.replace(/\s+/g, ' ').trim();
    const clipped = flat.length > NEWER_MESSAGE_MAX_CHARS ? `${flat.slice(0, NEWER_MESSAGE_MAX_CHARS - 1)}…` : flat;
    found.push({ timestamp, line: `[${formatLocalStamp(new Date(timestamp), timezone)}] ${who}: ${clipped}` });
  };
  for (const r of history.inbound) {
    if ((r.kind !== 'chat' && r.kind !== 'chat-sdk') || !isNewer(r.seq, r.timestamp, row.covered_in_seq)) continue;
    const m = parseMessage(r.content);
    if (!m.ambient && m.text.trim()) add(r.timestamp, m.sender || 'someone', m.text);
  }
  for (const r of history.outbound) {
    if ((r.kind !== 'chat' && r.kind !== 'chat-sdk') || !isNewer(r.seq, r.timestamp, row.covered_out_seq)) continue;
    const m = parseMessage(r.content);
    if (m.text.trim()) add(r.timestamp, 'you', m.text);
  }
  if (found.length === 0) return null;
  found.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const kept = found.slice(-NEWER_MESSAGES_MAX);
  return {
    lines: kept.map((f) => f.line),
    more: found.length - kept.length,
    lastAt: found[found.length - 1].timestamp,
  };
}

/** Records with their threads' newer messages. A thread that can't be read shows its record alone. */
export async function withNewerMessages(
  rows: ThreadRecordRow[],
  timezone: string = TIMEZONE,
): Promise<ShownThreadRecord[]> {
  const reads = await mapConcurrent(rows, ECHO_CONCURRENCY, (row) => newerMessages(row, timezone));
  return rows.map((row, i) => {
    const read = reads[i];
    return read.status === 'fulfilled' && read.value ? { ...row, newer: read.value } : row;
  });
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
    const text = formatThreadRecords(await withNewerMessages(rows));
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
