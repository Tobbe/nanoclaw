import { describe, expect, it } from 'vitest';

import { formatElapsed, renderRunCard, safeText } from './render.js';
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

describe('renderRunCard', () => {
  it('shows a live plan with the latest step and the running elapsed time', () => {
    const r = renderRunCard(
      snap({
        plan: [
          { title: 'Found the landing page', state: 'done' },
          { title: 'Updating headline and button', state: 'running' },
          { title: 'Building preview', state: 'pending' },
        ],
        steps: [{ id: 't1', title: 'Edited index.astro', state: 'running', category: 'edit' }],
      }),
      START + 84_000,
    );
    expect(r.content.type).toBe('card');
    expect(r.content.card.title).toBe('⏳ Working on it · 1m 24s');
    expect(r.content.card.children).toEqual([
      '✓ Found the landing page\n◉ Updating headline and button\n○ Building preview',
      'Latest: Edited index.astro',
    ]);
    expect(r.content.fallbackText).toContain('Working on it');
  });

  it('lists recent steps when there is no plan, counting earlier ones', () => {
    const steps = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      id,
      title: `Step ${id}`,
      state: 'done' as const,
      category: 'inspect' as const,
    }));
    const r = renderRunCard(snap({ steps, earlierSteps: 2 }), START + 10_000);
    expect(r.content.card.children[0].split('\n')).toEqual([
      '… 3 earlier steps',
      '✓ Step b',
      '✓ Step c',
      '✓ Step d',
      '✓ Step e',
      '✓ Step f',
    ]);
  });

  it('shows the question while waiting', () => {
    const r = renderRunCard(
      snap({ status: 'waiting', waiting: { on: 'question', summary: 'Update the mobile headline too?' } }),
      START + 5_000,
    );
    expect(r.content.card.title).toBe('⏸️ Waiting for an answer · 5s');
    expect(r.content.card.children[0]).toBe('Question: Update the mobile headline too?');
  });

  it('freezes elapsed time at the end and adds a summary line', () => {
    const r = renderRunCard(
      snap({
        status: 'failed',
        steps: [
          { id: 'a', title: 'Ran tests', state: 'failed', category: 'test' },
          { id: 'b', title: 'Read app.ts', state: 'done', category: 'inspect' },
        ],
      }),
      START + 999_000,
    );
    expect(r.content.card.title).toBe('❌ Failed · 30s');
    expect(r.content.card.children.at(-1)).toBe('2 steps · 1 failed');
  });

  it('marks an interrupted run', () => {
    const r = renderRunCard(snap(), START + 60_000, { interrupted: true });
    expect(r.content.card.title).toBe('⏹️ Interrupted · 30s');
    expect(r.content.card.children.at(-1)).toContain('stopped before finishing');
  });

  it('shows a status line when a provider sends nothing structured', () => {
    expect(renderRunCard(snap({ statusText: 'status: thinking' }), START).content.card.children).toEqual([
      'status: thinking',
    ]);
  });

  it('keeps the title within the card limit', () => {
    const r = renderRunCard(snap({ status: 'waiting', waiting: { on: 'approval', summary: 'x' } }), START + 7_200_000);
    expect(r.content.card.title.length).toBeLessThanOrEqual(50);
  });
});
