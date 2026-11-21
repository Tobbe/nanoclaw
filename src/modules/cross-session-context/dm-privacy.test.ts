import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-dm-privacy' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import type { CallerContext } from '../../cli/frame.js';
import type { Session } from '../../types.js';
import { privateDmEnvironment } from './dm-privacy.js';
import { sessionFile, sessionHistory } from './history.js';
import { sessionRecords } from './search.js';
import { saveThreadRecord } from './thread-records.js';

const TEST_DIR = '/tmp/nanoclaw-test-dm-privacy';
const TEAM = 'ag-team';
const SOLO = 'ag-solo';

const caller = (sessionId: string, mgId: string, ag = TEAM): CallerContext => ({
  caller: 'agent',
  sessionId,
  agentGroupId: ag,
  messagingGroupId: mgId,
});

async function conversation(id: string, isGroup: 0 | 1, ag: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await createMessagingGroup({
    id,
    channel_type: 'slack',
    platform_id: `slack:${id}`,
    name: id,
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: '2026-11-01T00:00:00.000Z',
  } as any);
  await createMessagingGroupAgent({
    id: `w-${id}`,
    messaging_group_id: id,
    agent_group_id: ag,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: '2026-11-01T00:00:00.000Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

async function thread(id: string, mgId: string, ag = TEAM): Promise<void> {
  await createSession({
    id,
    agent_group_id: ag,
    messaging_group_id: mgId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-11-01T00:00:00.000Z',
  });
  initSessionFolder(ag, id);
  await writeSessionMessage(ag, id, {
    id: `${id}-m1`,
    kind: 'chat',
    timestamp: '2026-11-14T10:00:00.000Z',
    platformId: mgId,
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify({ text: `said in ${id}`, sender: 'Lise', senderId: 'slack:U1' }),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  for (const id of [TEAM, SOLO]) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-11-01T00:00:00.000Z' });
  }
  await conversation('mg-website', 1, TEAM);
  await conversation('mg-dm-lise', 0, TEAM);
  await conversation('mg-dm-jacob', 0, TEAM);
  await conversation('mg-dm-tobbe', 0, SOLO);
  await thread('s-website', 'mg-website');
  await thread('s-lise', 'mg-dm-lise');
  await thread('s-tobbe', 'mg-dm-tobbe', SOLO);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('DM privacy', () => {
  it('lets only the DM itself open its history; the DM can still read the channel', async () => {
    await expect(sessionHistory({ id: 's-lise' }, caller('s-website', 'mg-website'))).rejects.toThrow(
      'session not found',
    );
    await expect(sessionHistory({ id: 's-lise' }, caller('s-j', 'mg-dm-jacob'))).rejects.toThrow('session not found');
    const own = await sessionHistory({ id: 's-lise' }, caller('s-lise2', 'mg-dm-lise'));
    expect(own.map((r) => r.text)).toContain('said in s-lise');
    const channel = await sessionHistory({ id: 's-website' }, caller('s-lise', 'mg-dm-lise'));
    expect(channel.map((r) => r.text)).toContain('said in s-website');
  });

  it('keeps another DM’s files out of reach', async () => {
    await expect(
      sessionFile({ id: 's-lise', path: 'inbox/x/a.png' }, caller('s-website', 'mg-website')),
    ).rejects.toThrow('session not found');
  });

  it('gives a team agent’s DMs a private archive and the discretion flag, and leaves the rest alone', async () => {
    const env = async (id: string) => privateDmEnvironment((await getSession(id)) as Session);
    expect(await env('s-lise')).toEqual({
      NANOCLAW_PRIVATE_DM: '1',
      NANOCLAW_CONVERSATIONS_DIR: '/workspace/conversations',
    });
    expect(await env('s-website')).toEqual({});
    // A personal agent with only a DM keeps its shared memory and archive.
    expect(await env('s-tobbe')).toEqual({});
  });
});

describe('a global-scope personal agent reading the team', () => {
  beforeEach(async () => {
    await ensureContainerConfig(SOLO);
    await updateContainerConfigScalars(SOLO, { cli_scope: 'global' });
    await ensureContainerConfig(TEAM);
    await saveThreadRecord((await getSession('s-website')) as Session, 'Buttons\n- Colour (farve): navy');
    await saveThreadRecord((await getSession('s-lise')) as Session, 'Lise private thread');
  });

  it('gets the team’s channel records and threads, never the team’s DMs', async () => {
    const me = caller('s-tobbe', 'mg-dm-tobbe', SOLO);
    const all = await sessionRecords({ all: true, group: TEAM }, me);
    expect(all).toContain('#mg-website · s-website]\nButtons');
    expect(all).not.toContain('Lise private');
    const rows = await sessionHistory({ id: 's-website' }, me);
    expect(rows.map((r) => r.text)).toContain('said in s-website');
    await expect(sessionHistory({ id: 's-lise' }, me)).rejects.toThrow('session not found');
  });

  it('refuses a group-scope agent naming another group', async () => {
    const teamThread = caller('s-website', 'mg-website');
    await expect(sessionRecords({ all: true, group: SOLO }, teamThread)).rejects.toThrow('agent group not found');
    await expect(sessionHistory({ id: 's-tobbe' }, teamThread)).rejects.toThrow('session not found');
  });
});
