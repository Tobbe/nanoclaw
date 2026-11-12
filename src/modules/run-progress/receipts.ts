/**
 * Receipts: a 👀 reaction on a message the moment it reaches an agent, swapped
 * for ✅ (or ⚠️) when the work it started is over.
 *
 * Slack only shows a bot "typing" inside a thread, so a top-level DM or
 * channel message would otherwise get no sign of life until the run card
 * appears (8s) or the answer lands. The reaction is the acknowledgement.
 *
 * When is the work over?
 *   - A run that reports progress ends with its final snapshot (done →
 *     ✅, failed → ⚠️, stopped → 👀 just removed).
 *   - A turn that reports no progress (a plain text answer) never sends a
 *     snapshot, so the first reply delivered while no run is live closes it.
 *   - Safety net: a receipt whose session has had no container for a while
 *     is cleared, so a crashed turn doesn't leave 👀 forever.
 *
 * In memory only: a host restart forgets open receipts (the 👀 stays).
 */
import type { CardTarget } from './manager.js';

export const RECEIVED = 'eyes';
export const DONE = 'white_check_mark';
export const FAILED = 'warning';

export interface ReceiptIO {
  react(target: CardTarget, messageId: string, emoji: string, remove: boolean): Promise<void>;
}

export interface ReceiptDeps {
  io: ReceiptIO;
  isContainerRunning: (sessionId: string) => boolean;
  now?: () => number;
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void };
  /** How long a session may go without a container before its receipts are cleared. */
  staleAfterMs?: number;
}

interface Receipt {
  target: CardTarget;
  messageId: string;
  at: number;
  notRunningSince?: number;
}

type Outcome = 'done' | 'failed' | 'cancelled';

const MAX_PER_SESSION = 20;
const MAX_SESSIONS = 500;

export class Receipts {
  private readonly open = new Map<string, Receipt[]>();
  /** Sessions with a run that has reported progress and not yet finished. */
  private readonly liveRuns = new Set<string>();
  private readonly now: () => number;
  private readonly log: NonNullable<ReceiptDeps['log']>;
  private readonly staleAfterMs: number;

  constructor(private readonly deps: ReceiptDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? { warn: () => {} };
    this.staleAfterMs = deps.staleAfterMs ?? 60_000;
  }

  /** A message reached the agent: acknowledge it. */
  received(sessionId: string, target: CardTarget, messageId: string): void {
    const list = this.open.get(sessionId) ?? [];
    if (list.some((r) => r.messageId === messageId)) return;
    list.push({ target, messageId, at: this.now() });
    if (list.length > MAX_PER_SESSION) list.shift();
    this.open.delete(sessionId);
    this.open.set(sessionId, list);
    if (this.open.size > MAX_SESSIONS) this.open.delete(this.open.keys().next().value!);
    void this.send(target, messageId, RECEIVED, false);
  }

  /** A run snapshot arrived for the session. */
  runUpdate(sessionId: string, status: string): void {
    if (status === 'running' || status === 'waiting') {
      this.liveRuns.add(sessionId);
      return;
    }
    this.liveRuns.delete(sessionId);
    this.finish(sessionId, status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'done');
  }

  /** The agent's reply was delivered. Closes receipts unless a run is still going. */
  replied(sessionId: string): void {
    if (this.liveRuns.has(sessionId)) return;
    this.finish(sessionId, 'done');
  }

  /** Clear receipts of sessions whose container has been gone for a while. */
  sweep(): void {
    const now = this.now();
    for (const [sessionId, list] of this.open) {
      if (this.deps.isContainerRunning(sessionId)) {
        for (const r of list) r.notRunningSince = undefined;
        continue;
      }
      const stale = list.every((r) => {
        r.notRunningSince ??= now;
        return now - r.notRunningSince >= this.staleAfterMs;
      });
      if (stale) {
        this.liveRuns.delete(sessionId);
        this.finish(sessionId, 'cancelled');
      }
    }
  }

  get size(): number {
    return this.open.size;
  }

  private finish(sessionId: string, outcome: Outcome): void {
    const list = this.open.get(sessionId);
    if (!list) return;
    this.open.delete(sessionId);
    for (const r of list) {
      // Remove first so the two never show together for long.
      void this.send(r.target, r.messageId, RECEIVED, true).then(() => {
        if (outcome !== 'cancelled') return this.send(r.target, r.messageId, outcome === 'done' ? DONE : FAILED, false);
      });
    }
  }

  private async send(target: CardTarget, messageId: string, emoji: string, remove: boolean): Promise<void> {
    try {
      await this.deps.io.react(target, messageId, emoji, remove);
    } catch (err) {
      this.log.warn('Receipt reaction failed', {
        messageId,
        emoji,
        remove,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
