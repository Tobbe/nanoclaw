/**
 * Edits and deletions of messages already stored.
 *
 * When someone edits or deletes a message on the platform, every stored copy
 * of it changes too: the copy in its thread's session and the copies shared
 * with other threads of the same agent group. A deleted message then reads as
 * gone everywhere — history, search, thread records — instead of staying an
 * open question nobody can see.
 */
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { TIMEZONE } from './config.js';
import type { InboundRevision, RevisedMessage } from './mailbox/types.js';
import { withExistingMailboxSession, writeSessionMessage } from './session-manager.js';
import { formatLocalStamp } from './timezone.js';

export interface InboundRevisionEvent {
  channelType: string;
  instance?: string;
  platformId: string;
  /** The platform's id for the message, as it arrived (Slack: its ts). */
  messageId: string;
  revision: InboundRevision;
}

/** Apply an edit or deletion to every stored copy. Returns the rows changed. */
export async function reviseInbound(event: InboundRevisionEvent): Promise<number> {
  const group = await getMessagingGroupByPlatform(event.channelType, event.platformId, event.instance);
  if (!group) return 0;
  let changed = 0;
  for (const wiring of await getMessagingGroupAgents(group.id)) {
    // Stored ids are namespaced by agent group (router messageIdForAgent).
    const id = `${event.messageId}:${wiring.agent_group_id}`;
    for (const session of await getSessionsByAgentGroup(wiring.agent_group_id)) {
      const result = await withExistingMailboxSession(wiring.agent_group_id, session.id, (mailbox) => {
        const revised = mailbox.reviseMessage(id, event.revision);
        const { original } = revised;
        // Already in the agent's conversation: handled, or claimed by a running turn.
        const received =
          !!original &&
          (original.status !== 'pending' || mailbox.getProcessingClaims().some((c) => c.messageId === id));
        return { rows: revised.rows, received: received ? original : null };
      });
      if (!result) continue;
      changed += result.rows;
      if (result.received) {
        await tellAgent(wiring.agent_group_id, session.id, event, result.received);
      }
    }
  }
  if (changed > 0) {
    log.info('Stored message revised', {
      channelType: event.channelType,
      platformId: event.platformId,
      messageId: event.messageId,
      kind: event.revision.kind,
      rows: changed,
    });
  }
  return changed;
}

/**
 * The note an agent gets when a message it already read changes. The agent
 * holds that message in its conversation, so changing the stored copy alone
 * leaves it answering from the old text. The note doesn't start a turn: it
 * arrives with the thread's next message. A deleted message's text is never
 * repeated.
 */
export function revisionNote(
  revision: InboundRevision,
  original: NonNullable<RevisedMessage['original']>,
  timezone: string,
): string {
  const who = original.sender ?? 'Someone';
  const when = formatLocalStamp(new Date(original.timestamp), timezone);
  if (revision.kind === 'deleted') {
    return `${who} deleted their message from ${when}. Treat it as withdrawn: don't act on it or bring it up.`;
  }
  return `${who} edited their message from ${when}. Go by this version from now on:\n${revision.text}`;
}

async function tellAgent(
  agentGroupId: string,
  sessionId: string,
  event: InboundRevisionEvent,
  original: NonNullable<RevisedMessage['original']>,
): Promise<void> {
  try {
    // Same shape as other system notes (room membership, container restart):
    // kind 'chat' from 'system' on the 'agent' channel, so it reaches the
    // agent but stays out of thread history and records.
    await writeSessionMessage(agentGroupId, sessionId, {
      id: `revision-${event.messageId}-${event.revision.kind}-${Date.now()}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: event.platformId,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: revisionNote(event.revision, original, TIMEZONE),
        sender: 'system',
        senderId: 'system',
      }),
      trigger: false,
    });
  } catch (err) {
    log.warn('Could not tell the agent about a revised message', { sessionId, messageId: event.messageId, err });
  }
}
