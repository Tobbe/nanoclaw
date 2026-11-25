/**
 * Router typing indicator on an always-on wiring (pattern "."): every message
 * wakes the agent, but "typing" shows at once only for messages meant for it:
 * a mention, or a follow-up in a thread it has already replied in where
 * nobody else is talking. Everything else holds it until the agent starts
 * working. Other wirings keep showing it for every engaged message.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring).
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-typing' };
});

vi.mock('./modules/typing/index.js', () => ({
  startTypingRefresh: vi.fn(),
  holdTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
  pauseTypingRefreshAfterDelivery: vi.fn(),
  setTypingAdapter: vi.fn(),
}));

// Whether the session has replied in its thread. The real outbox needs a
// delivered message; the router only asks hasThreadReply().
let repliedInThread = false;
vi.mock('./session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('./session-manager.js')>('./session-manager.js');
  return {
    ...actual,
    withExistingMailboxSession: ((agentGroupId, sessionId, fn) =>
      actual.withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
        fn({ ...mailbox, hasThreadReply: () => repliedInThread }),
      )) as typeof actual.withExistingMailboxSession,
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-router-typing';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

async function activate(): Promise<void> {
  const adapter: ChannelAdapter = {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
  registerChannelAdapter('testchat', { factory: () => adapter, defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedWiring(engageMode: MessagingGroupAgent['engage_mode'], engagePattern: string | null): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'Bot', folder: 'bot', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'website',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(
  id: string,
  threadId: string,
  opts: { isMention?: boolean; addressedElsewhere?: boolean; text?: string; from?: [string, string] } = {},
): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({
        sender: (opts.from ?? ['Lise', 'U1'])[0],
        senderId: (opts.from ?? ['Lise', 'U1'])[1],
        text: opts.text ?? 'hej',
      }),
      timestamp: now(),
      isMention: opts.isMention ?? false,
      addressedElsewhere: opts.addressedElsewhere,
      isGroup: true,
    },
  });
}

async function typingCalls(): Promise<number> {
  const { startTypingRefresh } = await import('./modules/typing/index.js');
  return vi.mocked(startTypingRefresh).mock.calls.length;
}

async function heldCalls(): Promise<number> {
  const { holdTypingRefresh } = await import('./modules/typing/index.js');
  return vi.mocked(holdTypingRefresh).mock.calls.length;
}

beforeEach(async () => {
  repliedInThread = false;
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('typing on an always-on wiring', () => {
  it('wakes on chatter and holds typing', async () => {
    await activate();
    await seedWiring('pattern', '.');
    const { wakeContainer } = await import('./container-runner.js');

    await inbound('m1', 'testchat:C1:100');
    expect(vi.mocked(wakeContainer)).toHaveBeenCalled();
    expect(await typingCalls()).toBe(0);
    expect(await heldCalls()).toBe(1);
  });

  it('shows typing for a mention', async () => {
    await activate();
    await seedWiring('pattern', '.');

    await inbound('m1', 'testchat:C1:100', { isMention: true });
    expect(await typingCalls()).toBe(1);
  });

  it('shows typing in a thread the agent has replied in, unless addressed to someone else', async () => {
    await activate();
    await seedWiring('pattern', '.');

    await inbound('m1', 'testchat:C1:100', { isMention: true });
    repliedInThread = true;
    await inbound('m2', 'testchat:C1:100');
    expect(await typingCalls()).toBe(2);

    await inbound('m3', 'testchat:C1:100', { addressedElsewhere: true });
    expect(await typingCalls()).toBe(2);
    expect(await heldCalls()).toBe(1);
  });

  it('holds typing in a replied thread once two people are talking, unless mentioned', async () => {
    await activate();
    await seedWiring('pattern', '.');

    await inbound('m1', 'testchat:C1:100', { isMention: true });
    repliedInThread = true;
    await inbound('m2', 'testchat:C1:100', { from: ['Tobbe', 'U2'] });
    expect(await typingCalls()).toBe(1);
    expect(await heldCalls()).toBe(1);

    await inbound('m3', 'testchat:C1:100', { isMention: true, from: ['Tobbe', 'U2'] });
    expect(await typingCalls()).toBe(2);
  });

  it('counts only people in this thread', async () => {
    await activate();
    await seedWiring('pattern', '.');

    await inbound('m1', 'testchat:C1:200', { from: ['Tobbe', 'U2'] });
    await inbound('m2', 'testchat:C1:100', { isMention: true });
    repliedInThread = true;
    await inbound('m3', 'testchat:C1:100');
    expect(await typingCalls()).toBe(2);
  });

  it('keeps typing for every engaged message on other wirings', async () => {
    await activate();
    await seedWiring('pattern', 'CodeBot');

    await inbound('m1', 'testchat:C1:100', { text: 'CodeBot, hej' });
    expect(await typingCalls()).toBe(1);
  });
});
