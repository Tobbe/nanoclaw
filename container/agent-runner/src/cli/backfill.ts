/**
 * `ncl sessions backfill-records` — write thread records for threads that
 * have none: older threads from before records existed, so recall and new
 * threads can see them too.
 *
 * Like recall it runs in the container (the host has no model access): it
 * asks the host for the candidates, reads each transcript with
 * `ncl sessions history --json`, folds it into a record part by part with
 * the same instructions as live records, and hands each record to the host
 * as a `thread_record_backfill` system action. The host checks the thread is
 * readable from this session and never replaces an existing record.
 */
import { buildRecordPrompt, cleanRecord, transcriptLines, type TranscriptRow } from '../thread-record.js';

export { transcriptLines, type TranscriptRow };

export const BACKFILL_COMMAND = 'sessions-backfill-records';
export const BACKFILL_ACTION = 'thread_record_backfill';
/** Transcript characters per summarizer call (under the record prompt's turn cap). */
export const BACKFILL_CHUNK_CHARS = 10_000;
/** Parts folded per thread; longer threads keep their start and their end. */
export const BACKFILL_MAX_CHUNKS = 12;
export const BACKFILL_HISTORY_LIMIT = 2_000;
const CONCURRENCY = 3;

export interface Candidate {
  sessionId: string;
  conversation: string;
  /** A rebuild: the existing record's updated_at, passed back so a newer record is never replaced. */
  basedOn?: string;
}

/** Lines → parts of at most `max` characters (a longer single line is cut). */
export function chunkLines(lines: string[], max = BACKFILL_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
    if (current && current.length + line.length + 1 > max) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  if (chunks.length <= BACKFILL_MAX_CHUNKS) return chunks;
  const half = BACKFILL_MAX_CHUNKS / 2;
  return [...chunks.slice(0, half), ...chunks.slice(-half)];
}

/** Fold a whole transcript into one record. Null when the thread has no chat. */
export async function recordFromTranscript(
  rows: TranscriptRow[],
  ask: (prompt: string) => Promise<string>,
): Promise<{ record: string; lastAt: string } | null> {
  const own = rows.filter((r) => !r.ambient && (r.kind === 'chat' || r.kind === 'chat-sdk'));
  const chunks = chunkLines(transcriptLines(rows));
  if (chunks.length === 0) return null;
  let record: string | null = null;
  for (const [i, chunk] of chunks.entries()) {
    const part = `<transcript part="${i + 1} of ${chunks.length}">\n${chunk}\n</transcript>`;
    record = cleanRecord(await ask(buildRecordPrompt(record, part, null))) ?? record;
  }
  if (!record) return null;
  return { record, lastAt: own[own.length - 1]?.timestamp ?? new Date().toISOString() };
}

export interface BackfillDeps {
  candidates: () => Promise<Candidate[]>;
  history: (sessionId: string) => Promise<TranscriptRow[]>;
  ask: (prompt: string) => Promise<string>;
  save: (sessionId: string, record: string, lastAt: string, basedOn?: string) => Promise<void>;
  print: (line: string) => void;
}

/** Backfill every candidate, a few at a time. Returns the summary line. */
export async function backfill(deps: BackfillDeps): Promise<string> {
  const queue = await deps.candidates();
  const rebuilds = queue.filter((c) => c.basedOn).length;
  deps.print(`${queue.length - rebuilds} threads without a record, ${rebuilds} to rebuild.`);
  let written = 0;
  let empty = 0;
  let failed = 0;
  const work = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const result = await recordFromTranscript(await deps.history(c.sessionId), deps.ask);
        if (!result) {
          empty += 1;
          continue;
        }
        await deps.save(c.sessionId, result.record, result.lastAt, c.basedOn);
        written += 1;
        deps.print(`✓ ${c.conversation} · ${c.sessionId}: ${result.record.split('\n')[0]}`);
      } catch (err) {
        failed += 1;
        deps.print(`✗ ${c.conversation} · ${c.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  return `Done: ${written} records written, ${empty} threads with no chat skipped, ${failed} failed.`;
}
