/**
 * Run progress — host side.
 *
 * The agent-runner writes `run_progress` system actions carrying a whole
 * `RunProgressSnapshot` (container/agent-runner/src/progress/types.ts) while a
 * turn runs. This module validates them, keeps the newest per run, and hands
 * them to the run card manager (./manager.ts), which shows one updating card
 * in the conversation's thread.
 *
 * Display-only: the snapshot carries no privilege, so the action is
 * unguarded. The card only ever goes to the session's own chat — a route in
 * the payload is honored only when it names that chat.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { RunCardManager, type CardIO, type CardTarget } from './manager.js';
import { parseRunProgressSnapshot, type RunProgressSnapshot } from './snapshot.js';
import { listOpenRunCards, pruneFinishedRunCards, rowSnapshot, saveRunCard } from './store.js';

export { parseRunProgressSnapshot, type RunProgressSnapshot } from './snapshot.js';

const MAX_TRACKED_RUNS = 200;
const TICK_MS = 1_000;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;

/** Latest snapshot per run, keyed `<sessionId>:<runId>`. Bounded, oldest evicted. */
const latest = new Map<string, RunProgressSnapshot>();

export function latestRunProgress(sessionId: string, runId: string): RunProgressSnapshot | undefined {
  return latest.get(`${sessionId}:${runId}`);
}

/** Apply a snapshot; returns false when it is stale (not newer than what we hold). */
export function recordRunProgress(sessionId: string, snapshot: RunProgressSnapshot): boolean {
  const key = `${sessionId}:${snapshot.runId}`;
  const prior = latest.get(key);
  if (prior && prior.seq >= snapshot.seq) return false;
  latest.delete(key);
  latest.set(key, snapshot);
  if (latest.size > MAX_TRACKED_RUNS) latest.delete(latest.keys().next().value!);
  return true;
}

/** Card I/O through the host's delivery adapter, as the same `chat-sdk` card content send_card uses. */
const deliveryCardIO: CardIO = {
  async post(target, content) {
    const adapter = getDeliveryAdapter();
    if (!adapter) throw new Error('no delivery adapter');
    return adapter.deliver(
      target.channelType,
      target.platformId,
      target.threadId,
      'chat-sdk',
      JSON.stringify(content),
      undefined,
      target.instance,
    );
  },
  async edit(target, messageId, content) {
    const adapter = getDeliveryAdapter();
    if (!adapter) throw new Error('no delivery adapter');
    await adapter.deliver(
      target.channelType,
      target.platformId,
      target.threadId,
      'chat-sdk',
      JSON.stringify({ ...content, operation: 'edit', messageId }),
      undefined,
      target.instance,
    );
  },
};

/** Until the host starts, nothing is running — every card would look stale. */
let containerRunning: (sessionId: string) => boolean = () => true;

export const runCards = new RunCardManager({
  io: deliveryCardIO,
  save: saveRunCard,
  isContainerRunning: (sessionId) => containerRunning(sessionId),
  log,
});

/**
 * Where a session's card goes: the session's own chat, in the payload's
 * thread when the payload names that same chat. Null when the session has no
 * chat (task or agent-to-agent sessions) or the chat is detached.
 */
export async function resolveCardTarget(session: Session, hint: unknown): Promise<CardTarget | null> {
  if (!session.messaging_group_id) return null;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg || mg.detached_at) return null;
  const h = (hint ?? {}) as { channelType?: unknown; platformId?: unknown; threadId?: unknown };
  const sameChat = h.channelType === mg.channel_type && h.platformId === mg.platform_id;
  const threadId = sameChat && (typeof h.threadId === 'string' || h.threadId === null) ? h.threadId : session.thread_id;
  return {
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    threadId: threadId ?? null,
    instance: mg.instance ?? mg.channel_type,
  };
}

export async function handleRunProgress(content: Record<string, unknown>, session: Session): Promise<void> {
  const snapshot = parseRunProgressSnapshot(content.snapshot);
  if (!snapshot) {
    log.warn('run_progress: malformed snapshot dropped', { sessionId: session.id });
    return;
  }
  if (!recordRunProgress(session.id, snapshot)) return;
  const running = snapshot.steps.find((s) => s.state === 'running');
  log.debug('run_progress', {
    sessionId: session.id,
    runId: snapshot.runId,
    seq: snapshot.seq,
    status: snapshot.status,
    stage: snapshot.stage,
    current: running?.title,
  });
  const target = await resolveCardTarget(session, content.target);
  if (!target) return;
  // Hand off and return: the card is updated from the manager's own tick,
  // never from the delivery path.
  runCards.accept(session.id, snapshot, target);
}

registerDeliveryAction(
  'run_progress',
  handleRunProgress,
  unguarded('display-only progress snapshot for the run card; carries no privilege'),
);

let tickTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

onHostStart(async () => {
  const { isContainerRunning } = await import('../../container-runner.js');
  containerRunning = isContainerRunning;
  try {
    await pruneFinishedRunCards(new Date(Date.now() - KEEP_FINISHED_MS).toISOString());
    for (const row of await listOpenRunCards()) {
      const snapshot = rowSnapshot(row);
      if (snapshot) runCards.restore(row, snapshot);
    }
  } catch (err) {
    log.warn('Run cards: restore failed', { err });
  }
  tickTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    runCards
      .tick()
      .catch((err) => log.warn('Run cards: tick failed', { err }))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  tickTimer.unref?.();
});

onHostShutdown(() => {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
});
