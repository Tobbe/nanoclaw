import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const written: Array<Record<string, unknown>> = [];
type HistoryRow = { seq?: number; timestamp: string; kind: string; content: string };
let histories: Record<string, { inbound: HistoryRow[]; outbound: HistoryRow[] }> = {};

vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (_g: string, sessionId: string, fn: (mailbox: unknown) => unknown) =>
    fn({
      insertMessage: async (msg: Record<string, unknown>) => {
        written.push({ sessionId, ...msg });
      },
      getInboundHistory: () => histories[sessionId]?.inbound ?? [],
      getOutboundHistory: () => histories[sessionId]?.outbound ?? [],
    }),
}));

const { closeDb, initTestDb } = await import('../../db/connection.js');
const { runMigrations } = await import('../../db/migrations/index.js');
const { createAgentGroup } = await import('../../db/agent-groups.js');
const { createMessagingGroup, createMessagingGroupAgent } = await import('../../db/messaging-groups.js');
const { createSession } = await import('../../db/sessions.js');
const records = await import('./thread-records.js');
const search = await import('./search.js');

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const agentGroup = {
  id: 'ag-1',
  name: 'CodeBot',
  folder: 'codebot',
  agent_provider: null,
  created_at: '2026-11-01T00:00:00.000Z',
};
const mg = {
  id: 'mg-web',
  channel_type: 'slack',
  platform_id: 'slack:CWEB',
  name: 'website',
  is_group: 1,
  unknown_sender_policy: 'strict',
  created_at: '2026-11-01T00:00:00.000Z',
};

function session(id: string, mgId: string | null = mg.id) {
  return {
    id,
    agent_group_id: agentGroup.id,
    messaging_group_id: mgId,
    thread_id: `slack:CWEB:${id}`,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-11-01T00:00:00.000Z',
  };
}

const chat = (timestamp: string, text: string, sender = 'Lise') => ({
  timestamp,
  kind: 'chat-sdk',
  content: JSON.stringify({ text, sender }),
});

