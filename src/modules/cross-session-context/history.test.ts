/**
 * `ncl sessions history` handler tests: merge/format, limit, and — the
 * critical one — self-scoping (custom ops bypass the dispatcher's generic
 * scope filter, so cross-group agents must get "session not found" here).
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cross-session-history' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import type { CallerContext } from '../../cli/frame.js';
import { formatHistoryLines, HISTORY_TEXT_MAX_CHARS, sessionFile, sessionHistory } from './history.js';

const TEST_DIR = '/tmp/nanoclaw-test-cross-session-history';
const AG = 'ag-hist';
const SESS = 'sess-hist';

const HOST: CallerContext = { caller: 'host' };
const OWN_AGENT: CallerContext = { caller: 'agent', sessionId: 'sess-x', agentGroupId: AG, messagingGroupId: 'mg-x' };
const FOREIGN_AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 'sess-y',
  agentGroupId: 'ag-other',
  messagingGroupId: 'mg-y',
};

async function writeInbound(id: string, timestamp: string, text: string, sender = 'Alex'): Promise<void> {
  await writeSessionMessage(AG, SESS, {
    id,
    kind: 'chat',
    timestamp,
    platformId: 'D1',
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify({ text, sender, senderId: 'slack:U1' }),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Pixel',
    folder: 'pixel',
    agent_provider: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('sessionHistory', () => {
  it('merges inbound + outbound chronologically as structured rows (ISO timestamps)', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'hello there');
    await writeInbound('in-2', '2026-08-01T10:02:00.000Z', 'second message');
    // writeOutboundDirect stamps now() — always sorts after the fixed 2026 stamps.
    await writeOutboundDirect(AG, SESS, {
      id: 'out-1',
      kind: 'chat',
      platformId: 'D1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'agent reply' }),
    });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      timestamp: '2026-08-01T10:00:00.000Z',
      direction: 'in',
      kind: 'chat',
      sender: 'Alex',
      text: 'hello there',
    });
    expect(rows[1].text).toBe('second message');
    expect(rows[2].direction).toBe('out');
    expect(rows[2].kind).toBe('chat');
    expect(rows[2].sender).toBe('Pixel'); // agent group name as outbound sender
    expect(rows[2].text).toBe('agent reply');
  });

  it('formatHistoryLines renders pipe lines with localized stamps and capped cells', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'hello there');
    const lines = formatHistoryLines(await sessionHistory({ id: SESS }, HOST), 'UTC').split('\n');
    expect(lines).toEqual(['2026-08-01 10:00|in|chat|Alex|hello there']);
    // A non-UTC install timezone shifts the human stamp; data stays ISO.
    const berlin = formatHistoryLines(await sessionHistory({ id: SESS }, HOST), 'Europe/Berlin');
    expect(berlin.startsWith('2026-08-01 12:00|')).toBe(true);
  });

  it('keeps a long message whole in the human rendering, and marks one past the cap as cut', async () => {
    const long = `Kan du lægge den rigtige case op? ${'a'.repeat(600)}`;
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', long);
    await writeInbound('in-2', '2026-08-01T10:01:00.000Z', 'b'.repeat(HISTORY_TEXT_MAX_CHARS + 50));
    const lines = formatHistoryLines(await sessionHistory({ id: SESS }, HOST), 'UTC').split('\n');
    expect(lines[0].endsWith(long)).toBe(true);
    const cut = lines[1].split('|')[4];
    expect(cut).toHaveLength(HISTORY_TEXT_MAX_CHARS);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('shows only the conversation by default, everything with --all, and still fills --limit', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'Lise asks');
    await writeSessionMessage(AG, SESS, {
      id: 'echo-1',
      kind: 'chat',
      timestamp: '2026-08-01T10:01:00.000Z',
      platformId: null,
      channelType: 'session-echo',
      threadId: null,
      content: JSON.stringify({ text: 'copy of another thread', echo: { surface: 'x' } }),
    });
    for (let i = 0; i < 6; i++) {
      await writeOutboundDirect(AG, SESS, {
        id: `sys-${i}`,
        kind: 'system',
        platformId: 'D1',
        channelType: 'slack',
        threadId: null,
        content: JSON.stringify({ action: 'run_progress' }),
      });
    }
    await writeInbound('in-2', '2026-08-01T10:02:00.000Z', 'Lise again');

    const rows = await sessionHistory({ id: SESS, limit: 2 }, HOST);
    expect(rows.map((r) => r.text)).toEqual(['Lise asks', 'Lise again']);
    const all = await sessionHistory({ id: SESS, all: true }, HOST);
    expect(all.map((r) => r.kind)).toContain('system');
    expect(all.map((r) => r.text)).toContain('copy of another thread');
  });

  it('applies --limit keeping the NEWEST rows', async () => {
    for (let i = 0; i < 5; i++) {
      await writeInbound(`in-${i}`, `2026-08-01T10:0${i}:00.000Z`, `msg ${i}`);
    }
    const rows = await sessionHistory({ id: SESS, limit: 2 }, HOST);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('msg 3');
    expect(rows[1].text).toBe('msg 4');
  });

  it('sanitizes newlines and pipes in the human rendering only — rows keep the raw text', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'line one\nline two | with pipe');
    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows[0].text).toBe('line one\nline two | with pipe');
    const line = formatHistoryLines(rows, 'UTC');
    expect(line.split('\n')).toHaveLength(1);
    expect(line.endsWith('line one line two / with pipe')).toBe(true);
  });

  it('self-scopes: a cross-group agent gets "session not found", same as a bogus id', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'private');
    await expect(sessionHistory({ id: SESS }, FOREIGN_AGENT)).rejects.toThrow(`session not found: ${SESS}`);
    await expect(sessionHistory({ id: 'sess-nope' }, FOREIGN_AGENT)).rejects.toThrow('session not found: sess-nope');
    await expect(sessionHistory({ id: 'sess-nope' }, HOST)).rejects.toThrow('session not found: sess-nope');
  });

  it('allows the owning agent group and the host', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'visible');
    expect((await sessionHistory({ id: SESS }, OWN_AGENT))[0].text).toBe('visible');
    expect((await sessionHistory({ id: SESS }, HOST))[0].text).toBe('visible');
  });
});

describe('attachments and sessionFile', () => {
  // The thread the caller works in: a second session of the same group.
  const HERE = 'sess-here';
  const IN_THREAD: CallerContext = { caller: 'agent', sessionId: HERE, agentGroupId: AG, messagingGroupId: 'mg-x' };

  beforeEach(async () => {
    await createSession({
      id: HERE,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-08-01T00:00:00.000Z',
    });
    initSessionFolder(AG, HERE);
    // A message with an image, saved to the inbox the way inbound attachments are.
    await writeSessionMessage(AG, SESS, {
      id: '1794.001',
      kind: 'chat',
      timestamp: '2026-08-01T10:00:00.000Z',
      platformId: 'C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({
        text: 'see the first one',
        sender: 'Lise',
        attachments: [{ name: 'image.png', type: 'image', data: Buffer.from('PNGDATA').toString('base64') }],
      }),
    });
  });

  it("lists a message's files in history, outside the text cap", async () => {
    const rows = await sessionHistory({ id: SESS }, OWN_AGENT);
    expect(rows[0].attachments).toEqual(['inbox/1794.001/image.png']);
    expect(formatHistoryLines(rows, 'UTC')).toMatch(/\|see the first one \[file: inbox\/1794\.001\/image\.png\]$/);
  });

  it("copies a file from another session into the caller's, at the same path", async () => {
    const res = await sessionFile({ id: SESS, path: 'inbox/1794.001/image.png' }, IN_THREAD);
    expect(res).toEqual({ path: '/workspace/inbox/1794.001/image.png', bytes: 7 });
    const copied = `${TEST_DIR}/v2-sessions/${AG}/${HERE}/inbox/1794.001/image.png`;
    expect(fs.readFileSync(copied, 'utf8')).toBe('PNGDATA');
    // Fetching again is fine: the copy already there serves.
    await expect(sessionFile({ id: SESS, path: 'inbox/1794.001/image.png' }, IN_THREAD)).resolves.toMatchObject({
      bytes: 7,
    });
  });

  it("refuses another group's session, the host, and paths outside an inbox file", async () => {
    await expect(sessionFile({ id: SESS, path: 'inbox/1794.001/image.png' }, FOREIGN_AGENT)).rejects.toThrow(
      'session not found',
    );
    await expect(sessionFile({ id: SESS, path: 'inbox/1794.001/image.png' }, HOST)).rejects.toThrow('only an agent');
    for (const path of ['inbox/../inbound.db', 'outbox/x/y.png', 'inbox/1794.001', '/etc/passwd', 'inbox/a/b/c.png']) {
      await expect(sessionFile({ id: SESS, path }, IN_THREAD)).rejects.toThrow('path must be');
    }
    await expect(sessionFile({ id: SESS, path: 'inbox/1794.001/nope.png' }, IN_THREAD)).rejects.toThrow(
      'file not found',
    );
  });
});
