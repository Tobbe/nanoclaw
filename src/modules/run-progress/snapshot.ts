/**
 * Host-side mirror of the agent-runner's `RunProgressSnapshot`
 * (container/agent-runner/src/progress/types.ts). Host and container share no
 * modules, so the shape is restated here and validated on the way in — the
 * outbound DB is written by the agent, so its rows are untrusted input.
 */

export type StepCategory = 'inspect' | 'edit' | 'run' | 'test' | 'web' | 'delegate' | 'ask' | 'other';
export type StepState = 'running' | 'done' | 'failed';
export type PlanItemState = 'pending' | 'running' | 'done';
export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface RunProgressSnapshot {
  version: 1;
  runId: string;
  seq: number;
  startedAt: string;
  updatedAt: string;
  status: RunStatus;
  stage: StepCategory | null;
  plan: { title: string; state: PlanItemState }[];
  steps: { id: string; title: string; state: StepState; category: StepCategory }[];
  earlierSteps: number;
  waiting: { on: 'question' | 'approval'; summary: string } | null;
  statusText: string | null;
}

const CATEGORIES = new Set<StepCategory>(['inspect', 'edit', 'run', 'test', 'web', 'delegate', 'ask', 'other']);
const STEP_STATES = new Set<StepState>(['running', 'done', 'failed']);
const PLAN_STATES = new Set<PlanItemState>(['pending', 'running', 'done']);
const RUN_STATUSES = new Set<RunStatus>(['running', 'waiting', 'done', 'failed', 'cancelled']);

/** Text caps — a misbehaving container can't push unbounded strings into a card. */
const MAX_TEXT = 200;
const MAX_ITEMS = 50;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRunProgressSnapshot(raw: unknown): RunProgressSnapshot | null {
  if (!isObject(raw) || raw.version !== 1) return null;
  const runId = text(raw.runId);
  const startedAt = text(raw.startedAt);
  const updatedAt = text(raw.updatedAt);
  if (!runId || !startedAt || !updatedAt) return null;
  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 1) return null;
  if (!RUN_STATUSES.has(raw.status as RunStatus)) return null;
  const stage =
    raw.stage === null ? null : CATEGORIES.has(raw.stage as StepCategory) ? (raw.stage as StepCategory) : null;

  const plan: RunProgressSnapshot['plan'] = [];
  if (Array.isArray(raw.plan)) {
    for (const item of raw.plan.slice(0, MAX_ITEMS)) {
      if (!isObject(item)) continue;
      const title = text(item.title);
      if (!title || !PLAN_STATES.has(item.state as PlanItemState)) continue;
      plan.push({ title, state: item.state as PlanItemState });
    }
  }

  const steps: RunProgressSnapshot['steps'] = [];
  if (Array.isArray(raw.steps)) {
    for (const step of raw.steps.slice(0, MAX_ITEMS)) {
      if (!isObject(step)) continue;
      const id = text(step.id);
      const title = text(step.title);
      if (!id || !title || !STEP_STATES.has(step.state as StepState)) continue;
      const category = CATEGORIES.has(step.category as StepCategory) ? (step.category as StepCategory) : 'other';
      steps.push({ id, title, state: step.state as StepState, category });
    }
  }

  let waiting: RunProgressSnapshot['waiting'] = null;
  if (isObject(raw.waiting) && (raw.waiting.on === 'question' || raw.waiting.on === 'approval')) {
    waiting = { on: raw.waiting.on, summary: text(raw.waiting.summary) ?? 'Waiting for an answer' };
  }

  const earlierSteps =
    typeof raw.earlierSteps === 'number' && Number.isInteger(raw.earlierSteps) && raw.earlierSteps >= 0
      ? raw.earlierSteps
      : 0;

  return {
    version: 1,
    runId,
    seq: raw.seq,
    startedAt,
    updatedAt,
    status: raw.status as RunStatus,
    stage,
    plan,
    steps,
    earlierSteps,
    waiting,
    statusText: text(raw.statusText),
  };
}
