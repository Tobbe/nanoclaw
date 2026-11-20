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
const MAX_STEPS_SHOWN = 10;
/** Plan items shown before the rest are folded into "+N more". */
const MAX_PLAN_SHOWN = 8;

export interface RenderOptions {
  /** Host closed the card itself: the run's container went away mid-run. */
  interrupted?: boolean;
  /** Someone pressed Stop on the card: their display name. */
  stoppedBy?: string;
  /** When Stop was pressed (ms): the elapsed time ends here, not at the last update. */
  stoppedAt?: number;
}

/**
 * Action id of the Stop button on a live card. The click is matched to its
 * run by the card's message id, so the button carries nothing else.
 */
export const STOP_ACTION_ID = 'ncrun:stop';

/** A muted text part — Slack renders it as a small grey context block. */
export interface MutedText {
  type: 'Text';
  props: { content: string; style: 'muted' };
}

export interface RenderedCard {
  /** JSON-serializable content for ChannelDeliveryAdapter.deliver (kind 'chat-sdk'). */
  content: {
    type: 'card';
    card: { title: string; children: MutedText[]; stopButton?: { id: string; label: string } };
    fallbackText: string;
  };
  /** Changes only when what people see changes — used to skip no-op edits. */
  fingerprint: string;
}

type Step = RunProgressSnapshot['steps'][number];

const PLAN_MARK = { done: '✓', running: '◉', pending: '○' } as const;
const STEP_MARK = { done: '✓', running: '◉', failed: '✗' } as const;
const CUT_OFF_MARK = '◌';

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

function elapsedMs(snapshot: RunProgressSnapshot, nowMs: number, live: boolean, stoppedAt?: number): number {
  const start = Date.parse(snapshot.startedAt);
  const end = live ? nowMs : (stoppedAt ?? Date.parse(snapshot.updatedAt));
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

interface StepGroup {
  title: string;
  state: Step['state'];
  count: number;
  /** When the group's newest step started. */
  startedAt?: string;
}

/** Past-tense step verbs → what the step is doing while it runs. */
const PRESENT: Record<string, string> = {
  asked: 'asking',
  checked: 'checking',
  cloned: 'cloning',
  commented: 'commenting',
  committed: 'committing',
  delegated: 'delegating',
  edited: 'editing',
  fetched: 'fetching',
  installed: 'installing',
  listed: 'listing',
  looked: 'looking',
  opened: 'opening',
  organised: 'organising',
  pulled: 'pulling',
  pushed: 'pushing',
  ran: 'running',
  read: 'reading',
  searched: 'searching',
  set: 'setting',
  staged: 'staging',
  started: 'starting',
  stopped: 'stopping',
  switched: 'switching',
  took: 'taking',
  used: 'using',
  waited: 'waiting',
  worked: 'working',
  wrote: 'writing',
};

/**
 * A running step reads as happening now: "Committed and pushed changes and
 * waited for the checks" → "Committing and pushing changes and waiting for
 * the checks". Only verbs that start a clause change (the title's first word,
 * and words after ", " or " and "); anything unknown stays as it is.
 */
export function presentTense(title: string): string {
  return title.replace(/(^|, | and )([A-Za-z]+)\b/g, (match, lead: string, word: string) => {
    const present = PRESENT[word.toLowerCase()];
    if (!present) return match;
    return lead + (word[0] === word[0].toUpperCase() ? present[0].toUpperCase() + present.slice(1) : present);
  });
}

/**
 * Steps in a row with the same title share one line ("✓ Read a file ×2"):
 * labels are coarse, so separate calls often read the same. A failure keeps
 * its own line, and the group shows the state of its newest step.
 */
export function groupSteps(steps: Step[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (last && last.title === step.title && last.state === 'done' && step.state !== 'failed') {
      last.count += 1;
      last.state = step.state;
      last.startedAt = step.startedAt;
    } else {
      groups.push({ title: step.title, state: step.state, count: 1, startedAt: step.startedAt });
    }
  }
  return groups;
}

/**
 * A running step on a live card reads in the present tense with its own
 * timer ("◉ Waiting for the checks · 1m 40s"), so a long command shows which
 * step is slow and that it's still going.
 */
function stepLine(g: StepGroup, nowMs: number, live: boolean): string {
  const count = g.count > 1 ? ` ×${g.count}` : '';
  // A step still running when the run ended was cut off: ◌, not the live ◉.
  if (g.state === 'running' && !live) return `${CUT_OFF_MARK} ${safeText(g.title)}${count}`;
  if (g.state !== 'running') return `${STEP_MARK[g.state]} ${safeText(g.title)}${count}`;
  const start = g.startedAt ? Date.parse(g.startedAt) : NaN;
  const timer = Number.isFinite(start) && nowMs - start >= 1000 ? ` · ${formatElapsed(nowMs - start)}` : '';
  return `${STEP_MARK.running} ${safeText(presentTense(g.title))}${count}${timer}`;
}

function stepLines(steps: Step[], earlier: number, nowMs: number, live: boolean): string {
  const groups = groupSteps(steps);
  const shown = groups.slice(-MAX_STEPS_SHOWN);
  const hidden = earlier + groups.slice(0, groups.length - shown.length).reduce((n, g) => n + g.count, 0);
  const lines = shown.map((g) => stepLine(g, nowMs, live));
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
  const stoppedBy = opts.stoppedBy;
  const interrupted = opts.interrupted === true || stoppedBy !== undefined;
  const live = !interrupted && (snapshot.status === 'running' || snapshot.status === 'waiting');
  const elapsed = formatElapsed(elapsedMs(snapshot, nowMs, live, stoppedBy !== undefined ? opts.stoppedAt : undefined));
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
    else if (steps.length > 0) lines.push(stepLines(steps, snapshot.earlierSteps, nowMs, live));
    else if (snapshot.statusText) lines.push(safeText(snapshot.statusText));
  } else if (snapshot.status === 'done' && !interrupted) {
    // Collapsed: the answer below says the rest.
    lines.push(`✅ Done in ${elapsed} · ${plural(total, 'step')}`);
  } else {
    const head =
      stoppedBy !== undefined
        ? `⏹️ *Stopped* by ${safeText(stoppedBy)} after ${elapsed} · ${plural(total, 'step')}`
        : interrupted
          ? `⏹️ *Interrupted* after ${elapsed} · the agent stopped before finishing`
          : snapshot.status === 'failed'
            ? `❌ *Failed* after ${elapsed} · ${plural(total, 'step')}${failed > 0 ? `, ${failed} failed` : ''}`
            : `⏹️ *Stopped* after ${elapsed} · ${plural(total, 'step')}`;
    lines.push(head);
    if (steps.length > 0) lines.push(stepLines(steps, snapshot.earlierSteps, nowMs, live));
  }

  const fallbackText = lines.join('\n');
  const card: RenderedCard['content']['card'] = { title: '', children: lines.map(muted) };
  if (live) card.stopButton = { id: STOP_ACTION_ID, label: 'Stop' };
  return {
    content: { type: 'card', card, fallbackText },
    fingerprint: fallbackText,
  };
}
