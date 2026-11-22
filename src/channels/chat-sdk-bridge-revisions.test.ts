/**
 * Edits and deletions reach the host through the real Chat SDK dispatch:
 * a stub adapter captures the ChatInstance and pushes update/delete events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import type { InboundRevision } from '../mailbox/types.js';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface ChatDriver {
  processMessageUpdated(event: Record<string, unknown>): Promise<void>;
  processMessageDeleted(event: Record<string, unknown>): Promise<void>;
}

function stubAdapter(): { adapter: Adapter; chat: () => ChatDriver } {
  let captured: ChatDriver | null = null;
  const adapter = {
    name: 'slack',
    initialize: async (chat: ChatDriver) => {
      captured = chat;
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
  } as unknown as Adapter;
  return { adapter, chat: () => captured! };
}

function message(id: string, text: string, isMe = false): Record<string, unknown> {
  const payload = { id, text, author: { userId: 'U1', userName: 'lise', fullName: 'Lise', isBot: false, isMe } };
  return {
    ...payload,
    attachments: [],
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
    raw: undefined,
    toJSON: () => ({ ...payload }),
  };
}

function host(): { setup: ChannelSetup; revised: Array<[string, string, InboundRevision]> } {
  const revised: Array<[string, string, InboundRevision]> = [];
  return {
    revised,
    setup: {
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
      onInboundRevised: (platformId, messageId, revision) => {
        revised.push([platformId, messageId, revision]);
      },
    },
  };
}

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

describe('message edits and deletions', () => {
  it('passes an edit and a deletion to the host with the message id it arrived with', async () => {
    const { adapter, chat } = stubAdapter();
    const { setup, revised } = host();
    await createChatSdkBridge({ adapter, supportsThreads: true }).setup(setup);

    await chat().processMessageUpdated({
      adapter,
      threadId: 'slack:C1:T1',
      message: message('111.1', 'Runde knapper'),
    });
    await chat().processMessageDeleted({
      adapter,
      threadId: 'slack:C1:T1',
      channelId: 'C1',
      messageId: '111.2',
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(revised).toEqual([
      ['slack:C1', '111.1', { kind: 'edited', text: 'Runde knapper', at: expect.any(String) }],
      ['slack:C1', '111.2', { kind: 'deleted', at: '2026-01-02T00:00:00.000Z' }],
    ]);
  });

  it("skips the bot's own messages", async () => {
    const { adapter, chat } = stubAdapter();
    const { setup, revised } = host();
    await createChatSdkBridge({ adapter, supportsThreads: true }).setup(setup);

    await chat().processMessageUpdated({
      adapter,
      threadId: 'slack:C1:T1',
      message: message('222.1', 'Working…', true),
    });
    await chat().processMessageDeleted({
      adapter,
      threadId: 'slack:C1:T1',
      channelId: 'C1',
      messageId: '222.2',
      previousMessage: message('222.2', 'card', true),
    });

    expect(revised).toEqual([]);
  });
});
