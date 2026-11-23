import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-failure-alerts' };
});
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { _resetDeliveryStateForTesting, deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import { initSessionFolder, withExistingMailboxSession } from '../../session-manager.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { deleteUserDm, upsertUserDm } from '../permissions/db/user-dms.js';
import { createUser } from '../permissions/db/users.js';
import { openOutboundDbRw } from '../../mailbox/sqlite/session-db.js';
import { sessionMailboxPath } from '../../mailbox/sqlite/paths.js';
import { ALERT_PREFIX, alertQuestion, handleAlertResponse } from './index.js';
import { getAlert } from './store.js';

const TEST_DIR = '/tmp/nanoclaw-test-failure-alerts';
const NOW = new Date().toISOString();
const AG = 'ag-team';

interface Delivered {
  platformId: string;
  threadId: string | null;
  content: Record<string, unknown>;
}
let delivered: Delivered[] = [];

async function addSession(id: string): Promise<void> {
  await createSession({
    id,
    agent_group_id: AG,
    messaging_group_id: 'mg-website',
    thread_id: `slack:C1:${id}`,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: NOW,
    created_at: NOW,
  });
  initSessionFolder(AG, id);
}

async function storeInbound(sessionId: string, platformMsgId: string, text: string): Promise<string> {
  const id = `${platformMsgId}:${AG}`;
  await withExistingMailboxSession(AG, sessionId, async (mailbox) => {
    await mailbox.insertMessage({
      id,
      kind: 'chat-sdk',
      timestamp: NOW,
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: `slack:C1:${sessionId}`,
      content: JSON.stringify({ text, senderName: 'Lise Engelbrecht', sender: 'Lise Engelbrecht' }),
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
      onWake: false,
    });
    mailbox.markMessageFailed(id); // handed over, as after a failed run
  });
  return id;
}

let outSeq = 1;
/** What the container writes when a run fails. */
function writeFailureNotice(sessionId: string, inReplyTo: string): void {
  const db = openOutboundDbRw(sessionMailboxPath({ agentGroupId: AG, sessionId }, 'outbound'));
  db.prepare(
    `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, ?, ?, 'chat', 'slack:C1', 'slack', ?, ?)`,
  ).run(
    `out-${outSeq}`,
    outSeq,
    inReplyTo,
    NOW,
    `slack:C1:${sessionId}`,
    JSON.stringify({ text: 'Sorry, something went wrong and I couldn’t answer.', failureNotice: true }),
  );
  outSeq += 2;
  db.close();
}

async function deliver(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  await deliverSessionMessages(session!);
}

async function inboundRows(sessionId: string): Promise<Array<{ id: string; content: string }>> {
  return (
    (await withExistingMailboxSession(AG, sessionId, (mailbox) =>
      mailbox.getInboundHistory(20).map((m) => ({ id: '', content: m.content })),
    )) ?? []
  );
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  _resetDeliveryStateForTesting();
  delivered = [];
  vi.mocked(requestWake).mockClear();
  setDeliveryAdapter({
    deliver: async (_channelType, platformId, threadId, _kind, content) => {
      delivered.push({ platformId, threadId, content: JSON.parse(content) as Record<string, unknown> });
      return `p-${delivered.length}`;
    },
  });
  await createAgentGroup({ id: AG, name: 'CodeBot Team', folder: 'team', agent_provider: null, created_at: NOW });
  for (const [id, platformId, name, isGroup] of [
    ['mg-website', 'slack:C1', 'website', 1],
    ['mg-dm', 'slack:D1', null, 0],
  ] as const) {
    await createMessagingGroup({
      id,
      channel_type: 'slack',
      platform_id: platformId,
      instance: 'slack',
      name,
      is_group: isGroup,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: NOW,
    });
  }
  await createUser({ id: 'slack:UOWNER', kind: 'slack', display_name: 'Tobbe', created_at: NOW });
  await grantRole({ user_id: 'slack:UOWNER', role: 'owner', agent_group_id: null, granted_by: null, granted_at: NOW });
  await upsertUserDm({ user_id: 'slack:UOWNER', channel_type: 'slack', messaging_group_id: 'mg-dm', resolved_at: NOW });
  await addSession('sess-a');
  await addSession('sess-b');
});

afterEach(async () => {
  await closeDb();
});

