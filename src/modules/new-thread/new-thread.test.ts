/**
 * Following a new thread the agent started (send_message new_thread).
 *
 * Drives followNewThread against an in-memory central DB and real session
 * folders, with a fake channel adapter.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-new-thread' };
});

const subscribe = vi.fn(async () => {});
let threadIdForMessage: ((platformId: string, messageId: string) => string | undefined) | undefined;
vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({ name: 'slack', supportsThreads: true, subscribe, threadIdForMessage }),
  getChannelDefaults: () => ({ dm: { threads: false }, group: { threads: true }, mentions: 'platform' }),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { createSession, findSessionForAgent } from '../../db/sessions.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import type { MessagingGroupAgent, Session } from '../../types.js';
import { followNewThread } from './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-new-thread';
const AG = 'ag-1';
const NOW = new Date().toISOString();

const ORIGIN: Session = {
  id: 's-origin',
  agent_group_id: AG,
  messaging_group_id: 'mg-web',
  thread_id: 'slack:C1:111.000',
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: NOW,
  created_at: NOW,
};

function wiring(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: 'w-1',
    messaging_group_id: 'mg-web',
    agent_group_id: AG,
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    threads: null,
    created_at: NOW,
    ...overrides,
  } as MessagingGroupAgent;
}

function opener(content: Record<string, unknown>, threadId: string | null = null): OutboundMessage {
  return {
    id: 'out-1',
    kind: 'chat',
    platformId: 'slack:C1',
    channelType: 'slack',
    threadId,
    content: JSON.stringify(content),
    inReplyTo: null,
  } as OutboundMessage;
}

function rows(sessionId: string): Array<{ trigger: number; channel_type: string; content: Record<string, unknown> }> {
  const db = new Database(inboundDbPath(AG, sessionId), { readonly: true });
  try {
    return (
      db.prepare('SELECT trigger, channel_type, content FROM messages_in ORDER BY seq').all() as Array<{
        trigger: number;
        channel_type: string;
        content: string;
      }>
    ).map((r) => ({ ...r, content: JSON.parse(r.content) as Record<string, unknown> }));
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'CodeBot', folder: 'codebot', agent_provider: null, created_at: NOW });
  await createMessagingGroup({
    id: 'mg-web',
    channel_type: 'slack',
    platform_id: 'slack:C1',
    instance: 'slack',
    name: 'website',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: NOW,
  });
  await createSession(ORIGIN);
  initSessionFolder(AG, ORIGIN.id);
  subscribe.mockClear();
  threadIdForMessage = (platformId, messageId) => `${platformId}:${messageId}`;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('followNewThread', () => {
  it('subscribes, creates the thread session, and seeds the opener and handoff as silent context', async () => {
    await createMessagingGroupAgent(wiring());

    const threadId = await followNewThread(
      opener({ text: 'Logo strip: new PR', newThread: true, handoff: 'Owns PR #25.' }),
      ORIGIN,
      { firstDelivery: false, platformMessageId: '222.000' },
    );

    expect(threadId).toBe('slack:C1:222.000');
    expect(subscribe).toHaveBeenCalledWith('slack:C1', 'slack:C1:222.000');
    const session = await findSessionForAgent(AG, 'mg-web', 'slack:C1:222.000');
    expect(session).toBeDefined();

    const seeded = rows(session!.id);
    expect(seeded).toHaveLength(2);
    expect(seeded.every((r) => r.trigger === 0 && r.channel_type === 'session-echo')).toBe(true);
    expect(seeded[0].content).toMatchObject({
      self: true,
      text: 'Logo strip: new PR',
      echo: { surface: 'channel-timeline' },
    });
    expect(seeded[1].content.echo).toMatchObject({ surface: 'thread-handoff', label: '#website' });
    expect(seeded[1].content.text).toContain('ncl sessions history s-origin');
    expect(seeded[1].content.text).toContain('ncl sessions file s-origin --path');
    expect(seeded[1].content.text).toContain('Owns PR #25.');
  });

  it('also gives the thread session the details posted inside the thread', async () => {
    await createMessagingGroupAgent(wiring());
    await followNewThread(
      opener({
        text: 'Three tagline ideas',
        newThread: true,
        threadReply: '1. A\n2. B',
        handoff: 'Taglines for Tobbe.',
      }),
      ORIGIN,
      { firstDelivery: false, platformMessageId: '777.000' },
    );
    const session = await findSessionForAgent(AG, 'mg-web', 'slack:C1:777.000');
    const seeded = rows(session!.id);
    expect(seeded.map((r) => r.content.text)).toEqual([
      'Three tagline ideas',
      '1. A\n2. B',
      expect.stringContaining('Taglines for Tobbe.'),
    ]);
  });

  it('ignores ordinary replies', async () => {
    await createMessagingGroupAgent(wiring());
    expect(
      await followNewThread(opener({ text: 'hi' }, 'slack:C1:111.000'), ORIGIN, {
        firstDelivery: false,
        platformMessageId: '333.000',
      }),
    ).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("posts without following when the platform can't name the thread", async () => {
    await createMessagingGroupAgent(wiring());
    threadIdForMessage = () => undefined;
    expect(
      await followNewThread(opener({ text: 'x', newThread: true }), ORIGIN, {
        firstDelivery: false,
        platformMessageId: '444.000',
      }),
    ).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('does not follow in a channel the agent is not wired to', async () => {
    expect(
      await followNewThread(opener({ text: 'x', newThread: true }), ORIGIN, {
        firstDelivery: false,
        platformMessageId: '555.000',
      }),
    ).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('only subscribes when the wiring shares one session across threads', async () => {
    await createMessagingGroupAgent(wiring({ session_mode: 'agent-shared' }));
    expect(
      await followNewThread(opener({ text: 'x', newThread: true }), ORIGIN, {
        firstDelivery: false,
        platformMessageId: '666.000',
      }),
    ).toBe('slack:C1:666.000');
    expect(subscribe).toHaveBeenCalledOnce();
    expect(await findSessionForAgent(AG, 'mg-web', 'slack:C1:666.000')).toBeUndefined();
  });
});
