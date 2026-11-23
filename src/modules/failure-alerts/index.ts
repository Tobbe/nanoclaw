/**
 * Failure alerts: when an agent run fails, the owner gets a DM instead of a
 * notice in the chat. The DM says whose message failed, links to it, and has
 * a Retry button that sends the message to the agent again.
 *
 * Grouping: one DM per thread (session). Failures in a thread that already
 * has an open alert from the last ten minutes join it, and Retry re-sends
 * all of them. Once Retry or Dismiss is clicked, the next failure sends a new DM.
 *
 * If no owner can be reached, the notice is posted in the chat as before.
 */
import type { RawOption } from '../../channels/ask-question.js';
import { normalizeOptions } from '../../channels/ask-question.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { registerQuestionRenderResolver } from '../../channels/question-render-registry.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter, registerFailureNoticeHandler, type FailureNotice } from '../../delivery.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import type { StoredInboundMessage } from '../../mailbox/types.js';
import { namespacedUserId } from '../approvals/response-handler.js';
import { pickApprovalDelivery } from '../approvals/primitive.js';
import { getOwners } from '../permissions/db/user-roles.js';
import {
  alertMessageIds,
  createAlert,
  getAlert,
  getOpenAlert,
  resolveAlert,
  setAlertMessages,
  type FailureAlertRow,
} from './store.js';

export const ALERT_PREFIX = 'failalert-';
export const GROUP_WINDOW_MS = 10 * 60 * 1000;
const EXCERPT_CHARS = 200;

export const ALERT_OPTIONS: RawOption[] = [
  { label: 'Retry', selectedLabel: '🔁 Retried', value: 'retry', style: 'primary' },
  { label: 'Dismiss', selectedLabel: 'Dismissed', value: 'dismiss' },
];

interface MessageSummary {
  sender: string;
  text: string;
  deleted: boolean;
}

function summarize(row: StoredInboundMessage | undefined): MessageSummary | null {
  if (!row) return null;
  try {
    const content = JSON.parse(row.content) as Record<string, unknown>;
    const sender = [content.senderName, content.sender].find((v): v is string => typeof v === 'string' && v !== '');
    return {
      sender: sender ?? 'someone',
      text: typeof content.text === 'string' ? content.text : '',
      deleted: content.deleted !== undefined && content.deleted !== null,
    };
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

/** The platform message id inside an inbound row id (`<platform id>:<agent group id>`). */
function platformMessageId(rowId: string, agentGroupId: string): string | null {
  const suffix = `:${agentGroupId}`;
  return rowId.endsWith(suffix) ? rowId.slice(0, -suffix.length) : null;
}

/** The DM's body. Exported for tests. */
export function alertQuestion(opts: {
  sender: string;
  where: string;
  text: string;
  link: string | null;
  notice: string;
}): string {
  const lines = [`A run failed on ${opts.sender}'s message in ${opts.where}:`, `“${excerpt(opts.text)}”`];
  if (opts.link) lines.push(opts.link);
  lines.push('', `Notice: ${excerpt(opts.notice)}`);
  lines.push(
    '',
    'Nothing was posted in the thread. Retry sends the message to the agent again. ' +
      'Further failures in this thread in the next 10 minutes are added to this alert.',
  );
  return lines.join('\n');
}

async function handleFailureNotice(notice: FailureNotice, session: Session): Promise<boolean> {
  const messageId = notice.inReplyTo;
  if (!messageId || !session.messaging_group_id) return false;

  const now = Date.now();
  const open = await getOpenAlert(session.id, new Date(now - GROUP_WINDOW_MS).toISOString());
  if (open) {
    const ids = alertMessageIds(open);
    if (!ids.includes(messageId)) await setAlertMessages(open.alert_id, [...ids, messageId]);
    log.info('Failure alert grouped', { sessionId: session.id, alertId: open.alert_id, messages: ids.length + 1 });
    return true;
  }

  const owners = (await getOwners()).map((r) => r.user_id);
  if (owners.length === 0) return false;
  const origin = await getMessagingGroup(session.messaging_group_id);
  if (!origin) return false;
  const target = await pickApprovalDelivery(owners, origin.channel_type, origin.instance ?? undefined);
  const adapter = getDeliveryAdapter();
  if (!target || !adapter) return false;

  const row = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getInboundMessage(messageId),
  );
  const summary = summarize(row);
  const agentGroup = await getAgentGroup(session.agent_group_id);
  const channel = getChannelAdapter(origin.instance ?? origin.channel_type);
  const platformMsgId = platformMessageId(messageId, session.agent_group_id);
  let link: string | null = null;
  if (channel?.messageLink && platformMsgId) {
    try {
      link = await channel.messageLink(origin.platform_id, platformMsgId);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a missing link must not stop the alert
    } catch (err) {
      log.warn('Failure alert: could not get a message link', { sessionId: session.id, err });
    }
  }

  const alertId = `${ALERT_PREFIX}${now}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `⚠️ ${agentGroup?.name ?? 'The agent'} couldn't answer`;
  const question = alertQuestion({
    sender: summary?.sender ?? 'someone',
    where: origin.name ? `#${origin.name}` : 'a chat',
    text: summary?.text ?? '',
    link,
    notice: typeof notice.text === 'string' ? notice.text : '',
  });

  await createAlert({
    alert_id: alertId,
    session_id: session.id,
    message_ids: JSON.stringify([messageId]),
    owner_user_id: target.userId,
    title,
    question,
    created_at: new Date(now).toISOString(),
  });
  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat-sdk',
    JSON.stringify({ type: 'ask_question', questionId: alertId, title, question, options: ALERT_OPTIONS }),
    undefined,
    target.messagingGroup.instance ?? undefined,
  );
  log.info('Failure alert sent', { sessionId: session.id, alertId, owner: target.userId });
  return true;
}

