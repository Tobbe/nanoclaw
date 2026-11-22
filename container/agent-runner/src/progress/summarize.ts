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

/** Starts of a command segment: line start or after a shell separator. */
const SEG = String.raw`(^|[;&|(]\s*|&&\s*|\|\|\s*)`;

/** `git` plus any global options (`-C dir`, `--no-pager`) before the subcommand. */
const GIT = String.raw`\bgit\s+(?:-\S+(?:\s+(?!-)\S+)?\s+)*?`;
const git = (sub: string) => new RegExp(`${GIT}(${sub})\\b`);

/** git/gh subcommands → a fixed, specific label. First match wins. */
const GIT_LABELS: Array<[RegExp, string]> = [
  [git('clone'), 'Cloned a repository'],
  [git('commit'), 'Committed changes'],
  [git('push'), 'Pushed changes'],
  [git('pull|fetch'), 'Pulled the latest changes'],
  [git('checkout|switch'), 'Switched branches'],
  [git('diff|status'), 'Checked what changed'],
  [git('log|show|blame'), 'Looked at the history'],
  // Listing (`git branch -a`), not switching; agents create branches with checkout/switch.
  [git('branch|ls-tree|ls-files'), 'Looked at the branches and files'],
  [git('add|rm|mv|restore|stash|reset'), 'Staged changes'],
  [git('config|init|remote'), 'Set up git'],
  [/\bgh\s+pr\s+create\b/, 'Opened a pull request'],
  [/\bgh\s+pr\s+comment\b/, 'Commented on a pull request'],
  [/\bgh\s+run\s+watch\b/, 'Waited for the checks'],
  [/\bgh\s+pr\b/, 'Worked on a pull request'],
  [/\bgh\s+issue\b/, 'Looked at issues'],
];

/**
 * Everyday shell commands → a fixed label. The command that comes first in
 * the line wins: `grep … ; head …` is a search, not a read.
 */
const SHELL_LABELS: Array<[RegExp, StepSummary]> = [
  // NanoClaw's own `ncl`: what it reads or does, never the question or ids
  // asked. The more specific label comes first; at the same position the
  // earlier pattern wins.
  [new RegExp(`${SEG}ncl\\s+sessions\\s+recall\\b`), { title: 'Searched the thread records', category: 'inspect' }],
  [new RegExp(`${SEG}ncl\\s+sessions\\s+search\\b`), { title: 'Searched past messages', category: 'inspect' }],
  [new RegExp(`${SEG}ncl\\s+sessions\\s+history\\b`), { title: 'Read a thread', category: 'inspect' }],
  [new RegExp(`${SEG}ncl\\s+sessions\\s+records\\b`), { title: 'Read the thread records', category: 'inspect' }],
  [new RegExp(`${SEG}ncl\\s+sessions\\s+file\\b`), { title: 'Fetched a file from a thread', category: 'inspect' }],
  [new RegExp(`${SEG}ncl\\s+sessions\\s+backfill-records\\b`), { title: 'Wrote thread records', category: 'run' }],
  [new RegExp(`${SEG}ncl\\s+sessions\\b`), { title: 'Looked through the threads', category: 'inspect' }],
  [new RegExp(`${SEG}ncl\\s+tasks\\s+(create|update)\\b`), { title: 'Scheduled a task', category: 'run' }],
  [new RegExp(`${SEG}ncl\\s+tasks\\b`), { title: 'Checked scheduled tasks', category: 'inspect' }],
  [new RegExp(`${SEG}ncl\\b`), { title: 'Ran a NanoClaw command', category: 'run' }],
  [new RegExp(`${SEG}(ls|tree|find|fd)\\b`), { title: 'Looked through the files', category: 'inspect' }],
  [new RegExp(`${SEG}(cat|head|tail|less|wc|sed\\s+-n)\\b`), { title: 'Read a file', category: 'inspect' }],
  [new RegExp(`${SEG}(grep|rg|ag)\\b`), { title: 'Searched the code', category: 'inspect' }],
  [new RegExp(`${SEG}(curl|wget)\\b`), { title: 'Fetched from the web', category: 'web' }],
  [new RegExp(`${SEG}(mkdir|cp|mv|rm|touch|ln)\\b`), { title: 'Organized files', category: 'edit' }],
  [new RegExp(`${SEG}(python3?|node|bun|deno|tsx|ruby|bash|sh)\\s+\\S`), { title: 'Ran a script', category: 'run' }],
];

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

/**
 * Steps that change something, as opposed to looking around. A command that
 * chains several (build, commit, push, open a PR, wait for CI) gets all of
 * them in its label, in order; a chain of look-arounds keeps one label.
 */
