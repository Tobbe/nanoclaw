import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-inbound-revision' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { createSession } from './db/sessions.js';
import { reviseInbound } from './inbound-revision.js';
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

async function store(agentGroupId: string, sessionId: string, id: string, text: string): Promise<void> {
  await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    mailbox.insertMessage({
      id,
      kind: 'chat-sdk',
      timestamp: NOW,
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: 'slack:C1:T1',
      content: JSON.stringify({ text }),
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
      onWake: false,
    }),
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
