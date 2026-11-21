import { describe, expect, it } from 'bun:test';

import { backfill, chunkLines, recordFromTranscript, transcriptLines, type TranscriptRow } from './backfill.js';

const row = (timestamp: string, text: string, extra: Partial<TranscriptRow> = {}): TranscriptRow => ({
  timestamp,
  direction: 'in',
  kind: 'chat-sdk',
  sender: 'Lise',
  text,
  ...extra,
});

describe('transcriptLines', () => {
  it('keeps the thread’s own chat and drops ambient copies and system rows', () => {
    const lines = transcriptLines([
      row('2026-11-14T10:00:00.000Z', 'Gør knapperne runde'),
      row('2026-11-14T10:00:30.000Z', 'from another thread', { ambient: true }),
      row('2026-11-14T10:01:00.000Z', '[thread_record]', { kind: 'system', direction: 'out' }),
      row('2026-11-14T10:02:00.000Z', 'Done, PR #71', { kind: 'chat', direction: 'out', sender: 'CodeBot' }),
    ]);
    expect(lines).toEqual(['[2026-11-14 10:00] Lise: Gør knapperne runde', '[2026-11-14 10:02] you: Done, PR #71']);
  });
});

describe('chunkLines', () => {
  it('splits by size and keeps the start and end of a very long thread', () => {
    expect(chunkLines(['aaaa', 'bbbb', 'cccc'], 9)).toEqual(['aaaa\nbbbb', 'cccc']);
    const many = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, '0')}`);
    const chunks = chunkLines(many, 8);
    expect(chunks).toHaveLength(12);
    expect(chunks[0]).toBe('line 00');
    expect(chunks.at(-1)).toBe('line 29');
  });
});

describe('recordFromTranscript', () => {
  it('folds each part on top of the last and stamps the last message', async () => {
    const prompts: string[] = [];
    const result = await recordFromTranscript(
      [row('2026-11-14T10:00:00.000Z', 'x'.repeat(6_000)), row('2026-11-14T11:00:00.000Z', 'y'.repeat(6_000))],
      async (p) => {
        prompts.push(p);
        return `Record ${prompts.length}`;
      },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('<transcript part="1 of 2">');
    expect(prompts[1]).toContain('<record>\nRecord 1\n</record>');
    expect(result).toEqual({ record: 'Record 2', lastAt: '2026-11-14T11:00:00.000Z' });
  });

  it('returns null for a thread with no chat', async () => {
    expect(await recordFromTranscript([row('2026-11-14T10:00:00.000Z', 'x', { ambient: true })], async () => 'R')).toBeNull();
  });
});

describe('backfill', () => {
  it('writes a record per thread with chat, skips empty ones and carries on after a failure', async () => {
    const saved: string[] = [];
    const lines: string[] = [];
    const summary = await backfill({
      candidates: async () => [
        { sessionId: 's-a', conversation: '#website' },
        { sessionId: 's-empty', conversation: '#website' },
        { sessionId: 's-bad', conversation: '#website' },
      ],
      history: async (id) => {
        if (id === 's-bad') throw new Error('gateway down');
        return id === 's-empty' ? [] : [row('2026-11-14T10:00:00.000Z', 'hej')];
      },
      ask: async () => 'Buttons\n- Shape: rounder',
      save: async (id, record) => {
        saved.push(`${id}:${record.split('\n')[0]}`);
      },
      print: (l) => lines.push(l),
    });
    expect(saved).toEqual(['s-a:Buttons']);
    expect(summary).toBe('Done: 1 records written, 1 threads with no chat skipped, 1 failed.');
    expect(lines.some((l) => l.includes('✗ #website · s-bad: gateway down'))).toBe(true);
  });
});
