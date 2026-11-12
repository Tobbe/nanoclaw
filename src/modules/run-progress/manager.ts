/**
 * Run card manager: owns one card (a single platform message) per run and
 * keeps it in step with the run's latest snapshot.
 *
 * - Posts the card once a run has lasted `postAfterMs`, or at once when the
 *   run starts waiting on a person. Runs that finish sooner never get a card.
 * - Edits it when a newer snapshot arrives, at most once per `minEditGapMs`.
 * - Refreshes it every `refreshMs` while live, so the elapsed time keeps
 *   moving through a long step.
 * - Writes the final state (done / failed / stopped), and closes cards whose
 *   container went away mid-run as "Interrupted".
 *
 * All platform calls run from `tick()`, never from the delivery path, so a
 * slow or rate-limited edit can't hold up an agent's replies. At most
 * `maxOpsPerTick` calls start per tick across the whole install; final states
 * and real changes go before elapsed-time refreshes, which are the first to
 * wait when the budget is short. A slow edit is abandoned after `editTimeoutMs`
 * (the next one replaces it); posts are never abandoned, so a late post can't
 * produce a duplicate card.
 */
import { renderRunCard, type RenderedCard } from './render.js';
import type { RunProgressSnapshot } from './snapshot.js';
import type { RunCardRow } from './store.js';

export interface CardTarget {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance: string;
}

export interface CardIO {
  /** Post a new card; resolves to the platform message id. */
  post(target: CardTarget, content: RenderedCard['content']): Promise<string | undefined>;
  /** Replace an existing message with the card. */
  edit(target: CardTarget, messageId: string, content: RenderedCard['content']): Promise<void>;
}

export interface RunCardConfig {
  postAfterMs: number;
  minEditGapMs: number;
  refreshMs: number;
  editTimeoutMs: number;
  backoffMs: number;
  staleAfterMs: number;
  maxOpsPerTick: number;
  maxFinalAttempts: number;
  maxCards: number;
}

export const DEFAULT_RUN_CARD_CONFIG: RunCardConfig = {
  postAfterMs: 8_000,
  minEditGapMs: 3_000,
  refreshMs: 15_000,
  editTimeoutMs: 15_000,
  backoffMs: 30_000,
  staleAfterMs: 30_000,
  maxOpsPerTick: 1,
  maxFinalAttempts: 5,
  maxCards: 500,
};

export interface RunCardManagerDeps {
  io: CardIO;
  save: (row: RunCardRow) => Promise<void>;
  isContainerRunning: (sessionId: string) => boolean;
  now?: () => number;
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void };
  config?: Partial<RunCardConfig>;
}

interface Card {
  key: string;
  sessionId: string;
  target: CardTarget;
  snapshot: RunProgressSnapshot;
  firstSeenAt: number;
  createdAtIso: string;
  messageId?: string;
  inFlight: boolean;
  lastEditAt: number;
  renderedSeq: number;
  renderedFinal: boolean;
  interrupted: boolean;
  backoffUntil: number;
  notRunningSince?: number;
  finalAttempts: number;
}

type Op = { card: Card; kind: 'post' | 'final' | 'change' | 'refresh' };
const PRIORITY: Record<Op['kind'], number> = { final: 0, post: 1, change: 2, refresh: 3 };

