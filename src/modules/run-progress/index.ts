/**
 * Run progress — host side.
 *
 * The agent-runner writes `run_progress` system actions carrying a whole
 * `RunProgressSnapshot` (container/agent-runner/src/progress/types.ts) while a
 * turn runs. M1: receive, validate and keep the latest snapshot per run; the
 * run card that renders it lands in M3.
 *
 * Display-only: the snapshot carries no privilege, so the action is
 * unguarded. Snapshots are idempotent — only a higher `seq` replaces a run's
 * state, so duplicate or reordered rows are harmless.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { parseRunProgressSnapshot, type RunProgressSnapshot } from './snapshot.js';

export { parseRunProgressSnapshot, type RunProgressSnapshot } from './snapshot.js';

const MAX_TRACKED_RUNS = 200;

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
    steps: snapshot.steps.length + snapshot.earlierSteps,
    current: running?.title,
    plan: snapshot.plan.length ? snapshot.plan.map((p) => `${p.state}:${p.title}`).join(' | ') : undefined,
    waiting: snapshot.waiting?.summary,
  });
}

registerDeliveryAction(
  'run_progress',
  handleRunProgress,
  unguarded('display-only progress snapshot for the run card; carries no privilege'),
);
