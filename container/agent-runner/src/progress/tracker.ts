/**
 * Pure fold of `ProgressDetail` events into one run's snapshot.
 * No I/O and no clock of its own — the sink (./sink.ts) owns both.
 */
import type {
  PlanItem,
  ProgressDetail,
  RunProgressSnapshot,
  RunStatus,
  StepCategory,
  StepView,
  TerminalStatus,
} from './types.js';

export const DEFAULT_MAX_STEPS = 8;

export interface ApplyResult {
  /** The snapshot would render differently. */
  changed: boolean;
  /** A change people should see without throttling delay (waiting, plan replaced). */
  urgent: boolean;
}

export class RunProgressTracker {
  private seq = 0;
  private readonly steps: StepView[] = [];
  private earlierSteps = 0;
  private plan: PlanItem[] = [];
  private waiting: { id: string; on: 'question' | 'approval'; summary: string } | null = null;
  private statusText: string | null = null;
  private terminal: TerminalStatus | null = null;
  private updatedAt: string;

  constructor(
    readonly runId: string,
    private readonly startedAt: string,
    private readonly maxSteps = DEFAULT_MAX_STEPS,
  ) {
    this.updatedAt = startedAt;
  }

  get finished(): boolean {
    return this.terminal !== null;
  }

  apply(detail: ProgressDetail, now: string): ApplyResult {
    if (this.terminal) return { changed: false, urgent: false };
    const result = this.fold(detail);
    if (result.changed) this.updatedAt = now;
    return result;
  }

  finish(status: TerminalStatus, now: string): void {
    if (this.terminal) return;
    this.terminal = status;
    this.waiting = null;
    // Anything still marked running when the run ends did not report back.
    for (const step of this.steps) if (step.state === 'running') step.state = status === 'done' ? 'done' : 'failed';
    this.updatedAt = now;
  }

  /** Take the next snapshot; each call consumes a fresh `seq`. */
  snapshot(): RunProgressSnapshot {
    this.seq += 1;
    return {
      version: 1,
      runId: this.runId,
      seq: this.seq,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      status: this.status(),
      stage: this.stage(),
      plan: this.plan.map((item) => ({ ...item })),
      steps: this.steps.map((step) => ({ ...step })),
      earlierSteps: this.earlierSteps,
      waiting: this.waiting ? { on: this.waiting.on, summary: this.waiting.summary } : null,
      statusText: this.statusText,
    };
  }

  private status(): RunStatus {
    if (this.terminal) return this.terminal;
    return this.waiting ? 'waiting' : 'running';
  }

  private stage(): StepCategory | null {
    if (this.waiting) return 'ask';
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.steps[i].state === 'running') return this.steps[i].category;
    }
    return this.steps.length ? this.steps[this.steps.length - 1].category : null;
  }

  private fold(detail: ProgressDetail): ApplyResult {
    switch (detail.kind) {
      case 'step': {
        const existing = this.steps.find((s) => s.id === detail.id);
        if (existing) {
          if (existing.state === detail.state && existing.title === detail.title)
            return { changed: false, urgent: false };
          existing.state = detail.state;
          existing.title = detail.title;
        } else {
          this.steps.push({ id: detail.id, title: detail.title, state: detail.state, category: detail.category });
          if (this.steps.length > this.maxSteps) {
            this.steps.shift();
            this.earlierSteps += 1;
          }
        }
        // The step that resolves a wait (the ask_user_question call) ends it.
        if (this.waiting?.id === detail.id && detail.state !== 'running') {
          this.waiting = null;
          return { changed: true, urgent: true };
        }
        return { changed: true, urgent: false };
      }
      case 'plan': {
        const same =
          detail.items.length === this.plan.length &&
          detail.items.every((item, i) => item.title === this.plan[i].title && item.state === this.plan[i].state);
        if (same) return { changed: false, urgent: false };
        this.plan = detail.items.map((item) => ({ ...item }));
        return { changed: true, urgent: true };
      }
      case 'waiting':
        this.waiting = { id: detail.id, on: detail.on, summary: detail.summary };
        return { changed: true, urgent: true };
      case 'status':
        if (detail.text === this.statusText) return { changed: false, urgent: false };
        this.statusText = detail.text;
        return { changed: true, urgent: false };
    }
  }
}