/** Re-send an alert's messages to the agent. Returns how many were sent. */
export async function retryAlert(alert: FailureAlertRow): Promise<number> {
  const session = await getSession(alert.session_id);
  if (!session) return 0;
  const rows = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    alertMessageIds(alert).map((id) => mailbox.getInboundMessage(id)),
  );
  const resend = (rows ?? []).filter(
    (row): row is StoredInboundMessage => row !== undefined && summarize(row)?.deleted !== true,
  );
  if (resend.length === 0) return 0;

  const stamp = Date.now();
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `failalert-note-${stamp}`,
    kind: 'chat',
    timestamp: new Date(stamp).toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    trigger: false,
    content: JSON.stringify({
      text:
        `Your earlier run failed before you could answer, so ${resend.length === 1 ? 'the next message is' : `the next ${resend.length} messages are`} ` +
        'sent again. Handle them as if they were new.',
      sender: 'system',
      senderId: 'system',
    }),
  });
  for (const row of resend) {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `${row.id}:retry:${stamp}`,
      kind: row.kind as 'chat' | 'chat-sdk',
      timestamp: row.timestamp,
      platformId: row.platformId,
      channelType: row.channelType,
      threadId: row.threadId,
      content: row.content,
      trigger: true,
    });
  }
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'inbound-message');
  return resend.length;
}

export async function handleAlertResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith(ALERT_PREFIX)) return false;
  const alert = await getAlert(payload.questionId);
  if (!alert) return true;
  if (namespacedUserId(payload) !== alert.owner_user_id) {
    log.warn('Failure alert clicked by someone else, ignored', { alertId: alert.alert_id });
    return true;
  }
  const choice = payload.value === 'retry' ? 'retry' : 'dismiss';
  if (!(await resolveAlert(alert.alert_id, choice))) return true;
  if (choice === 'retry') {
    const sent = await retryAlert(alert);
    log.info('Failure alert retried', { alertId: alert.alert_id, sessionId: alert.session_id, sent });
  } else {
    log.info('Failure alert dismissed', { alertId: alert.alert_id });
  }
  return true;
}

registerFailureNoticeHandler(handleFailureNotice);
registerResponseHandler(handleAlertResponse);
registerQuestionRenderResolver(async (questionId) => {
  if (!questionId.startsWith(ALERT_PREFIX)) return undefined;
  const alert = await getAlert(questionId);
  return alert && { title: alert.title, question: alert.question, options: normalizeOptions(ALERT_OPTIONS) };
});
