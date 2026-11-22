import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-inbound-revision' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { createSession } from './db/sessions.js';
import { reviseInbound, revisionNote } from './inbound-revision.js';
import { initSessionFolder, withExistingMailboxSession } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-inbound-revision';
const NOW = new Date().toISOString();

async function addSession(id: string, agentGroupId: string, mgId: string): Promise<void> {
  await createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: mgId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: NOW,
    created_at: NOW,
  });
  initSessionFolder(agentGroupId, id);
}

async function store(
  agentGroupId: string,
  sessionId: string,
  id: string,
  text: string,
  status = 'pending',
): Promise<void> {
  await withExistingMailboxSession(agentGroupId, sessionId, async (mailbox) => {
    await mailbox.insertMessage({
      id,
      kind: 'chat-sdk',
      timestamp: NOW,
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: 'slack:C1:T1',
      content: JSON.stringify({ text, sender: 'Lise' }),
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
      onWake: false,
    });
    if (status !== 'pending') mailbox.markMessageFailed(id); // any non-pending status: already handed over
  });
}

/** System notes written for the agent. */
async function notes(agentGroupId: string, sessionId: string): Promise<string[]> {
  return (
    (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
      mailbox
        .getInboundHistory(20)
        .map((m) => JSON.parse(m.content) as { text: string; sender?: string })
        .filter((c) => c.sender === 'system')
        .map((c) => c.text),
    )) ?? []
  );
}

async function texts(agentGroupId: string, sessionId: string): Promise<string[]> {
  return (
    (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
      mailbox.getInboundHistory(10).map((m) => JSON.parse(m.content).text as string),
    )) ?? []
  );
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  for (const id of ['ag-1', 'ag-2']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: NOW });
  }
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    instance: 'slack',
    name: 'website',
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: NOW,
  });
  for (const ag of ['ag-1', 'ag-2']) {
    await createMessagingGroupAgent({
      id: `mga-${ag}`,
      messaging_group_id: 'mg-1',
      agent_group_id: ag,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: NOW,
    });
  }
  await addSession('s-thread', 'ag-1', 'mg-1');
  await addSession('s-other', 'ag-1', 'mg-1');
  await addSession('s-ag2', 'ag-2', 'mg-1');
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reviseInbound', () => {
  it('deletes the message in its thread, in copies shared with other threads, and for every wired agent', async () => {
    await store('ag-1', 's-thread', '111.1:ag-1', 'call list');
    await store('ag-1', 's-other', '111.1:ag-1:echo:s-other', 'call list');
    await store('ag-1', 's-other', '222.2:ag-1', 'kept');
    await store('ag-2', 's-ag2', '111.1:ag-2', 'call list');

    const changed = await reviseInbound({
      channelType: 'slack',
      instance: 'slack',
      platformId: 'slack:C1',
      messageId: '111.1',
      revision: { kind: 'deleted', at: NOW },
    });

    expect(changed).toBe(3);
    expect(await texts('ag-1', 's-thread')).toEqual([]);
    expect(await texts('ag-1', 's-other')).toEqual(['kept']);
    expect(await texts('ag-2', 's-ag2')).toEqual([]);
  });

  it('tells the agent when a message it already read is edited, in that thread only', async () => {
    await store('ag-1', 's-thread', '111.1:ag-1', 'version 1', 'handled');
    await store('ag-1', 's-other', '111.1:ag-1:echo:s-other', 'version 1');

    await reviseInbound({
      channelType: 'slack',
      platformId: 'slack:C1',
      messageId: '111.1',
      revision: { kind: 'edited', text: 'version 11', at: NOW },
    });

    expect(await texts('ag-1', 's-thread')).toContain('version 11');
    const [note] = await notes('ag-1', 's-thread');
    expect(note).toMatch(/^Lise edited their message from .+\. Go by this version from now on:\nversion 11$/);
    expect(await notes('ag-1', 's-other')).toEqual([]);
  });

  it("tells the agent about a deletion without repeating the text, but not when it hadn't read it yet", async () => {
    await store('ag-1', 's-thread', '111.1:ag-1', 'call list', 'handled');
    await store('ag-1', 's-other', '222.2:ag-1', 'not read yet');

    for (const messageId of ['111.1', '222.2']) {
      await reviseInbound({
        channelType: 'slack',
        platformId: 'slack:C1',
        messageId,
        revision: { kind: 'deleted', at: NOW },
      });
    }

    const [note] = await notes('ag-1', 's-thread');
    expect(note).toMatch(/^Lise deleted their message from .+\. Treat it as withdrawn/);
    expect(note).not.toContain('call list');
    expect(await notes('ag-1', 's-other')).toEqual([]);
  });

  it('changes nothing for a channel no agent is wired to', async () => {
    expect(
      await reviseInbound({
        channelType: 'slack',
        platformId: 'slack:C9',
        messageId: '111.1',
        revision: { kind: 'deleted', at: NOW },
      }),
    ).toBe(0);
  });
});

describe('revisionNote', () => {
  it('names the sender and the local time of the original message', () => {
    const original = { status: 'completed', timestamp: '2026-11-20T11:01:51.000Z', sender: 'Lise' };
    expect(revisionNote({ kind: 'deleted', at: NOW }, original, 'Europe/Copenhagen')).toBe(
      "Lise deleted their message from 2026-11-20 12:01. Treat it as withdrawn: don't act on it or bring it up.",
    );
    expect(revisionNote({ kind: 'edited', text: 'v2', at: NOW }, { ...original, sender: null }, 'UTC')).toBe(
      'Someone edited their message from 2026-11-20 11:01. Go by this version from now on:\nv2',
    );
  });
});