beforeEach(async () => {
  written.length = 0;
  histories = {};
  await runMigrations(await initTestDb());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await createAgentGroup(agentGroup as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await createMessagingGroup(mg as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await createMessagingGroup({ ...mg, id: 'mg-dm', platform_id: 'slack:DTOBBE', is_group: 0 } as any);
  for (const mgId of [mg.id, 'mg-dm']) {
    await createMessagingGroupAgent({
      id: `w-${mgId}`,
      messaging_group_id: mgId,
      agent_group_id: agentGroup.id,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: '2026-11-01T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
  for (const s of [session('s-buttons'), session('s-legal'), session('s-new'), session('s-dm', 'mg-dm')]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createSession(s as any);
  }
});

afterEach(async () => {
  await closeDb();
});

const BUTTONS =
  'Buttons\n- Shape: rounder corners, PR #71 merged\n- Color (farve): navy default, orange only for problems (Lise)\nOpen: nothing';

describe('thread records', () => {
  it('keeps the newest record per session and lists a conversation newest first', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (id: string, mgId?: string) => session(id, mgId) as any;
    await records.saveThreadRecord(s('s-buttons'), 'Buttons\n- Shape: rounder', new Date(NOW - 3_600_000));
    await records.saveThreadRecord(s('s-buttons'), BUTTONS, new Date(NOW - 3_000_000));
    await records.saveThreadRecord(s('s-legal'), 'Legal documents\nOpen: Tobbe', new Date(NOW - 60_000));
    await records.saveThreadRecord(s('s-dm', 'mg-dm'), 'Private DM thread', new Date(NOW));
    const rows = await records.listThreadRecords(agentGroup.id, mg.id, { now: NOW });
    expect(rows.map((r) => r.session_id)).toEqual(['s-legal', 's-buttons']);
    expect(rows[1].record).toBe(BUTTONS);
  });

  it('drops records older than the limit, and refuses sessions with no conversation', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-buttons') as any, BUTTONS, new Date(NOW - 61 * 86_400_000));
    expect(await records.listThreadRecords(agentGroup.id, mg.id, { now: NOW })).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await records.saveThreadRecord(session('s-x', null) as any, BUTTONS)).toBe(false);
  });

  it('seeds a new thread with the other threads of its own conversation only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (id: string, mgId?: string) => session(id, mgId) as any;
    await records.saveThreadRecord(s('s-buttons'), BUTTONS, new Date(NOW - 3_000_000));
    await records.saveThreadRecord(s('s-dm', 'mg-dm'), 'Private DM thread', new Date(NOW));
    await records.saveThreadRecord(s('s-new'), 'Itself', new Date(NOW));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.seedThreadRecords(agentGroup as any, s('s-new'), mg as any, { created: true, now: NOW });
    expect(written).toHaveLength(1);
    const content = JSON.parse(written[0].content as string);
    expect(content.echo.surface).toBe('thread-records');
    expect(content.text).toContain('s-buttons]\nButtons');
    expect(content.text).not.toContain('Private DM');
    expect(content.text).not.toContain('Itself');
    expect(written[0].trigger).toBe(false);
  });

  it("shows a thread's messages after the record's cursor with it, as written", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-buttons') as any, BUTTONS, new Date(NOW), { inbound: 4, outbound: 3 });
    histories['s-buttons'] = {
      inbound: [
        { seq: 4, ...chat('2026-11-20T11:00:00.000Z', 'Covered already') },
        { seq: 6, ...chat('2026-11-20T11:30:00.000Z', 'Kan vi også\nfå grøn?') },
        {
          seq: 8,
          timestamp: '2026-11-20T11:31:00.000Z',
          kind: 'chat',
          content: JSON.stringify({ text: 'copy of another thread', echo: { surface: 'x' } }),
        },
      ],
      outbound: [
        { seq: 3, ...chat('2026-11-20T11:01:00.000Z', 'Covered reply') },
        {
          seq: 5,
          timestamp: '2026-11-20T11:35:00.000Z',
          kind: 'chat',
          content: JSON.stringify({ text: 'Ja, PR #72' }),
        },
      ],
    };
    const shown = await records.withNewerMessages(await records.listThreadRecords(agentGroup.id, mg.id), 'UTC');
    const text = records.formatThreadRecords(shown, 'UTC');
    expect(text).toContain(`${BUTTONS}\n\nSince this record:\n`);
    expect(text).toMatch(/Lise: Kan vi også få grøn\?\n.*you: Ja, PR #72$/);
    expect(text).not.toContain('Covered');
    expect(text).not.toContain('copy of another thread');
  });

  it('goes by the time written for a record from before cursors, and keeps the newest', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-buttons') as any, BUTTONS, new Date('2026-11-20T10:00:00.000Z'));
    histories['s-buttons'] = {
      inbound: [
        chat('2026-11-20T09:59:00.000Z', 'Before the record'),
        ...Array.from({ length: 12 }, (_, i) => chat(`2026-11-20T11:${String(10 + i)}:00.000Z`, `After ${i + 1}`)),
      ],
      outbound: [],
    };
    const [row] = await records.withNewerMessages(await records.listThreadRecords(agentGroup.id, mg.id), 'UTC');
    expect(row.newer?.lines).toHaveLength(records.NEWER_MESSAGES_MAX);
    expect(row.newer?.more).toBe(2);
    expect(row.newer?.lines[0]).toContain('After 3');
    expect(records.formatThreadRecords([row], 'UTC')).toContain(
      'Since this record (the newest 10; 2 earlier in `ncl sessions history s-buttons`):',
    );
  });

  it('shows a record alone when nothing came after it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-buttons') as any, BUTTONS, new Date(NOW), { inbound: 4, outbound: 3 });
    histories['s-buttons'] = { inbound: [{ seq: 4, ...chat('2026-11-20T11:00:00.000Z', 'Covered') }], outbound: [] };
    const shown = await records.withNewerMessages(await records.listThreadRecords(agentGroup.id, mg.id), 'UTC');
    expect(records.formatThreadRecords(shown, 'UTC')).not.toContain('Since this record');
  });

  it("reads the runner's cursor, and ignores a malformed one", () => {
    expect(records.parseCovered({ inbound: 4, outbound: 3 })).toEqual({ inbound: 4, outbound: 3 });
    expect(records.parseCovered({ inbound: '4', outbound: 3 })).toBeNull();
    expect(records.parseCovered(undefined)).toBeNull();
  });

  it('leaves an existing thread alone', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-buttons') as any, BUTTONS, new Date(NOW));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.seedThreadRecords(agentGroup as any, session('s-new') as any, mg as any, { created: false });
    expect(written).toHaveLength(0);
  });
});

