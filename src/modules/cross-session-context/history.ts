/**
 * `ncl sessions history <session-id>` — the pull layer of cross-session
 * context: full-depth catch-up on another conversation after the push
 * layer's one-line ambient copies.
 *
 * Reads the target session's inbound messages_in + outbound messages_out
 * (both read-only; safe with a live container) merged chronologically.
 *
 * SCOPING: custom operations bypass the dispatcher's generic post-handler
 * scope filter, so this handler self-scopes like tasks.ts `ownSession` —
 * an agent caller asking about another group's session gets the same
 * "session not found" as a nonexistent id (no cross-group existence oracle).
 */
import { AnchoredDir } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { isOtherConversationsDm, mayReadAgentGroup } from './dm-privacy.js';
import { sessionDir, withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import type { CallerContext } from '../../cli/frame.js';

export const HISTORY_DEFAULT_LIMIT = 50;
/** Per-line text cap in the human pipe-separated rendering. */
export const HISTORY_TEXT_MAX_CHARS = 200;

export interface HistoryRow {
  /** ISO-8601 UTC on the wire; the human renderer localizes. */
  timestamp: string;
  direction: 'in' | 'out';
  kind: string;
  sender: string;
  text: string;
  /**
   * Files that arrived with the message, by their path in that session
   * (`inbox/<folder>/<name>`). `ncl sessions file <id> <path>` fetches one.
   */
  attachments?: string[];
  /** An ambient copy of another thread (cross-session context), not this thread's own message. */
  ambient?: true;
}

function cell(value: string): string {
  // Keep the one-line-per-message format intact: newlines and pipes in
  // message text would shred downstream line/field parsing.
  return value.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, HISTORY_TEXT_MAX_CHARS);
}

function parseText(raw: string): { text: string; sender: string | null; attachments: string[]; ambient?: true } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text =
      typeof parsed.text === 'string' && parsed.text.length > 0
        ? parsed.text
        : typeof parsed.action === 'string'
          ? `[${parsed.action}]`
          : '';
    const attachments = Array.isArray(parsed.attachments)
      ? (parsed.attachments as Array<Record<string, unknown>>)
          .map((a) => a.localPath)
          .filter((p): p is string => typeof p === 'string' && p.startsWith('inbox/'))
      : [];
    return {
      text,
      sender: typeof parsed.sender === 'string' ? parsed.sender : null,
      attachments,
      ...(parsed.echo !== undefined ? { ambient: true as const } : {}),
    };
  } catch {
    return { text: raw, sender: null, attachments: [] };
  }
}

/**
 * Handler for the sessions `history` custom operation. Returns the merged
 * transcript as structured rows (newest `limit`, chronological order) —
 * the frame `data`, so `--json` callers get real rows with ISO timestamps.
 * Human rendering (pipe lines, localized stamps, capped cells) lives in
 * `formatHistoryLines`, wired as the operation's `formatHuman`.
 */
export async function sessionHistory(args: Record<string, unknown>, ctx: CallerContext): Promise<HistoryRow[]> {
  const sessionId = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  if (!sessionId) throw new Error('session id is required');
  const limitRaw = Number(args.limit ?? HISTORY_DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : HISTORY_DEFAULT_LIMIT;

  const session = await getSession(sessionId);
  // Self-scope (see header): cross-group agents get "not found", never "forbidden".
  if (
    !session ||
    (ctx.caller === 'agent' &&
      (!(await mayReadAgentGroup(ctx, session.agent_group_id)) ||
        (await isOtherConversationsDm(session, ctx.messagingGroupId))))
  ) {
    // Another person's DM reads as not found: its existence is private too.
    throw new Error(`session not found: ${sessionId}`);
  }

  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? 'agent';
  const rows: HistoryRow[] = [];

  const history = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
    inbound: mailbox.getInboundHistory(limit),
    outbound: mailbox.getOutboundHistory(limit),
  }));

  if (history) {
    for (const r of history.inbound) {
      const { text, sender, attachments, ambient } = parseText(r.content);
      rows.push({
        timestamp: r.timestamp,
        direction: 'in',
        kind: r.kind,
        sender: sender ?? '',
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(ambient ? { ambient } : {}),
      });
    }
    for (const r of history.outbound) {
      const { text } = parseText(r.content);
      rows.push({ timestamp: r.timestamp, direction: 'out', kind: r.kind, sender: agentName, text });
    }
  }

  rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return rows.slice(-limit);
}

/**
 * Human rendering: pipe-separated lines
 *   timestamp|direction(in/out)|kind|sender|text(first 200 chars)
 * with the timestamp in the install timezone (`timezone` injectable for
 * deterministic tests). `--json` bypasses this and gets the raw rows.
 */
export function formatHistoryLines(rows: HistoryRow[], timezone: string = TIMEZONE): string {
  return rows
    .map(
      (r) =>
        `${formatLocalStamp(new Date(r.timestamp), timezone)}|${r.direction}|${r.kind}|${cell(r.sender)}|${cell(r.text)}` +
        // Outside the text cap: a file must never be cut off.
        (r.attachments ?? []).map((p) => ` [file: ${p}]`).join(''),
    )
    .join('\n');
}

/**
 * Handler for `ncl sessions file <session-id> <path>`: copy one file that
 * arrived in another session of the caller's agent group (a path from
 * `ncl sessions history`, `inbox/<folder>/<name>`) into the caller's own
 * session, at the same path, and return where the caller's container sees
 * it. Lets an agent in a thread open an image or document someone posted in
 * an earlier thread, like a person scrolling back. Self-scoped like history.
 */
export async function sessionFile(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ path: string; bytes: number }> {
  if (ctx.caller !== 'agent') throw new Error('only an agent can fetch a file into its session');
  const sessionId = typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined;
  if (!sessionId) throw new Error('session id is required');
  const parts = typeof args.path === 'string' ? args.path.split('/') : [];
  const [root, folder, name] = parts;
  if (parts.length !== 3 || root !== 'inbox' || !isSafeAttachmentName(folder) || !isSafeAttachmentName(name)) {
    throw new Error('path must be a file path from `ncl sessions history`, like inbox/<folder>/<name>');
  }

  const source = await getSession(sessionId);
  if (
    !source ||
    source.agent_group_id !== ctx.agentGroupId ||
    (await isOtherConversationsDm(source, ctx.messagingGroupId))
  ) {
    throw new Error(`session not found: ${sessionId}`);
  }

  const from = AnchoredDir.open(sessionDir(source.agent_group_id, source.id), ['inbox', folder]);
  if (!from) throw new Error(`file not found: ${args.path as string}`);
  let data: Buffer;
  try {
    data = from.readFile(name);
  } catch {
    throw new Error(`file not found: ${args.path as string}`);
  } finally {
    from.close();
  }

  const to = AnchoredDir.open(sessionDir(ctx.agentGroupId, ctx.sessionId), ['inbox', folder], true);
  if (!to) throw new Error("could not open this session's inbox");
  try {
    to.writeNewFile(name, data);
  } catch (err) {
    // Fetched before (or it arrived here too): the copy already in place serves.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    to.close();
  }
  return { path: `/workspace/inbox/${folder}/${name}`, bytes: data.length };
}