function isFinal(status: RunProgressSnapshot['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

export class RunCardManager {
  private readonly cards = new Map<string, Card>();
  /** Runs whose card is closed (or was never needed): a late snapshot must not reopen one. */
  private readonly finished = new Set<string>();
  private readonly config: RunCardConfig;
  private readonly now: () => number;
  private readonly log: NonNullable<RunCardManagerDeps['log']>;

  constructor(private readonly deps: RunCardManagerDeps) {
    this.config = { ...DEFAULT_RUN_CARD_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? { warn: () => {} };
  }

  get size(): number {
    return this.cards.size;
  }

  /** Feed the latest snapshot for a run. Cheap and synchronous: no platform calls. */
  accept(sessionId: string, snapshot: RunProgressSnapshot, target: CardTarget): void {
    const key = `${sessionId}:${snapshot.runId}`;
    if (this.finished.has(key)) return;
    const existing = this.cards.get(key);
    if (existing) {
      if (snapshot.seq <= existing.snapshot.seq || existing.renderedFinal) return;
      existing.snapshot = snapshot;
      existing.notRunningSince = undefined;
      return;
    }
    // A run first seen already finished never needs a card.
    if (isFinal(snapshot.status)) {
      this.markFinished(key);
      return;
    }
    this.evictIfFull();
    const now = this.now();
    this.cards.set(key, {
      key,
      sessionId,
      target,
      snapshot,
      firstSeenAt: now,
      createdAtIso: new Date(now).toISOString(),
      inFlight: false,
      lastEditAt: 0,
      renderedSeq: 0,
      renderedFinal: false,
      interrupted: false,
      backoffUntil: 0,
      finalAttempts: 0,
    });
  }

  /** Re-adopt a card a previous host left open. Closed as Interrupted unless its run reports in. */
  restore(row: RunCardRow, snapshot: RunProgressSnapshot): void {
    const key = `${row.session_id}:${row.run_id}`;
    if (this.cards.has(key)) return;
    this.evictIfFull();
    const now = this.now();
    this.cards.set(key, {
      key,
      sessionId: row.session_id,
      target: {
        channelType: row.channel_type,
        platformId: row.platform_id,
        threadId: row.thread_id,
        instance: row.instance,
      },
      snapshot,
      firstSeenAt: now,
      createdAtIso: row.created_at,
      messageId: row.platform_message_id,
      inFlight: false,
      lastEditAt: now,
      renderedSeq: snapshot.seq,
      renderedFinal: false,
      interrupted: false,
      backoffUntil: 0,
      notRunningSince: now,
      finalAttempts: 0,
    });
  }

  /**
   * One scheduling pass. Starts at most `maxOpsPerTick` platform calls and
   * resolves when they settle (the host's interval doesn't wait on it).
   */
  async tick(): Promise<void> {
    const now = this.now();
    const ops: Op[] = [];
    for (const card of this.cards.values()) {
      this.checkLiveness(card, now);
      const op = this.nextOp(card, now);
      if (op) ops.push(op);
    }
    ops.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
    await Promise.all(ops.slice(0, this.config.maxOpsPerTick).map((op) => this.run(op)));
  }

  private checkLiveness(card: Card, now: number): void {
    if (card.interrupted || isFinal(card.snapshot.status)) return;
    if (this.deps.isContainerRunning(card.sessionId)) {
      card.notRunningSince = undefined;
      return;
    }
    card.notRunningSince ??= now;
    if (now - card.notRunningSince >= this.config.staleAfterMs) card.interrupted = true;
  }

  private nextOp(card: Card, now: number): Op | null {
    const final = card.interrupted || isFinal(card.snapshot.status);
    if (!card.messageId) {
      if (card.inFlight) return null;
      // Never posted and already over: nobody saw a card, so none is needed.
      if (final) {
        this.close(card.key);
        return null;
      }
      if (now < card.backoffUntil) return null;
      const due = card.snapshot.status === 'waiting' || now - card.firstSeenAt >= this.config.postAfterMs;
      return due ? { card, kind: 'post' } : null;
    }
    if (card.renderedFinal) {
      this.close(card.key);
      return null;
    }
    if (card.inFlight || now < card.backoffUntil) return null;
    if (final) return { card, kind: 'final' };
    const sinceEdit = now - card.lastEditAt;
    if (card.snapshot.seq !== card.renderedSeq && sinceEdit >= this.config.minEditGapMs)
      return { card, kind: 'change' };
    if (sinceEdit >= this.config.refreshMs) return { card, kind: 'refresh' };
    return null;
  }

  private async run(op: Op): Promise<void> {
    const { card } = op;
    const snapshot = card.snapshot;
    const interrupted = card.interrupted;
    const rendered = renderRunCard(snapshot, this.now(), { interrupted });
    card.inFlight = true;
    try {
      if (op.kind === 'post') {
        // Never abandoned: a post that lands late must still be recorded, or
        // the next attempt would put a second card in the thread.
        const id = await this.deps.io.post(card.target, rendered.content);
        if (!id) throw new Error('adapter returned no message id');
        card.messageId = id;
      } else {
        await this.withTimeout(this.deps.io.edit(card.target, card.messageId!, rendered.content));
      }
      card.lastEditAt = this.now();
      card.renderedSeq = snapshot.seq;
      const wroteFinal = interrupted || isFinal(snapshot.status);
      if (wroteFinal) card.renderedFinal = true;
      await this.persist(card, snapshot, interrupted ? 'cancelled' : snapshot.status);
    } catch (err) {
      card.backoffUntil = this.now() + this.config.backoffMs;
      if (op.kind === 'final' && ++card.finalAttempts >= this.config.maxFinalAttempts) {
        // Give up rather than retry forever; the card keeps its last state.
        card.renderedFinal = true;
      }
      this.log.warn('Run card update failed', {
        sessionId: card.sessionId,
        runId: snapshot.runId,
        kind: op.kind,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      card.inFlight = false;
    }
  }

  private withTimeout(promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('card edit timed out')), this.config.editTimeoutMs);
    });
    // A late result of an abandoned edit is harmless: the next edit replaces it.
    promise.catch(() => {});
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private async persist(card: Card, snapshot: RunProgressSnapshot, status: string): Promise<void> {
    try {
      await this.deps.save({
        session_id: card.sessionId,
        run_id: snapshot.runId,
        channel_type: card.target.channelType,
        platform_id: card.target.platformId,
        thread_id: card.target.threadId,
        instance: card.target.instance,
        platform_message_id: card.messageId!,
        status,
        snapshot_json: JSON.stringify(snapshot),
        created_at: card.createdAtIso,
        updated_at: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.log.warn('Run card save failed', {
        sessionId: card.sessionId,
        runId: snapshot.runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private close(key: string): void {
    this.cards.delete(key);
    this.markFinished(key);
  }

  private markFinished(key: string): void {
    this.finished.add(key);
    if (this.finished.size > this.config.maxCards) {
      const oldest = this.finished.values().next().value;
      if (oldest !== undefined) this.finished.delete(oldest);
    }
  }

  private evictIfFull(): void {
    if (this.cards.size < this.config.maxCards) return;
    const oldest = this.cards.keys().next().value;
    if (oldest !== undefined) this.cards.delete(oldest);
  }
}
