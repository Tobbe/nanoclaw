import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildRecordPrompt,
  chatTranscript,
  cleanRecord,
  stripOtherThreads,
  ThreadRecorder,
  type TranscriptRow,
} from './thread-record.js';
import type { ChatCursor, InboundMessage, OutboundMessage } from './mailbox/types.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thread-record-')), 'record.md');

describe('stripOtherThreads', () => {
  it('drops copies of other threads but keeps this one', () => {
    const prompt = [
      '<cross-session-context from="#website room">Lise: other thread</cross-session-context>',
      '<channel-threads>- Buttons: …</channel-threads>',
      '<message sender="Lise">Gør knapperne runde</message>',
    ].join('\n');
    expect(stripOtherThreads(prompt)).toBe('<message sender="Lise">Gør knapperne runde</message>');
  });
});

describe('buildRecordPrompt', () => {
  it('carries the previous record and the turn', () => {
    const p = buildRecordPrompt('Buttons\n- Shape: rounder', '<message>farve?</message>', 'Navy.');
    expect(p).toContain('<record>\nButtons\n- Shape: rounder\n</record>');
    expect(p).toContain('<message>farve?</message>');
    expect(p).toContain('<assistant-reply>\nNavy.\n</assistant-reply>');
  });

  it('says when there is no record yet', () => {
    expect(buildRecordPrompt(null, 'x', null)).toContain('first turn');
  });
});

describe('cleanRecord', () => {
  it('unwraps fences and record tags, and rejects an empty reply', () => {
    expect(cleanRecord('```\nTitle\n- A: b\n```')).toBe('Title\n- A: b');
    expect(cleanRecord('<record>\nTitle\n</record>')).toBe('Title');
    expect(cleanRecord('  ')).toBeNull();
  });

  it('cuts an over-long record at a line end', () => {
    const long = `Title\n- A: ${'a'.repeat(1_500)}\n- B: ${'b'.repeat(1_000)}`;
    expect(cleanRecord(long)).toBe(`Title\n- A: ${'a'.repeat(1_500)}`);
  });
});

describe('RECORD_INSTRUCTIONS', () => {
  it('keeps detours, undecided topics and both-language key words, and squeezes finished topics', async () => {
    const { RECORD_INSTRUCTIONS } = await import('./thread-record.js');
    expect(RECORD_INSTRUCTIONS).toContain('also a short detour');
    expect(RECORD_INSTRUCTIONS).toContain('no decision');
    expect(RECORD_INSTRUCTIONS).toContain('Color (farve)');
    expect(RECORD_INSTRUCTIONS).toContain('American English');
    expect(RECORD_INSTRUCTIONS).toContain('Shorten, never drop.');
  });
});

describe('ThreadRecorder', () => {
  it('folds turns in order, each on top of the last record, and sends it', async () => {
    const file = tmpFile();
    const seen: string[] = [];
    const sent: string[] = [];
    const recorder = new ThreadRecorder({
      recordFile: file,
      summarize: async (prompt) => {
        seen.push(prompt);
        return `Record after ${seen.length}`;
      },
      send: async (record) => {
        sent.push(record);
      },
      log: () => {},
    });
    void recorder.note('turn one', 'reply one');
    await recorder.note('turn two', 'reply two');
    expect(sent).toEqual(['Record after 1', 'Record after 2']);
    expect(seen[1]).toContain('<record>\nRecord after 1\n</record>');
    expect(recorder.current()).toBe('Record after 2');
  });

  it('keeps the old record when an update fails, and carries on', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'Old record\n');
    const logs: string[] = [];
    let calls = 0;
    const recorder = new ThreadRecorder({
      recordFile: file,
      summarize: async () => {
        calls += 1;
        if (calls === 1) throw new Error('gateway down');
        return 'New record';
      },
      send: async () => {},
      log: (m) => logs.push(m),
    });
    await recorder.note('a', 'b');
    expect(recorder.current()).toBe('Old record');
    expect(logs[0]).toContain('gateway down');
    await recorder.note('c', 'd');
    expect(recorder.current()).toBe('New record');
  });
});

const inMsg = (sequence: number, text: string, extra: Partial<InboundMessage> = {}): InboundMessage =>
  ({
    sequence,
    kind: 'chat',
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    channelType: 'slack',
    content: JSON.stringify({ text, sender: 'Lise' }),
    ...extra,
  }) as InboundMessage;
const outMsg = (sequence: number, text: string): OutboundMessage =>
  ({
    sequence,
    kind: 'chat',
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    content: JSON.stringify({ text }),
  }) as OutboundMessage;

