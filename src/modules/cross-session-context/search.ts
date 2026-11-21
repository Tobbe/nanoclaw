/**
 * `ncl sessions search <query>` — find where something was said across all
 * of an agent group's conversations, and `ncl sessions records` — the
 * records of the caller's own conversation.
 *
 * Search reads every session of the group: its thread record (when it has
 * one) and the chat messages in and out, skipping the ambient copies of
 * other threads. A hit is a message or record containing any of the query's
 * words (case-insensitive, word starts, so "farve" also finds "farver");
 * more distinct words matched rank higher, then newer first. Each hit names
 * its session, so `ncl sessions history <id>` opens the full thread.
 *
 * Scoped like history: an agent searches only its own agent group. Within
 * it, an agent sees its own conversation plus the group's shared ones
 * (channels, rooms), never another person's DM: what was said privately
 * must not surface in a channel.
 */
import { TIMEZONE } from '../../config.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import type { CallerContext } from '../../cli/frame.js';
import { ECHO_CONCURRENCY } from './config.js';
import { mayReadAgentGroup } from './dm-privacy.js';
import { mapConcurrent } from './parallel.js';
import { formatThreadRecords, listGroupThreadRecords, listThreadRecords } from './thread-records.js';

export const SEARCH_DEFAULT_LIMIT = 15;
/** Size cap of the group-wide records list (`records --all`, read by recall). */
export const ALL_RECORDS_MAX_CHARS = 300_000;
/** Messages read per session and direction. */
const SEARCH_SCAN_PER_SESSION = 2_000;
const SNIPPET_CHARS = 240;

export interface SearchHit {
  /** ISO-8601 UTC. */
  timestamp: string;
  sessionId: string;
  kind: 'record' | 'message';
  sender: string;
  /** The thread's record title (its first line), when it has a record. */
  thread?: string;
  snippet: string;
  /** Distinct query words found. */
  score: number;
}

interface Candidate {
  timestamp: string;
  sessionId: string;
  kind: 'record' | 'message';
  sender: string;
  text: string;
}

/** Query → lower-cased words worth matching. */
export function queryTerms(query: string): string[] {
  const words = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}#]+/u)
    .filter((w) => w.length >= 2);
  return [...new Set(words)];
}

/** Each term's first match position in `text`, at a word start. -1 when absent. */
function matchAt(text: string, term: string): number {
  const lower = text.toLocaleLowerCase();
  let from = 0;
  while (from <= lower.length) {
    const i = lower.indexOf(term, from);
    if (i === -1) return -1;
    if (i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1])) return i;
    from = i + 1;
  }
  return -1;
}

