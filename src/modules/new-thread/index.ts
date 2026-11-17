/**
 * New threads an agent starts.
 *
 * `send_message` with `new_thread: true` posts a top-level message in a group
 * channel instead of replying in the current thread (the container sends it
 * with no thread and `newThread: true` in the content). Posting alone would
 * leave a thread nobody follows: under mention-sticky, replies wake the agent
 * only in threads it has a session for. So once the opener is delivered, this
 * hook follows the thread the way an @mention would:
 *
 *   1. subscribes the adapter to it (the platform's subscribed-message path),
 *   2. creates the thread's session, so mention-sticky engages on the first
 *      reply without an @mention (an empty inbox counts as active),
 *   3. writes the opener and the agent's handoff note into that session as
 *      trigger=0 context rows. They never wake a container and don't count as
 *      chatter; the agent reads them with the first reply.
 *
 * Only for a group chat the agent is wired to with threads on, on a platform
 * whose adapter can name the thread a top-level message opens
 * (`threadIdForMessage`). Otherwise the message is still posted, just not
 * followed. Never throws: it runs as a post-delivery hook.
 */
import { getChannelAdapter, getChannelDefaults } from '../../channels/channel-registry.js';
import { resolveThreadPolicy } from '../../channels/channel-defaults.js';
import {
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  getMessagingGroupForOwnDestination,
} from '../../db/messaging-groups.js';
import { registerPostDeliveryHook, type PostDeliveryInfo } from '../../delivery.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { resolveSession, withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE, echoRowId } from '../cross-session-context/index.js';

/** echo.surface for the opener: the thread's own first message, posted by the agent. */
export const THREAD_OPENER_SURFACE = 'channel-timeline';
/** echo.surface for the agent's note to itself (formatter renders <thread-handoff>). */
export const THREAD_HANDOFF_SURFACE = 'thread-handoff';

interface NewThreadContent {
  text?: unknown;
  newThread?: unknown;
  handoff?: unknown;
}

export async function followNewThread(
  msg: OutboundMessage,
  origin: Session,
  info: PostDeliveryInfo,
): Promise<string | null> {
  let content: NewThreadContent;
  try {
    content = JSON.parse(msg.content) as NewThreadContent;
  } catch {
    return null;
  }
  if (content.newThread !== true) return null;
  if (msg.threadId !== null || !msg.channelType || !msg.platformId || !info.platformMessageId) return null;

  const mg =
    (await getMessagingGroupForOwnDestination(origin.agent_group_id, msg.channelType, msg.platformId)) ??
    (await getMessagingGroupByPlatform(msg.channelType, msg.platformId));
  if (!mg || mg.is_group !== 1) return null;
  const wiring = await getMessagingGroupAgentByPair(mg.id, origin.agent_group_id);
  if (!wiring) return null;

  const adapterKey = mg.instance ?? mg.channel_type;
  const adapter = getChannelAdapter(adapterKey);
  const threadId = adapter?.threadIdForMessage?.(msg.platformId, info.platformMessageId);
  if (!adapter || !threadId) {
    log.info('new thread posted but not followed: the platform does not open threads from a post', {
      channelType: msg.channelType,
      messageId: msg.id,
    });
    return null;
  }
  const threadsOn = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(adapterKey, mg.channel_type),
    true,
    adapter.supportsThreads === true,
  );
  if (!threadsOn) return null;

  await adapter.subscribe?.(msg.platformId, threadId);
  // agent-shared: every thread already lands in the one shared session.
  if (wiring.session_mode === 'agent-shared') return threadId;

  const { session } = await resolveSession(origin.agent_group_id, mg.id, threadId, 'per-thread');
  const timestamp = new Date().toISOString();
  const label = mg.name ? `#${mg.name}` : 'the channel';
  const rows: Array<{ id: string; text: string; surface: string }> = [
    // Same id the outbound echo fan would use for this message, so a fan that
    // races in first leaves one copy, not two.
    { id: echoRowId(msg.id, session.id), text: String(content.text ?? ''), surface: THREAD_OPENER_SURFACE },
  ];
  const handoff = typeof content.handoff === 'string' ? content.handoff.trim() : '';
  rows.push({
    id: `${msg.id}:handoff:${session.id}`,
    text:
      `You started this thread in ${label} from another thread there` +
      (origin.thread_id ? ` (${origin.thread_id})` : '') +
      `. \`ncl sessions history ${origin.id}\` shows that conversation.` +
      (handoff ? `\n\n${handoff}` : ''),
    surface: THREAD_HANDOFF_SURFACE,
  });

  await withExistingMailboxSession(origin.agent_group_id, session.id, async (mailbox) => {
    for (const row of rows) {
      try {
        await mailbox.insertMessage({
          id: row.id,
          kind: 'chat',
          timestamp,
          platformId: msg.platformId,
          channelType: ECHO_CHANNEL_TYPE,
          threadId: null,
          content: JSON.stringify({ echo: { surface: row.surface, label }, self: true, text: row.text }),
          processAfter: null,
          recurrence: null,
          trigger: false,
          sourceSessionId: origin.id,
          onWake: false,
        });
      } catch (err) {
        // A duplicate id: the echo fan already wrote the opener.
        if (!String(err).includes('UNIQUE')) throw err;
      }
    }
  });

  log.info('Following a new thread the agent started', {
    agentGroupId: origin.agent_group_id,
    originSessionId: origin.id,
    sessionId: session.id,
    threadId,
  });
  return threadId;
}

registerPostDeliveryHook(async (msg, session, info) => {
  try {
    await followNewThread(msg, session, info);
  } catch (err) {
    log.warn('Could not follow a new thread the agent started', { messageId: msg.id, sessionId: session.id, err });
  }
});