describe('chatTranscript', () => {
  it("keeps this thread's chat in time order and moves the cursor past copies from elsewhere", () => {
    const { rows, through } = chatTranscript(
      {
        inbound: [
          inMsg(2, 'Rundere knapper?'),
          inMsg(4, 'other thread', { content: JSON.stringify({ text: 'x', echo: { surface: 's' } }) }),
          inMsg(6, 'from an agent', { channelType: 'agent' }),
        ],
        outbound: [outMsg(3, 'Done, PR #12')],
      },
      { inbound: 0, outbound: 1 },
    );
    expect(rows.map((r) => [r.direction, r.text, !!r.ambient])).toEqual([
      ['in', 'Rundere knapper?', false],
      ['out', 'Done, PR #12', false],
      ['in', 'x', true],
    ]);
    expect(through).toEqual({ inbound: 6, outbound: 3 });
  });
});

describe('ThreadRecorder reading stored messages', () => {
  const row = (sequence: number, text: string): TranscriptRow => ({
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    direction: 'in',
    kind: 'chat',
    sender: 'Lise',
    text,
  });
  /** A fake mailbox: messages 1..n, read after a cursor. */
  const mailbox = (texts: string[]) => {
    const reads: ChatCursor[] = [];
    return {
      texts,
      reads,
      readChat: (after: ChatCursor) => {
        reads.push(after);
        const rows = texts.map((t, i) => row(i + 1, t)).filter((_, i) => i + 1 > after.inbound);
        return { rows, through: { inbound: texts.length, outbound: 0 } };
      },
    };
  };

  it('folds the messages after the cursor, and sends the cursor with the record', async () => {
    const box = mailbox(['Rundere knapper?', 'Og grøn?']);
    const prompts: string[] = [];
    const sent: Array<[string, ChatCursor | null]> = [];
    const recorder = new ThreadRecorder({
      recordFile: tmpFile(),
      summarize: async (p) => {
        prompts.push(p);
        return `Record ${prompts.length}`;
      },
      send: async (record, covered) => {
        sent.push([record, covered]);
      },
      readChat: box.readChat,
      log: () => {},
    });
    await recorder.note('turn prompt', 'reply');
    expect(prompts[0]).toContain('Lise: Rundere knapper?');
    expect(prompts[0]).toContain('Lise: Og grøn?');
    expect(prompts[0]).not.toContain('turn prompt');
    expect(sent).toEqual([['Record 1', { inbound: 2, outbound: 0 }]]);

    box.texts.push('Ja, navy');
    await recorder.note('turn 2', 'reply 2');
    expect(box.reads[1]).toEqual({ inbound: 2, outbound: 0 });
    expect(prompts[1]).toContain('Lise: Ja, navy');
    expect(prompts[1]).not.toContain('Rundere knapper?');

    await recorder.note('turn 3', 'reply 3');
    expect(prompts).toHaveLength(2);
  });

  it('keeps the cursor when an update fails, so the next one folds the missed messages too', async () => {
    const box = mailbox(['Kan vi få runde hjørner?']);
    const prompts: string[] = [];
    let calls = 0;
    const recorder = new ThreadRecorder({
      recordFile: tmpFile(),
      summarize: async (p) => {
        calls += 1;
        prompts.push(p);
        if (calls === 1) throw new Error('gateway down');
        return 'Record';
      },
      send: async () => {},
      readChat: box.readChat,
      log: () => {},
    });
    await recorder.note('t1', 'r1');
    expect(recorder.cursor()).toBeNull();
    box.texts.push('Hallo?');
    await recorder.note('t2', 'r2');
    expect(prompts[1]).toContain('Kan vi få runde hjørner?');
    expect(prompts[1]).toContain('Hallo?');
    expect(recorder.cursor()).toEqual({ inbound: 2, outbound: 0 });
  });

  it('folds the turn once for a record from before cursors, then starts counting', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'Old record\n');
    const box = mailbox(['old message', 'new message']);
    const prompts: string[] = [];
    const recorder = new ThreadRecorder({
      recordFile: file,
      summarize: async (p) => {
        prompts.push(p);
        return 'Record';
      },
      send: async () => {},
      readChat: box.readChat,
      log: () => {},
    });
    await recorder.note('<message>new message</message>', 'reply');
    expect(prompts[0]).toContain('<message>new message</message>');
    expect(prompts[0]).not.toContain('old message');
    expect(recorder.cursor()).toEqual({ inbound: 2, outbound: 0 });
  });
});

describe('modelEnvironment', () => {
  it('fills what a Bash-run command lacks from the container env, and keeps what it has', async () => {
    const { containerEnvironment, modelEnvironment } = await import('./thread-record.js');
    const file = tmpFile();
    fs.writeFileSync(file, 'ANTHROPIC_AUTH_TOKEN=gateway-managed\0ANTHROPIC_BASE_URL=http://gw\0TZ=UTC\0');
    const container = containerEnvironment(file);
    expect(container.ANTHROPIC_AUTH_TOKEN).toBe('gateway-managed');
    const env = modelEnvironment({ ANTHROPIC_BASE_URL: 'http://own', ANTHROPIC_AUTH_TOKEN: '' }, container);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gateway-managed');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://own');
    expect(containerEnvironment('/nonexistent')).toEqual({});
  });
});