function snippetAround(text: string, at: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SNIPPET_CHARS) return flat;
  const start = Math.max(0, Math.min(at - 60, flat.length - SNIPPET_CHARS));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + SNIPPET_CHARS)}${start + SNIPPET_CHARS < flat.length ? '…' : ''}`;
}

/** Rank candidates against a query: more distinct words, then newer. */
export function rankHits(
  candidates: Candidate[],
  terms: string[],
  titles: Map<string, string>,
  limit: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const c of candidates) {
    const positions = terms.map((t) => matchAt(c.text, t)).filter((i) => i >= 0);
    if (positions.length === 0) continue;
    const flatAt = c.text.slice(0, Math.min(...positions)).replace(/\s+/g, ' ').length;
    hits.push({
      timestamp: c.timestamp,
      sessionId: c.sessionId,
      kind: c.kind,
      sender: c.sender,
      ...(titles.has(c.sessionId) ? { thread: titles.get(c.sessionId) } : {}),
      snippet: c.kind === 'record' ? c.text.trim() : snippetAround(c.text, flatAt),
      score: positions.length,
    });
  }
  hits.sort((a, b) => b.score - a.score || (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return hits.slice(0, limit);
}

function parseMessage(raw: string): { text: string; sender: string; ambient: boolean } {
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

/** The agent group to read: `--group` when given and allowed, else the caller's own. */
async function groupOf(args: Record<string, unknown>, ctx: CallerContext): Promise<string> {
  const asked = typeof args.group === 'string' && args.group ? args.group : undefined;
  if (ctx.caller === 'agent') {
    if (!asked || asked === ctx.agentGroupId) return ctx.agentGroupId;
    if (await mayReadAgentGroup(ctx, asked)) return asked;
    throw new Error(`agent group not found: ${asked}`);
  }
  if (asked) return asked;
  throw new Error('--group is required');
}

/**
 * The conversations a caller may read across: everything for the host; for
 * an agent, its own conversation and the group's shared (non-DM) ones.
 * Also names them, for record headers.
 */
async function readableConversations(
  agentGroupId: string,
  ctx: CallerContext,
): Promise<{ allows: (mgId: string | null) => boolean; names: Map<string, string> }> {
  const mgs = await getMessagingGroupsByAgentGroup(agentGroupId);
  const names = new Map(mgs.map((mg) => [mg.id, mg.is_group ? `#${mg.name || mg.platform_id}` : mg.name || 'DM']));
  if (ctx.caller !== 'agent') return { allows: () => true, names };
  const shared = new Set(mgs.filter((mg) => mg.is_group).map((mg) => mg.id));
  if (agentGroupId === ctx.agentGroupId) shared.add(ctx.messagingGroupId);
  return { allows: (mgId) => mgId !== null && shared.has(mgId), names };
}

export async function sessionSearch(args: Record<string, unknown>, ctx: CallerContext): Promise<SearchHit[]> {
  const query = typeof args.query === 'string' ? args.query : '';
  const terms = queryTerms(query);
  if (terms.length === 0) throw new Error('--query needs at least one word');
  const limitRaw = Number(args.limit ?? SEARCH_DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : SEARCH_DEFAULT_LIMIT;
  const agentGroupId = await groupOf(args, ctx);

  const readable = await readableConversations(agentGroupId, ctx);
  const records = (await listGroupThreadRecords(agentGroupId)).filter((r) => readable.allows(r.messaging_group_id));
  const titles = new Map(records.map((r) => [r.session_id, r.record.split('\n')[0].trim()]));
  const candidates: Candidate[] = records.map((r) => ({
    timestamp: r.updated_at,
    sessionId: r.session_id,
    kind: 'record',
    sender: 'thread record',
    text: r.record,
  }));

  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter((s) => readable.allows(s.messaging_group_id));
  const reads = await mapConcurrent(sessions, ECHO_CONCURRENCY, (session) =>
    withExistingMailboxSession(agentGroupId, session.id, (mailbox) => ({
      inbound: mailbox.getInboundHistory(SEARCH_SCAN_PER_SESSION),
      outbound: mailbox.getOutboundHistory(SEARCH_SCAN_PER_SESSION),
    })),
  );
  reads.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !result.value) return;
    const sessionId = sessions[i].id;
    for (const row of result.value.inbound) {
      if (row.kind !== 'chat' && row.kind !== 'chat-sdk') continue;
      const m = parseMessage(row.content);
      if (m.ambient || !m.text) continue;
      candidates.push({ timestamp: row.timestamp, sessionId, kind: 'message', sender: m.sender, text: m.text });
    }
    for (const row of result.value.outbound) {
      if (row.kind !== 'chat') continue;
      const m = parseMessage(row.content);
      if (!m.text) continue;
      candidates.push({ timestamp: row.timestamp, sessionId, kind: 'message', sender: 'you', text: m.text });
    }
  });

  return rankHits(candidates, terms, titles, limit);
}

