/**
 * Run card rendering: a snapshot plus the current time → a display card
 * (`{ type: 'card', card, fallbackText }`, the same content shape `send_card`
 * uses, so every Chat SDK channel can post and edit it) with a plain-text
 * fallback for clients that can't show cards.
 *
 * The card is deliberately quiet: no header, only muted text parts (Slack
 * draws them as small grey context blocks). While the run is live it shows a
 * status line plus the plan or the last few steps; once the run is done it
 * collapses to a single line, because the agent's answer is right below it.
 * A failed or stopped run keeps its recent steps so you can see where it
 * ended.
 *
 * Text that came from the agent (plan items, step titles, the waiting
 * summary) is untrusted: hidden characters are made visible and angle
 * brackets are swapped for look-alikes so a title can't become a Slack
 * mention (`<!channel>`) or link.
 */
import { escapeInvisibles } from '../../card-text.js';
import type { RunProgressSnapshot } from './snapshot.js';

/** Steps shown while live, and on a failed card. */
const MAX_STEPS_SHOWN = 4;
/** Plan items shown before the rest are folded into "+N more". */
const MAX_PLAN_SHOWN = 8;

export interface RenderOptions {
  /** Host closed the card itself: the run's container went away mid-run. */
  interrupted?: boolean;
}

/** A muted text part — Slack renders it as a small grey context block. */
export interface MutedText {
  type: 'Text';
  props: { content: string; style: 'muted' };
}

export interface RenderedCard {
  /** JSON-serializable content for ChannelDeliveryAdapter.deliver (kind 'chat-sdk'). */
  content: { type: 'card'; card: { title: string; children: MutedText[] }; fallbackText: string };
  /** Changes only when what people see changes — used to skip no-op edits. */
  fingerprint: string;
}

type Step = RunProgressSnapshot['steps'][number];

const PLAN_MARK = { done: '✓', running: '◉', pending: '○' } as const;
const STEP_MARK = { done: '✓', running: '◉', failed: '✗' } as const;

/** Untrusted text → safe for a card line. */
export function safeText(text: string): string {
  return escapeInvisibles(text.replace(/\s+/g, ' ').trim()).replace(/</g, '‹').replace(/>/g, '›');
}

/** `45s`, `1m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function elapsedMs(snapshot: RunProgressSnapshot, nowMs: number, live: boolean): number {
  const start = Date.parse(snapshot.startedAt);
  const end = live ? nowMs : Date.parse(snapshot.updatedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
}

/**
 * Steps worth showing: a failure that a later step with the same title got
 * past (a retry) is dropped — it was routine, not a problem.
 */
export function visibleSteps(steps: Step[]): Step[] {
  return steps.filter(
    (step, i) =>
      step.state !== 'failed' ||
      !steps.slice(i + 1).some((later) => later.title === step.title && later.state !== 'failed'),
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function muted(content: string): MutedText {
  return { type: 'Text', props: { content, style: 'muted' } };
}

function stepLines(steps: Step[], earlier: number): string {
  const shown = steps.slice(-MAX_STEPS_SHOWN);
  const hidden = earlier + (steps.length - shown.length);
  const lines = shown.map((step) => `${STEP_MARK[step.state]} ${safeText(step.title)}`);
  if (hidden > 0) lines.unshift(`+ ${plural(hidden, 'earlier step')}`);
  return lines.join('\n');
}

function planLines(plan: RunProgressSnapshot['plan']): string {
  const shown = plan.slice(0, MAX_PLAN_SHOWN);
  const lines = shown.map((item) => `${PLAN_MARK[item.state]} ${safeText(item.title)}`);
  if (plan.length > shown.length) lines.push(`+ ${plan.length - shown.length} more`);
  return lines.join('\n');
}

export function renderRunCard(snapshot: RunProgressSnapshot, nowMs: number, opts: RenderOptions = {}): RenderedCard {
  const interrupted = opts.interrupted === true;
  const live = !interrupted && (snapshot.status === 'running' || snapshot.status === 'waiting');
  const elapsed = formatElapsed(elapsedMs(snapshot, nowMs, live));
  const steps = visibleSteps(snapshot.steps);
  const total = snapshot.steps.length + snapshot.earlierSteps;
  const failed = steps.filter((s) => s.state === 'failed').length;

  const lines: string[] = [];

  if (live) {
    if (snapshot.status === 'waiting') {
      const on = snapshot.waiting?.on === 'approval' ? 'approval' : 'your answer';
      // The question itself is on screen right above, with its buttons: the
      // card only says the run is paused, not what for.
      lines.push(`⏸️ *Waiting for ${on}* · ${elapsed}`);
    } else {
      lines.push(`⏳ *Working on it* · ${elapsed}`);
    }
    if (snapshot.status === 'waiting') {
      // Nothing else while paused.
    } else if (snapshot.plan.length > 0) lines.push(planLines(snapshot.plan));
    else if (steps.length > 0) lines.push(stepLines(steps, snapshot.earlierSteps));
    else if (snapshot.statusText) lines.push(safeText(snapshot.statusText));
  } else if (snapshot.status === 'done' && !interrupted) {
    // Collapsed: the answer below says the rest.
    lines.push(`✅ Done in ${elapsed} · ${plural(total, 'step')}`);
  } else {
    const head = interrupted
      ? `⏹️ *Interrupted* after ${elapsed} · the agent stopped before finishing`
      : snapshot.status === 'failed'
        ? `❌ *Failed* after ${elapsed} · ${plural(total, 'step')}${failed > 0 ? `, ${failed} failed` : ''}`
        : `⏹️ *Stopped* after ${elapsed} · ${plural(total, 'step')}`;
    lines.push(head);
    if (steps.length > 0) lines.push(stepLines(steps, snapshot.earlierSteps));
  }

  const fallbackText = lines.join('\n');
  return {
    content: { type: 'card', card: { title: '', children: lines.map(muted) }, fallbackText },
    fingerprint: fallbackText,
  };
}
