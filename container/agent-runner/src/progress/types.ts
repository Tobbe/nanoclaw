/**
 * Provider-neutral run-progress model.
 *
 * Providers emit `ProgressDetail` on `progress` events (see
 * ../providers/types.ts); the run-progress sink (./sink.ts) folds them into a
 * `RunProgressSnapshot` and hands the whole snapshot to the host as a
 * `run_progress` system action. Every field a channel renders is built inside
 * the container from allowlisted inputs (./summarize.ts): raw commands, full
 * paths, tool output and model reasoning never appear here.
 */

/** Coarse bucket for a step — drives the card's "stage" line. */
export type StepCategory = 'inspect' | 'edit' | 'run' | 'test' | 'web' | 'delegate' | 'ask' | 'other';

export type StepState = 'running' | 'done' | 'failed';

export type PlanItemState = 'pending' | 'running' | 'done';

export interface PlanItem {
  title: string;
  state: PlanItemState;
}

export type ProgressDetail =
  /** One tool call (or equivalent unit of work). `id` pairs start and finish. */
  | { kind: 'step'; id: string; title: string; state: StepState; category: StepCategory; tool?: string }
  /** The agent's own checklist, replaced wholesale on every update. */
  | { kind: 'plan'; items: PlanItem[] }
  /** The run is blocked on a person. `id` pairs it with the step that resolves it. */
  | { kind: 'waiting'; id: string; on: 'question' | 'approval'; summary: string }
  /** A free-form status line from a provider with nothing more structured. */
  | { kind: 'status'; text: string };

export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export type TerminalStatus = Extract<RunStatus, 'done' | 'failed' | 'cancelled'>;

export interface StepView {
  id: string;
  title: string;
  state: StepState;
  category: StepCategory;
}

/**
 * The full state of one run. Written whole on every update so the host can
 * keep only the highest `seq` — duplicates, reordering and replays can never
 * produce a wrong card.
 */
export interface RunProgressSnapshot {
  version: 1;
  runId: string;
  seq: number;
  startedAt: string;
  updatedAt: string;
  status: RunStatus;
  /** Category of the step currently running (or last run); null before the first step. */
  stage: StepCategory | null;
  plan: PlanItem[];
  /** Most recent steps, oldest first. */
  steps: StepView[];
  /** Steps that scrolled out of `steps`. */
  earlierSteps: number;
  waiting: { on: 'question' | 'approval'; summary: string } | null;
  /** Latest free-form status line, if a provider sent one. */
  statusText: string | null;
}