/** Human rendering: one hit per block, newest-best first. */
export function formatSearchHits(hits: SearchHit[], timezone: string = TIMEZONE): string {
  if (hits.length === 0) return 'No matches.';
  return hits
    .map((h) => {
      const head = `${formatLocalStamp(new Date(h.timestamp), timezone)} · ${h.sessionId}${h.thread ? ` · ${h.thread}` : ''}`;
      return h.kind === 'record'
        ? `${head}\n[thread record]\n${h.snippet}`
        : `${head}\n${h.sender || 'unknown'}: ${h.snippet}`;
    })
    .join('\n\n');
}

/**
 * `ncl sessions records`: the records of the caller's conversation's threads.
 * With `--all`, every conversation the caller may read (see
 * readableConversations), each headed with its conversation's name.
 */
export async function sessionRecords(args: Record<string, unknown>, ctx: CallerContext): Promise<string> {
  if (args.all === true || args.all === 'true') {
    const agentGroupId = await groupOf(args, ctx);
    const readable = await readableConversations(agentGroupId, ctx);
    const ownSession = ctx.caller === 'agent' ? ctx.sessionId : undefined;
    const rows = (await listGroupThreadRecords(agentGroupId)).filter(
      (r) => r.session_id !== ownSession && readable.allows(r.messaging_group_id),
    );
    return (
      formatThreadRecords(rows, TIMEZONE, { maxChars: ALL_RECORDS_MAX_CHARS, conversationNames: readable.names }) ||
      'No thread records yet.'
    );
  }
  if (ctx.caller !== 'agent') {
    if (typeof args.group !== 'string' || typeof args.conversation !== 'string') {
      throw new Error('--group and --conversation (messaging group id) are required');
    }
  }
  const agentGroupId = ctx.caller === 'agent' ? ctx.agentGroupId : (args.group as string);
  const messagingGroupId = ctx.caller === 'agent' ? ctx.messagingGroupId : (args.conversation as string);
  const rows = await listThreadRecords(agentGroupId, messagingGroupId, {
    excludeSessionId: ctx.caller === 'agent' ? ctx.sessionId : undefined,
  });
  return formatThreadRecords(rows) || 'No thread records yet.';
}

export interface BackfillCandidate {
  sessionId: string;
  /** The conversation's name, e.g. "#website". */
  conversation: string;
  createdAt: string;
  /** Set for a rebuild: the existing record's updated_at, which the save must still find. */
  basedOn?: string;
}

/**
 * `ncl sessions backfill-candidates`: the threads the caller may read that
 * have no record yet, oldest first. The container's
 * `ncl sessions backfill-records` writes one for each.
 */
export async function sessionBackfillCandidates(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<BackfillCandidate[]> {
  const agentGroupId = await groupOf(args, ctx);
  const readable = await readableConversations(agentGroupId, ctx);
  const records = await listGroupThreadRecords(agentGroupId);
  const recorded = new Set(records.map((r) => r.session_id));
  // `--over <chars>`: also rebuild records at least that long (e.g. ones cut at the cap).
  // `--containing "<words>"`: also rebuild records containing any of them
  // (case-insensitive), e.g. spellings the instructions no longer use.
  const over = Number(args.over);
  const words =
    typeof args.containing === 'string'
      ? args.containing
          .toLocaleLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 0)
      : [];
  const due = (record: string): boolean =>
    (Number.isFinite(over) && over > 0 && record.length >= over) ||
    words.some((w) => record.toLocaleLowerCase().includes(w));
  const rebuild = new Map(records.filter((r) => due(r.record)).map((r) => [r.session_id, r.updated_at] as const));
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  return sessions
    .filter(
      (s) =>
        s.messaging_group_id && readable.allows(s.messaging_group_id) && (!recorded.has(s.id) || rebuild.has(s.id)),
    )
    .filter((s) => ctx.caller !== 'agent' || s.id !== ctx.sessionId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map((s) => ({
      sessionId: s.id,
      conversation: readable.names.get(s.messaging_group_id as string) ?? (s.messaging_group_id as string),
      createdAt: s.created_at,
      ...(rebuild.has(s.id) ? { basedOn: rebuild.get(s.id) } : {}),
    }));
}
