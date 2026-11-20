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
 * Scoped like history: an agent searches only its own agent group.
 */
import { TIMEZONE } from '../../config.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import type { CallerContext } from '../../cli/frame.js';
import { ECHO_CONCURRENCY } from './config.js';
import { mapConcurrent } from './parallel.js';
import { formatThreadRecords, listGroupThreadRecords, listThreadRecords } from './thread-records.js';

export const SEARCH_DEFAULT_LIMIT = 15;
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

function groupOf(args: Record<string, unknown>, ctx: CallerContext): string {
  if (ctx.caller === 'agent') return ctx.agentGroupId;
  if (typeof args.group === 'string' && args.group) return args.group;
  throw new Error('--group is required');
}

export async function sessionSearch(args: Record<string, unknown>, ctx: CallerContext): Promise<SearchHit[]> {
  const query = typeof args.query === 'string' ? args.query : '';
  const terms = queryTerms(query);
  if (terms.length === 0) throw new Error('--query needs at least one word');
  const limitRaw = Number(args.limit ?? SEARCH_DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : SEARCH_DEFAULT_LIMIT;
  const agentGroupId = groupOf(args, ctx);

  const records = await listGroupThreadRecords(agentGroupId);
  const titles = new Map(records.map((r) => [r.session_id, r.record.split('\n')[0].trim()]));
  const candidates: Candidate[] = records.map((r) => ({
    timestamp: r.updated_at,
    sessionId: r.session_id,
    kind: 'record',
    sender: 'thread record',
    text: r.record,
  }));

  const sessions = await getSessionsByAgentGroup(agentGroupId);
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

/** `ncl sessions records`: the records of the caller's conversation's threads. */
export async function sessionRecords(args: Record<string, unknown>, ctx: CallerContext): Promise<string> {
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