describe('failure alerts', () => {
  it('DMs the owner instead of posting in the thread', async () => {
    const id = await storeInbound('sess-a', '111.1', '@Tobbe thanks, lets go with 6px');
    writeFailureNotice('sess-a', id);
    await deliver('sess-a');

    expect(delivered).toHaveLength(1);
    expect(delivered[0].platformId).toBe('slack:D1');
    expect(delivered[0].threadId).toBeNull();
    const card = delivered[0].content;
    expect(card.type).toBe('ask_question');
    expect(String(card.questionId)).toMatch(new RegExp(`^${ALERT_PREFIX}`));
    expect(card.title).toBe("⚠️ CodeBot Team couldn't answer");
    expect(card.question).toContain("Lise Engelbrecht's message in #website");
    expect(card.question).toContain('@Tobbe thanks, lets go with 6px');
    expect((card.options as Array<{ label: string }>).map((o) => o.label)).toEqual(['Retry', 'Dismiss']);
  });

  it('groups failures in one thread, but not across threads', async () => {
    const first = await storeInbound('sess-a', '111.1', 'first');
    const second = await storeInbound('sess-a', '111.2', 'second');
    const other = await storeInbound('sess-b', '222.1', 'other thread');
    writeFailureNotice('sess-a', first);
    await deliver('sess-a');
    writeFailureNotice('sess-a', second);
    await deliver('sess-a');
    writeFailureNotice('sess-b', other);
    await deliver('sess-b');

    expect(delivered).toHaveLength(2);
    const alert = await getAlert(String(delivered[0].content.questionId));
    expect(JSON.parse(alert!.message_ids)).toEqual([first, second]);
  });

  it('Retry re-sends every grouped message with a note, and wakes the agent', async () => {
    const first = await storeInbound('sess-a', '111.1', 'first');
    const second = await storeInbound('sess-a', '111.2', 'second');
    writeFailureNotice('sess-a', first);
    await deliver('sess-a');
    writeFailureNotice('sess-a', second);
    await deliver('sess-a');
    const questionId = String(delivered[0].content.questionId);

    const claimed = await handleAlertResponse({
      questionId,
      value: 'retry',
      userId: 'UOWNER',
      channelType: 'slack',
      platformId: 'slack:D1',
      threadId: null,
    });
    expect(claimed).toBe(true);

    const history = await inboundRows('sess-a');
    const texts = history.map((r) => JSON.parse(r.content).text as string);
    expect(texts.filter((t) => t === 'first')).toHaveLength(2);
    expect(texts.filter((t) => t === 'second')).toHaveLength(2);
    expect(texts.some((t) => t.includes('the next 2 messages are sent again'))).toBe(true);
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect((await getAlert(questionId))!.resolution).toBe('retry');

    // A second click does nothing more.
    await handleAlertResponse({
      questionId,
      value: 'retry',
      userId: 'UOWNER',
      channelType: 'slack',
      platformId: 'slack:D1',
      threadId: null,
    });
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('a new failure after Dismiss sends a new DM', async () => {
    const first = await storeInbound('sess-a', '111.1', 'first');
    writeFailureNotice('sess-a', first);
    await deliver('sess-a');
    await handleAlertResponse({
      questionId: String(delivered[0].content.questionId),
      value: 'dismiss',
      userId: 'UOWNER',
      channelType: 'slack',
      platformId: 'slack:D1',
      threadId: null,
    });
    const second = await storeInbound('sess-a', '111.2', 'second');
    writeFailureNotice('sess-a', second);
    await deliver('sess-a');
    expect(delivered).toHaveLength(2);
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('ignores a click from anyone but the owner it was sent to', async () => {
    const first = await storeInbound('sess-a', '111.1', 'first');
    writeFailureNotice('sess-a', first);
    await deliver('sess-a');
    const questionId = String(delivered[0].content.questionId);
    await handleAlertResponse({
      questionId,
      value: 'retry',
      userId: 'USOMEONE',
      channelType: 'slack',
      platformId: 'slack:D1',
      threadId: null,
    });
    expect(requestWake).not.toHaveBeenCalled();
    expect((await getAlert(questionId))!.resolved_at).toBeNull();
  });

  it('posts in the thread when no owner can be reached', async () => {
    await deleteUserDm('slack:UOWNER', 'slack');
    const first = await storeInbound('sess-a', '111.1', 'first');
    writeFailureNotice('sess-a', first);
    await deliver('sess-a');
    // ensureUserDm can't resolve a DM without an adapter, so the notice goes to the thread.
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:C1']);
    expect(delivered[0].content.failureNotice).toBe(true);
  });

  it('writes a short body with the link when there is one', () => {
    const q = alertQuestion({
      sender: 'Lise',
      where: '#website',
      text: 'x'.repeat(500),
      link: 'https://example.slack.com/archives/C1/p1',
      notice: 'Sorry',
    });
    expect(q).toContain('https://example.slack.com/archives/C1/p1');
    expect(q).toContain(`“${'x'.repeat(199)}…”`);
  });
});
