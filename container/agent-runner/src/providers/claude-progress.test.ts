import { describe, expect, it } from 'bun:test';

import { ClaudeProgressTranslator } from './claude-progress.js';
import type { ProviderEvent } from './types.js';

function assistant(...content: unknown[]) {
  return { type: 'assistant', parent_tool_use_id: null, message: { content } };
}
function toolResult(id: string, isError = false) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  };
}
function details(events: ProviderEvent[]) {
  return events.map((e) => (e.type === 'progress' ? e.detail : undefined));
}

describe('ClaudeProgressTranslator', () => {
  it('turns tool_use into a running step and tool_result into done/failed', () => {
    const t = new ClaudeProgressTranslator();
    expect(
      details(
        t.translate(
          assistant(
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/src/app.ts' } },
          ),
        ),
      ),
    ).toEqual([{ kind: 'step', id: 'tu1', title: 'Read app.ts', state: 'running', category: 'inspect', tool: 'Read' }]);
    expect(details(t.translate(toolResult('tu1')))).toEqual([
      { kind: 'step', id: 'tu1', title: 'Read app.ts', state: 'done', category: 'inspect', tool: 'Read' },
    ]);
  });

  it('marks failed tool results', () => {
    const t = new ClaudeProgressTranslator();
    t.translate(assistant({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm test' } }));
    const [event] = t.translate(toolResult('b1', true));
    expect(event.type === 'progress' && event.detail).toMatchObject({ id: 'b1', state: 'failed', title: 'Ran tests' });
  });

  it('turns TodoWrite into a plan, using activeForm for the running item', () => {
    const t = new ClaudeProgressTranslator();
    const events = t.translate(
      assistant({
        type: 'tool_use',
        id: 'td1',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Find the headline', activeForm: 'Finding the headline', status: 'completed' },
            { content: 'Edit the headline', activeForm: 'Editing the headline', status: 'in_progress' },
            { content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
          ],
        },
      }),
    );
    expect(details(events)).toEqual([
      {
        kind: 'plan',
        items: [
          { title: 'Find the headline', state: 'done' },
          { title: 'Editing the headline', state: 'running' },
          { title: 'Run tests', state: 'pending' },
        ],
      },
    ]);
    // TodoWrite's own tool_result is bookkeeping — no step.
    expect(t.translate(toolResult('td1'))).toEqual([]);
  });

  it('signals waiting while ask_user_question is open', () => {
    const t = new ClaudeProgressTranslator();
    const events = t.translate(
      assistant({
        type: 'tool_use',
        id: 'q1',
        name: 'mcp__nanoclaw__ask_user_question',
        input: { title: 'Headline', question: 'Which headline should I use?', options: ['A', 'B'] },
      }),
    );
    expect(details(events)).toEqual([
      {
        kind: 'step',
        id: 'q1',
        title: 'Asked a question',
        state: 'running',
        category: 'ask',
        tool: 'mcp__nanoclaw__ask_user_question',
      },
      { kind: 'waiting', id: 'q1', on: 'question', summary: 'Which headline should I use?' },
    ]);
  });

  it('ignores subagent traffic, hidden tools and non-content messages', () => {
    const t = new ClaudeProgressTranslator();
    expect(
      t.translate({
        type: 'assistant',
        parent_tool_use_id: 'task-1',
        message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] },
      }),
    ).toEqual([]);
    expect(
      t.translate(assistant({ type: 'tool_use', id: 's', name: 'mcp__nanoclaw__send_message', input: {} })),
    ).toEqual([]);
    expect(t.translate(toolResult('s'))).toEqual([]);
    expect(t.translate({ type: 'system', subtype: 'init' })).toEqual([]);
    expect(t.translate({ type: 'result', result: 'x' })).toEqual([]);
  });
});
