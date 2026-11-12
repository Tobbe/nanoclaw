/**
 * Claude SDK messages → structured progress events.
 *
 * Kept out of claude.ts so it is a pure, directly testable translation:
 *   - assistant `tool_use` block      → step running (or plan, for TodoWrite;
 *                                       plus waiting, for ask_user_question)
 *   - user `tool_result` block        → that step done / failed
 * Subagent traffic (messages with a `parent_tool_use_id`) is folded into the
 * parent's "Delegated to a subagent" step and not shown on its own.
 */
import { summarizeStep, type ProgressDetailLevel } from '../progress/summarize.js';
import type { PlanItem, PlanItemState, StepCategory } from '../progress/types.js';
import type { ProviderEvent } from './types.js';

const ASK_QUESTION_TOOL = 'mcp__nanoclaw__ask_user_question';
const MAX_PLAN_ITEMS = 20;
const MAX_PLAN_TITLE = 80;
const MAX_QUESTION_SUMMARY = 120;

interface OpenStep {
  title: string;
  category: StepCategory;
  tool: string;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function planState(status: unknown): PlanItemState {
  if (status === 'completed') return 'done';
  if (status === 'in_progress') return 'running';
  return 'pending';
}

function planFromTodoWrite(input: unknown): PlanItem[] | null {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return null;
  const items: PlanItem[] = [];
  for (const todo of todos.slice(0, MAX_PLAN_ITEMS)) {
    const t = todo as { content?: unknown; activeForm?: unknown; status?: unknown };
    const state = planState(t.status);
    // A running item reads better in its present-continuous form when given.
    const raw = state === 'running' && typeof t.activeForm === 'string' ? t.activeForm : t.content;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    items.push({ title: clip(raw, MAX_PLAN_TITLE), state });
  }
  return items;
}

function questionSummary(input: unknown): string {
  const i = (input ?? {}) as { title?: unknown; question?: unknown };
  const text = typeof i.question === 'string' ? i.question : typeof i.title === 'string' ? i.title : '';
  return text ? clip(text, MAX_QUESTION_SUMMARY) : 'Waiting for an answer';
}

function progress(message: string, detail: Extract<ProviderEvent, { type: 'progress' }>['detail']): ProviderEvent {
  return { type: 'progress', message, detail };
}

export class ClaudeProgressTranslator {
  private readonly open = new Map<string, OpenStep>();

  constructor(private readonly level: ProgressDetailLevel = 'concise') {}

  /** Progress events for one SDK message (empty for messages that carry none). */
  translate(message: unknown): ProviderEvent[] {
    const m = message as { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } };
    if (m.type !== 'assistant' && m.type !== 'user') return [];
    if (m.parent_tool_use_id) return [];
    const content = m.message?.content;
    if (!Array.isArray(content)) return [];

    const events: ProviderEvent[] = [];
    for (const block of content as ContentBlock[]) {
      if (m.type === 'assistant' && block.type === 'tool_use' && block.id && block.name) {
        events.push(...this.onToolUse(block.id, block.name, block.input));
      } else if (m.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
        events.push(...this.onToolResult(block.tool_use_id, block.is_error === true));
      }
    }
    return events;
  }

  private onToolUse(id: string, tool: string, input: unknown): ProviderEvent[] {
    if (tool === 'TodoWrite') {
      const items = planFromTodoWrite(input);
      return items ? [progress(`Plan: ${items.length} item(s)`, { kind: 'plan', items })] : [];
    }

    const summary = summarizeStep(tool, input, this.level);
    if (!summary) return [];
    this.open.set(id, { ...summary, tool });

    const events: ProviderEvent[] = [
      progress(summary.title, {
        kind: 'step',
        id,
        title: summary.title,
        state: 'running',
        category: summary.category,
        tool,
      }),
    ];
    if (tool === ASK_QUESTION_TOOL) {
      const text = questionSummary(input);
      events.push(progress(`Waiting: ${text}`, { kind: 'waiting', id, on: 'question', summary: text }));
    }
    return events;
  }

  private onToolResult(id: string, isError: boolean): ProviderEvent[] {
    const step = this.open.get(id);
    if (!step) return [];
    this.open.delete(id);
    const state = isError ? 'failed' : 'done';
    return [
      progress(`${step.title} (${state})`, {
        kind: 'step',
        id,
        title: step.title,
        state,
        category: step.category,
        tool: step.tool,
      }),
    ];
  }
}
