/**
 * Safe, human-readable summaries of tool calls for run progress.
 *
 * This is the privacy boundary for progress: a summary is built only from an
 * allowlist of inputs — the tool name, a file's basename, a URL's hostname, a
 * skill name — never from a raw command, a full path, file contents or tool
 * output. Bash commands are classified (tests / build / git / other) and shown
 * as a fixed label.
 */
import type { StepCategory } from './types.js';

export type ProgressDetailLevel = 'concise' | 'detailed';

export interface StepSummary {
  title: string;
  category: StepCategory;
}

/** MCP tools that are the agent talking, not working — never shown as steps. */
const HIDDEN_NANOCLAW_TOOLS = new Set(['send_message', 'edit_message', 'add_reaction', 'send_card', 'send_file']);

/** Builtins that are bookkeeping, not progress. TodoWrite becomes the plan instead. */
const HIDDEN_BUILTINS = new Set(['TodoWrite', 'ToolSearch', 'TaskStop']);

const TEST_COMMAND =
  /(^|[\s;&|(])((npx|pnpm|npm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b|vitest\b|jest\b|pytest\b|bun\s+test\b|go\s+test\b|cargo\s+test\b|playwright\s+test\b|rspec\b|phpunit\b|mix\s+test\b)/;
const BUILD_COMMAND =
  /(^|[\s;&|(])((npx|pnpm|npm|yarn|bun)\s+(run\s+)?(build|typecheck|lint|tsc)\b|tsc\b|cargo\s+build\b|go\s+build\b|make\b|docker\s+build\b)/;
const GIT_COMMAND = /(^|[\s;&|(])(git|gh)\s/;
const INSTALL_COMMAND = /(^|[\s;&|(])((pnpm|npm|yarn|bun)\s+(install|add|i)\b|pip\s+install\b|apt(-get)?\s+install\b)/;

const MAX_NAME = 60;

function str(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function clip(text: string, max = MAX_NAME): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Last path segment only — never the directory structure. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return clip(parts[parts.length - 1] ?? p);
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Classify a shell command into a fixed label. The command itself is never returned. */
export function classifyCommand(command: string): StepSummary {
  if (TEST_COMMAND.test(command)) return { title: 'Ran tests', category: 'test' };
  if (BUILD_COMMAND.test(command)) return { title: 'Ran a build', category: 'run' };
  if (INSTALL_COMMAND.test(command)) return { title: 'Installed dependencies', category: 'run' };
  if (GIT_COMMAND.test(command)) return { title: 'Used git', category: 'run' };
  return { title: 'Ran a command', category: 'run' };
}

/**
 * Summarize one tool call. Returns null for tools that should not appear as a
 * step (messaging tools, bookkeeping). In `detailed` mode a Bash call uses the
 * model's own one-line `description` of the command, when given, instead of
 * the fixed label — still never the command itself.
 */
export function summarizeStep(
  tool: string,
  input: unknown,
  level: ProgressDetailLevel = 'concise',
): StepSummary | null {
  if (HIDDEN_BUILTINS.has(tool)) return null;

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  if (mcp) {
    const [, server, name] = mcp;
    if (server === 'nanoclaw') {
      if (HIDDEN_NANOCLAW_TOOLS.has(name)) return null;
      if (name === 'ask_user_question') return { title: 'Asked a question', category: 'ask' };
      return { title: `Used ${clip(name.replace(/_/g, ' '))}`, category: 'other' };
    }
    return { title: `Used ${clip(server)}: ${clip(name.replace(/_/g, ' '))}`, category: 'other' };
  }

  switch (tool) {
    case 'Read': {
      const file = str(input, 'file_path');
      return { title: file ? `Read ${basename(file)}` : 'Read a file', category: 'inspect' };
    }
    case 'Grep':
      return { title: 'Searched the code', category: 'inspect' };
    case 'Glob':
      return { title: 'Listed files', category: 'inspect' };
    case 'Edit': {
      const file = str(input, 'file_path');
      return { title: file ? `Edited ${basename(file)}` : 'Edited a file', category: 'edit' };
    }
    case 'Write': {
      const file = str(input, 'file_path');
      return { title: file ? `Wrote ${basename(file)}` : 'Wrote a file', category: 'edit' };
    }
    case 'NotebookEdit': {
      const file = str(input, 'notebook_path');
      return { title: file ? `Edited ${basename(file)}` : 'Edited a notebook', category: 'edit' };
    }
    case 'Bash': {
      const command = str(input, 'command') ?? '';
      const classified = classifyCommand(command);
      const description = str(input, 'description');
      if (level === 'detailed' && description) return { title: clip(description, 80), category: classified.category };
      return classified;
    }
    case 'WebSearch':
      return { title: 'Searched the web', category: 'web' };
    case 'WebFetch': {
      const url = str(input, 'url');
      const host = url ? hostname(url) : undefined;
      return { title: host ? `Read a page on ${clip(host)}` : 'Read a web page', category: 'web' };
    }
    case 'Task':
    case 'Agent':
      return { title: 'Delegated to a subagent', category: 'delegate' };
    case 'Skill': {
      const skill = str(input, 'skill') ?? str(input, 'name');
      return { title: skill ? `Used skill ${clip(skill)}` : 'Used a skill', category: 'other' };
    }
    default:
      return { title: `Used ${clip(tool)}`, category: 'other' };
  }
}
