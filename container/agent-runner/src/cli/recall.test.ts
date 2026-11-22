import { describe, expect, it } from 'bun:test';

import { buildRecallPrompt, recall } from './recall.js';

const RECORDS =
  '[2026-11-14 11:00 · #website · s-buttons]\nButtons\n- Color (farve): navy default, orange only for problems';

describe('recall', () => {
  it('hands the question and every record to the model and prints its pick', async () => {
    let seen = '';
    const text = await recall('hvad sagde vi om farverne?', {
      fetchRecords: async () => RECORDS,
      ask: async (prompt) => {
        seen = prompt;
        return '[2026-11-14 11:00 · #website · s-buttons]\n- Color (farve): navy default';
      },
    });
    expect(seen).toBe(buildRecallPrompt('hvad sagde vi om farverne?', RECORDS));
    expect(seen).toContain('<question>\nhvad sagde vi om farverne?\n</question>');
    expect(seen).toContain(RECORDS);
    expect(text).toStartWith('[2026-11-14 11:00 · #website · s-buttons]');
    expect(text).toContain('ncl sessions history <session id>');
    expect(text).toContain('These are summaries, not the answer.');
  });

  it('asks for the threads that settle a topic too, and their newer messages', () => {
    const prompt = buildRecallPrompt('is the real case up?', RECORDS);
    expect(prompt).toContain('not only the one where it was raised');
    expect(prompt).toContain('"Since this record" lines');
  });

  it('skips the model when there are no records, and says so when nothing matches', async () => {
    let asked = false;
    const none = await recall('x', {
      fetchRecords: async () => 'No thread records yet.',
      ask: async () => {
        asked = true;
        return '';
      },
    });
    expect(none).toBe('No thread records yet.');
    expect(asked).toBe(false);
    const miss = await recall('x', { fetchRecords: async () => RECORDS, ask: async () => 'NONE' });
    expect(miss).toContain('No thread record bears on that');
  });

  it("passes the host's 'none since' answer through without asking the model", async () => {
    const text = await recall('what is open?', {
      fetchRecords: async () => 'No thread records since 2026-11-20.',
      ask: async () => {
        throw new Error('not called');
      },
    });
    expect(text).toBe('No thread records since 2026-11-20.');
  });

  it('needs a question', async () => {
    await expect(recall(' ', { fetchRecords: async () => RECORDS, ask: async () => '' })).rejects.toThrow('--question');
  });
});
