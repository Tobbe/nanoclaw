import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildRecordPrompt, cleanRecord, stripOtherThreads, ThreadRecorder } from './thread-record.js';

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