/** Checking work in a browser: the preview server and agent-browser. First match wins. */
const PREVIEW_LABELS: Array<[RegExp, string]> = [
  [/\bpkill\b.*\bstro\s+preview\b/, 'Stopped the preview'],
  [/(^|[\s;&|(])((yarn|npm|pnpm|bun)\s+(run\s+)?preview|astro\s+preview)\b/, 'Started the preview'],
  [/\bagent-browser\s+screenshot\b/, 'Took a screenshot'],
  [/\bagent-browser\s+(open|goto|navigate)\b/, 'Opened a page in the browser'],
];

const ACTION_TITLES = new Set([
  'Ran tests',
  'Ran a build',
  'Installed dependencies',
  'Cloned a repository',
  'Committed changes',
  'Pushed changes',
  'Opened a pull request',
  'Commented on a pull request',
  'Waited for the checks',
  'Started the preview',
  'Stopped the preview',
  'Took a screenshot',
  'Opened a page in the browser',
]);

/** One step of a chain: what a single command does, or null when it's not an action. */
function segmentAction(segment: string): string | null {
  for (const [pattern, title] of PREVIEW_LABELS) if (pattern.test(segment)) return title;
  if (TEST_COMMAND.test(segment)) return 'Ran tests';
  if (BUILD_COMMAND.test(segment)) return 'Ran a build';
  if (INSTALL_COMMAND.test(segment)) return 'Installed dependencies';
  if (!GIT_COMMAND.test(segment)) return null;
  for (const [pattern, title] of GIT_LABELS) {
    if (pattern.test(segment)) return ACTION_TITLES.has(title) ? title : null;
  }
  return null;
}

/** The actions a chained command performs, in order, without repeats. */
function chainedActions(command: string): string[] {
  // `a || b` runs b only when a fails: label what normally runs.
  const usual = command.split('||')[0];
  const actions: string[] = [];
  for (const segment of usual.split(/&&|;|\n/)) {
    // `git push … | tail -2`: what's after a pipe only reads the output.
    const action = segmentAction(segment.split('|')[0]);
    if (action && !actions.includes(action)) actions.push(action);
  }
  return actions;
}

/** "Committed and pushed changes, opened a pull request and waited for the checks". */
function joinActions(actions: string[]): string {
  const parts = [...actions];
  const commit = parts.indexOf('Committed changes');
  const push = parts.indexOf('Pushed changes');
  if (commit !== -1 && push !== -1) {
    parts[commit] = 'Committed and pushed changes';
    parts.splice(push, 1);
  }
  const lower = parts.map((p, i) => (i === 0 ? p : p[0].toLowerCase() + p.slice(1)));
  if (lower.length === 1) return lower[0];
  const last = lower[lower.length - 1];
  // "Ran a build, committed and pushed changes", not "… and committed and pushed …".
  return `${lower.slice(0, -1).join(', ')}${last.includes(' and ') ? ', ' : ' and '}${last}`;
}

/** Classify a shell command into a fixed label. The command itself is never returned. */
export function classifyCommand(command: string): StepSummary {
  const actions = chainedActions(command);
  if (actions.length > 0) {
    const category = actions.includes('Ran tests')
      ? 'test'
      : actions.every((a) => a === 'Took a screenshot' || a === 'Opened a page in the browser')
        ? 'inspect'
        : 'run';
    return { title: joinActions(actions), category };
  }
  if (TEST_COMMAND.test(command)) return { title: 'Ran tests', category: 'test' };
  if (BUILD_COMMAND.test(command)) return { title: 'Ran a build', category: 'run' };
  if (INSTALL_COMMAND.test(command)) return { title: 'Installed dependencies', category: 'run' };
  if (GIT_COMMAND.test(command)) {
    // `a || b` runs b only when a fails, so label what normally runs: "fetch
    // the clone, or clone it if missing" is a fetch, not a clone.
    const usual = command.split('||')[0];
    for (const part of [usual, command]) {
      for (const [pattern, title] of GIT_LABELS) if (pattern.test(part)) return { title, category: 'run' };
    }
    return { title: 'Used git', category: 'run' };
  }
  let first: { at: number; summary: StepSummary } | undefined;
  for (const [pattern, summary] of SHELL_LABELS) {
    const at = pattern.exec(command)?.index;
    if (at !== undefined && (!first || at < first.at)) first = { at, summary };
  }
  return first ? { ...first.summary } : { title: 'Ran a command', category: 'run' };
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
