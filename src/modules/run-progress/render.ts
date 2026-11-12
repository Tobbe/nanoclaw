/**
 * Run card rendering: a snapshot plus the current time → a display card
 * (`{ type: 'card', card, fallbackText }`, the same content shape `send_card`
 * uses, so every Chat SDK channel can post and edit it) with a plain-text
 * fallback for clients that can't show cards.
 *
 * Text that came from the agent (plan items, step titles, the waiting
 * summary) is untrusted: hidden characters are made visible and angle
 * brackets are swapped for look-alikes so a title can't become a Slack
 * mention (`<!channel>`) or link.
 */
import { escapeInvisibles } from '../../card-text.js';
import type { RunProgressSnapshot } from './snapshot.js';

const MAX_TITLE = 50;
const MAX_STEPS_SHOWN = 5;

export interface RenderOptions {
  /** Host closed the card itself: the run's container went away mid-run. */
  interrupted?: boolean;
}

export interface RenderedCard {
  /** JSON-serializable content for ChannelDeliveryAdapter.deliver (kind 'chat-sdk'). */
  content: { type: 'card'; card: { title: string; children: string[] }; fallbackText: string };
  /** Changes only when what people see changes — used to skip no-op edits. */
  fingerprint: string;
}

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

function headline(snapshot: RunProgressSnapshot, interrupted: boolean): string {
  if (interrupted) return '⏹️ Interrupted';
  switch (snapshot.status) {
    case 'running':
      return '⏳ Working on it';
    case 'waiting':
      return snapshot.waiting?.on === 'approval' ? '⏸️ Waiting for approval' : '⏸️ Waiting for an answer';
    case 'done':
      return '✅ Done';
    case 'failed':
      return '❌ Failed';
    case 'cancelled':
      return '⏹️ Stopped';
  }
}

function clipTitle(title: string): string {
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

export function renderRunCard(snapshot: RunProgressSnapshot, nowMs: number, opts: RenderOptions = {}): RenderedCard {
  const interrupted = opts.interrupted === true;
  const live = !interrupted && (snapshot.status === 'running' || snapshot.status === 'waiting');
  const title = clipTitle(`${headline(snapshot, interrupted)} · ${formatElapsed(elapsedMs(snapshot, nowMs, live))}`);

  const sections: string[] = [];

  if (live && snapshot.waiting) sections.push(`Question: ${safeText(snapshot.waiting.summary)}`);

  if (snapshot.plan.length > 0) {
    sections.push(snapshot.plan.map((item) => `${PLAN_MARK[item.state]} ${safeText(item.title)}`).join('\n'));
    const latest = snapshot.steps[snapshot.steps.length - 1];
    if (live && latest && !snapshot.waiting) sections.push(`Latest: ${safeText(latest.title)}`);
  } else if (snapshot.steps.length > 0) {
    const shown = snapshot.steps.slice(-MAX_STEPS_SHOWN);
    const hidden = snapshot.earlierSteps + (snapshot.steps.length - shown.length);
    const lines = shown.map((step) => `${STEP_MARK[step.state]} ${safeText(step.title)}`);
    if (hidden > 0) lines.unshift(`… ${hidden} earlier step${hidden === 1 ? '' : 's'}`);
    sections.push(lines.join('\n'));
  } else if (snapshot.statusText) {
    sections.push(safeText(snapshot.statusText));
  }

  if (!live) {
    const total = snapshot.steps.length + snapshot.earlierSteps;
    const failed = snapshot.steps.filter((s) => s.state === 'failed').length;
    const parts = [`${total} step${total === 1 ? '' : 's'}`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (interrupted) parts.push('the agent stopped before finishing');
    sections.push(parts.join(' · '));
  }

  const fallbackText = [title, ...sections].join('\n\n');
  return {
    content: { type: 'card', card: { title, children: sections }, fallbackText },
    fingerprint: fallbackText,
  };
}
