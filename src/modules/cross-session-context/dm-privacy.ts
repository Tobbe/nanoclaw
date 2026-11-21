/**
 * DM privacy inside an agent group that also serves shared conversations.
 *
 * An agent group's sessions share memory, workspace and history tools, so a
 * DM wired to a team agent would otherwise be readable from every channel
 * thread. These rules make a DM as private as telling a colleague:
 *   - other threads can't open its transcript or files (`ncl sessions
 *     history` / `file`), nor find it via records, recall or search
 *     (search.ts);
 *   - its conversation archives go to the session's own folder instead of
 *     the shared `conversations/`;
 *   - the agent is told to keep what is said there out of channels, other
 *     DMs and shared memory (NANOCLAW_PRIVATE_DM, read by the runner).
 * An agent group with only DMs (a personal agent) is left as it was.
 */
import { getMessagingGroup, getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import type { Session } from '../../types.js';

/** Archive location for a private DM: the session folder, not the group's. */
export const PRIVATE_DM_CONVERSATIONS_DIR = '/workspace/conversations';

/** Whether `target` is a DM other than the caller's own conversation. */
export async function isOtherConversationsDm(
  target: Pick<Session, 'messaging_group_id'>,
  callerMessagingGroupId: string,
): Promise<boolean> {
  if (!target.messaging_group_id || target.messaging_group_id === callerMessagingGroupId) return false;
  const mg = await getMessagingGroup(target.messaging_group_id);
  return mg?.is_group === 0;
}

/** Env for a session's container: set only for a DM of an agent that also serves shared conversations. */
export async function privateDmEnvironment(session: Session): Promise<Record<string, string>> {
  if (!session.messaging_group_id) return {};
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg || mg.is_group !== 0) return {};
  const wired = await getMessagingGroupsByAgentGroup(session.agent_group_id);
  if (!wired.some((w) => w.is_group === 1)) return {};
  return { NANOCLAW_PRIVATE_DM: '1', NANOCLAW_CONVERSATIONS_DIR: PRIVATE_DM_CONVERSATIONS_DIR };
}
