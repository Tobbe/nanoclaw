import { describe, expect, it } from 'vitest';

import { cardProblems } from '../../channels/card-parts.js';
import { formatElapsed, renderRunCard, safeText, visibleSteps } from './render.js';
import type { RunProgressSnapshot } from './snapshot.js';

const START = Date.parse('2026-11-12T10:00:00.000Z');

function snap(overrides: Partial<RunProgressSnapshot> = {}): RunProgressSnapshot {
  return {
    version: 1,
    runId: 'run-1',
    seq: 1,
    startedAt: new Date(START).toISOString(),
    updatedAt: new Date(START + 30_000).toISOString(),
    status: 'running',
    stage: 'inspect',
    plan: [],
    steps: [],
    earlierSteps: 0,
    waiting: null,
    statusText: null,
    ...overrides,
  };
}

type Step = RunProgressSnapshot['steps'][number];
const step = (id: string, title: string, state: Step['state'] = 'done'): Step => ({
  id,
  title,
  state,
  category: 'inspect',
});

/** The card's text lines, in order. */
const lines = (snapshot: RunProgressSnapshot, now = START + 10_000, interrupted = false) =>
  renderRunCard(snapshot, now, { interrupted }).content.card.children.map((c) => c.props.content);

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(45_400)).toBe('45s');
    expect(formatElapsed(84_000)).toBe('1m 24s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(3_725_000)).toBe('1h 02m');
  });
});

describe('safeText', () => {
  it('neutralizes Slack mention/link syntax and hidden characters', () => {
    expect(safeText('ping <!channel> and <https://evil.example|click>')).toBe(
      'ping ‹!channel› and ‹https://evil.example|click›',
    );
    expect(safeText('a‮b')).toBe('a\\u202eb');
    expect(safeText('  multi\n  line  ')).toBe('multi line');
  });
});

describe('visibleSteps', () => {
  it('drops a failure that a later step with the same title got past', () => {
    const steps = [
      step('a', 'Cloned a repository', 'failed'),
      step('b', 'Cloned a repository'),
      step('c', 'Ran tests', 'failed'),
    ];
    expect(visibleSteps(steps).map((s) => s.id)).toEqual(['b', 'c']);
  });
});

describe('renderRunCard', () => {
  it('is quiet: no header, only muted text parts', () => {
    const r = renderRunCard(snap({ steps: [step('a', 'Read README.md')] }), START + 12_000);
    expect(r.content.type).toBe('card');
    expect(r.content.card.title).toBe('');
    expect(r.content.card.children.every((c) => c.type === 'Text' && c.props.style === 'muted')).toBe(true);
    expect(cardProblems(r.content.card as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('shows a live plan under the status line', () => {
    const plan = [
      { title: 'Found the landing page', state: 'done' as const },
      { title: 'Updating headline and button', state: 'running' as const },
      { title: 'Building preview', state: 'pending' as const },
    ];
    expect(lines(snap({ plan, steps: [step('t1', 'Edited index.astro', 'running')] }), START + 84_000)).toEqual([
      '⏳ *Working on it* · 1m 24s',
      '✓ Found the landing page\n◉ Updating headline and button\n○ Building preview',
    ]);
  });

  it('shows the last few steps when there is no plan, counting earlier ones', () => {
    const steps = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => step(id, `Step ${id}`));
    steps[5] = step('f', 'Step f', 'running');
    expect(lines(snap({ steps, earlierSteps: 2 }))).toEqual([
      '⏳ *Working on it* · 10s',
      '+ 4 earlier steps\n✓ Step c\n✓ Step d\n✓ Step e\n◉ Step f',
    ]);
  });

  it('hides a retried failure while live', () => {
    const steps = [step('a', 'Cloned a repository', 'failed'), step('b', 'Cloned a repository')];
    expect(lines(snap({ steps }))[1]).toBe('✓ Cloned a repository');
  });

  it('only says it is waiting: the question is already on screen', () => {
    const waiting = { on: 'question' as const, summary: 'Update the mobile headline too?' };
    const asked = [step('q', 'Asked a question', 'running')];
    expect(lines(snap({ status: 'waiting', waiting, steps: asked }), START + 5_000)).toEqual([
      '⏸️ *Waiting for your answer* · 5s',
    ]);
    const approval = { on: 'approval' as const, summary: 'Deploy?' };
    expect(lines(snap({ status: 'waiting', waiting: approval }))[0]).toBe('⏸️ *Waiting for approval* · 10s');
  });

  it('collapses to one line when done, with the elapsed time frozen', () => {
    const steps = [step('a', 'Used git', 'failed'), step('b', 'Used git'), step('c', 'Read README.md')];
    expect(lines(snap({ status: 'done', steps }), START + 999_000)).toEqual(['✅ Done in 30s · 3 steps']);
  });

  it('keeps recent steps on a failed card', () => {
    const steps = [step('a', 'Ran tests', 'failed'), step('b', 'Read app.ts')];
    expect(lines(snap({ status: 'failed', steps }), START + 999_000)).toEqual([
      '❌ *Failed* after 30s · 2 steps, 1 failed',
      '✗ Ran tests\n✓ Read app.ts',
    ]);
  });

  it('marks stopped and interrupted runs', () => {
    expect(lines(snap({ status: 'cancelled', steps: [step('a', 'Read a.ts')] }))[0]).toBe(
      '⏹️ *Stopped* after 30s · 1 step',
    );
    expect(lines(snap(), START + 60_000, true)).toEqual([
      '⏹️ *Interrupted* after 30s · the agent stopped before finishing',
    ]);
  });

  it('shows a status line when a provider sends nothing structured', () => {
    expect(lines(snap({ statusText: 'status: thinking' }), START)).toEqual([
      '⏳ *Working on it* · 0s',
      'status: thinking',
    ]);
  });

  it('uses the same text as the plain fallback', () => {
    const r = renderRunCard(snap({ steps: [step('a', 'Read README.md')] }), START + 3_000);
    expect(r.content.fallbackText).toBe('⏳ *Working on it* · 3s\n✓ Read README.md');
    expect(r.fingerprint).toBe(r.content.fallbackText);
  });
});
