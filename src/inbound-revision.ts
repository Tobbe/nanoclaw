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
import type { InboundRevision } from './mailbox/types.js';
import { withExistingMailboxSession } from './session-manager.js';

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
      changed +=
        (await withExistingMailboxSession(wiring.agent_group_id, session.id, (mailbox) =>
          mailbox.reviseMessage(id, event.revision),
        )) ?? 0;
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
