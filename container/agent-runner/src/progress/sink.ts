/**
 * Run-progress sink: turns a turn's `progress` events into throttled snapshot
 * writes for the host.
 *
 * One run = one answered turn. A run starts lazily on its first progress event
 * (quick answers with no tool use never produce a row) and ends at the turn's
 * result. Each write carries the WHOLE snapshot as a `run_progress` system
 * action, so the host can keep only the highest `seq` per run.
 *
 * Writes are `kind: 'system'` on purpose: system rows skip the host's typing
 * pause, cross-session fan-out and post-delivery hooks, and are not counted as
 * chat sends by the wrap-nudge.
 *
 * Throttling: at most one write per `intervalMs`; urgent changes (waiting on
 * a person, a new plan) and the final state are written immediately. Writes
 * are serialized so they land in `seq` order.
 */
import type { RoutingContext } from '../formatter.js';
import type { ProviderEvent } from '../providers/types.js';
import { DEFAULT_MAX_STEPS, RunProgressTracker } from './tracker.js';
import type { ProgressDetail, RunProgressSnapshot, TerminalStatus } from './types.js';

export const RUN_PROGRESS_ACTION = 'run_progress';
export const DEFAULT_PROGRESS_INTERVAL_MS = 2500;

export interface RunProgressTarget {
  platformId: string;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

export type RunProgressWrite = (snapshot: RunProgressSnapshot, target: RunProgressTarget) => Promise<void>;

export interface RunProgressSinkOptions {
  write: RunProgressWrite;
  newRunId: () => string;
  enabled?: boolean;
  intervalMs?: number;
  maxSteps?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

/** Progress shows only on a real conversation route — never on task runs. */
export function progressTarget(routing: RoutingContext): RunProgressTarget | null {
  if (routing.taskRun || !routing.platformId || routing.channelType === 'agent') return null;
  return {
    platformId: routing.platformId,
    channelType: routing.channelType,
    threadId: routing.threadId,
    inReplyTo: routing.inReplyTo,
  };
}

/** Progress events without structured detail (other providers) become a status line. */
export function detailOf(event: Extract<ProviderEvent, { type: 'progress' }>): ProgressDetail {
  return event.detail ?? { kind: 'status', text: event.message };
}

export class RunProgressSink {
  private tracker: RunProgressTracker | null = null;
  private target: RunProgressTarget | null = null;
  private written = false;
  private lastWriteAt = 0;
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly maxSteps: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string) => void;

  constructor(private readonly options: RunProgressSinkOptions) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = options.log ?? (() => {});
  }

  /** Feed one provider event. Non-progress events are ignored. Never blocks. */
  onEvent(event: ProviderEvent, routing: RoutingContext): void {
    if (!this.enabled || event.type !== 'progress') return;
    if (!this.tracker) {
      const target = progressTarget(routing);
      if (!target) return;
      this.target = target;
      this.tracker = new RunProgressTracker(this.options.newRunId(), this.iso(), this.maxSteps);
    }
    const { changed, urgent } = this.tracker.apply(detailOf(event), this.iso());
    if (!changed) return;
    // The first write goes out at once so the host can start its clock.
    if (urgent || !this.written || this.now() - this.lastWriteAt >= this.intervalMs) this.flush();
    else this.schedule();
  }

  /** End the current run (if one started) and write its final state. */
  async finish(status: TerminalStatus): Promise<void> {
    const tracker = this.tracker;
    if (!tracker) return;
    this.tracker = null;
    this.cancelTimer();
    tracker.finish(status, this.iso());
    // Nothing was ever written: the host has no card to close.
    if (this.written) this.enqueue(tracker.snapshot(), this.target!);
    this.written = false;
    this.target = null;
    await this.chain;
  }

  /** Stop timers without writing (process shutdown). */
  dispose(): void {
    this.cancelTimer();
  }

  private flush(): void {
    this.cancelTimer();
    if (!this.tracker || !this.target) return;
    this.written = true;
    this.lastWriteAt = this.now();
    this.enqueue(this.tracker.snapshot(), this.target);
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, this.intervalMs - (this.now() - this.lastWriteAt));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private enqueue(snapshot: RunProgressSnapshot, target: RunProgressTarget): void {
    this.chain = this.chain
      .then(() => this.options.write(snapshot, target))
      .catch((err) => this.log(`run_progress write failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