describe('ncl sessions search', () => {
  const agent = { caller: 'agent' as const, sessionId: 's-new', agentGroupId: agentGroup.id, messagingGroupId: mg.id };

  it('finds a finished thread by its record and by word starts in its messages', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-buttons') as any, BUTTONS, new Date(NOW - 3_000_000));
    histories['s-buttons'] = {
      inbound: [
        chat('2026-11-14T10:00:00.000Z', 'Kan knapperne få andre farver? Navy som standard'),
        // An ambient copy of another thread is not this thread's own message.
        {
          timestamp: '2026-11-14T09:00:00.000Z',
          kind: 'chat',
          content: JSON.stringify({ text: 'farver fra en anden tråd', echo: { surface: 'channel-timeline' } }),
        },
      ],
      outbound: [{ timestamp: '2026-11-14T10:01:00.000Z', kind: 'chat', content: JSON.stringify({ text: 'Done.' }) }],
    };
    histories['s-legal'] = { inbound: [chat('2026-11-15T10:00:00.000Z', 'Legal documents, any news?')], outbound: [] };

    const hits = await search.sessionSearch({ query: 'farve navy' }, agent);
    // Same score: the record, touched later, ranks first.
    expect(hits.map((h) => [h.kind, h.sessionId, h.score])).toEqual([
      ['record', 's-buttons', 2],
      ['message', 's-buttons', 2],
    ]);
    expect(hits[1].thread).toBe('Buttons');
    expect(hits[1].snippet).toContain('farver');
    expect(search.formatSearchHits(hits, 'UTC')).toContain('s-buttons · Buttons\nLise: Kan knapperne');
  });

  it('matches word starts only, and needs a word to look for', async () => {
    histories['s-buttons'] = { inbound: [chat('2026-11-14T10:00:00.000Z', 'decolor the page')], outbound: [] };
    expect(await search.sessionSearch({ query: 'color' }, agent)).toEqual([]);
    await expect(search.sessionSearch({ query: ' ' }, agent)).rejects.toThrow('at least one word');
  });

  it('keeps other people’s DMs out of an agent’s search and records --all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (id: string, mgId?: string) => session(id, mgId) as any;
    await records.saveThreadRecord(s('s-buttons'), BUTTONS, new Date(NOW - 3_000_000));
    await records.saveThreadRecord(s('s-dm', 'mg-dm'), 'Private DM thread about buttons', new Date(NOW));
    histories['s-dm'] = { inbound: [chat('2026-11-15T10:00:00.000Z', 'buttons in private')], outbound: [] };

    const hits = await search.sessionSearch({ query: 'buttons' }, agent);
    expect(hits.map((h) => h.sessionId)).toEqual(['s-buttons']);
    const all = await search.sessionRecords({ all: true }, agent);
    expect(all).toContain('#website · s-buttons]\nButtons');
    expect(all).not.toContain('Private DM');

    // The DM's own thread still sees its own conversation, and the channels.
    const fromDm = { ...agent, sessionId: 's-dm2', messagingGroupId: 'mg-dm' };
    const dmAll = await search.sessionRecords({ all: true }, fromDm);
    expect(dmAll).toContain('Private DM');
    expect(dmAll).toContain('Buttons');
  });

  it('--since keeps the threads active since then: updated, or with newer messages', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (id: string) => session(id) as any;
    await records.saveThreadRecord(s('s-buttons'), BUTTONS, new Date('2026-11-21T09:00:00.000Z'));
    await records.saveThreadRecord(s('s-legal'), 'Legal documents', new Date('2026-11-17T09:00:00.000Z'));
    await records.saveThreadRecord(s('s-new'), 'Old case thread', new Date('2026-11-17T09:00:00.000Z'));
    histories['s-new'] = { inbound: [chat('2026-11-20T15:00:00.000Z', 'Casen er lagt op')], outbound: [] };

    const text = await search.sessionRecords({ all: true, since: '2026-11-20' }, { ...agent, sessionId: 's-other' });
    expect(text).toContain('Buttons');
    expect(text).toContain('Old case thread');
    expect(text).toContain('Casen er lagt op');
    expect(text).not.toContain('Legal documents');
    expect(await search.sessionRecords({ all: true, since: '2026-11-22T00:00:00Z' }, agent)).toBe(
      'No thread records since 2026-11-22T00:00:00Z.',
    );
    await expect(search.sessionRecords({ all: true, since: 'Friday' }, agent)).rejects.toThrow('not a date');
  });

  it('starts a bare --since date early enough for any time zone', () => {
    expect(search.parseSince('2026-11-20')).toBe('2026-11-19T12:00:00.000Z');
    expect(search.parseSince('2026-11-20T08:00:00Z')).toBe('2026-11-20T08:00:00.000Z');
    expect(search.parseSince(undefined)).toBeNull();
  });

  it('lists the records of the caller’s conversation without its own', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-buttons') as any, BUTTONS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await records.saveThreadRecord(session('s-new') as any, 'Itself');
    const text = await search.sessionRecords({}, agent);
    expect(text).toContain('Buttons');
    expect(text).not.toContain('Itself');
  });
});
