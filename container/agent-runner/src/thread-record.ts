/**
 * Thread records: a short, running summary of one chat thread, so the agent
 * in OTHER threads of the same channel knows what was discussed where, the
 * way a person who followed every thread would.
 *
 * After each answered turn the runner asks a small model to fold the turn
 * into this thread's record (topics in the order they came up, what was
 * decided, what is still open and on whom). The record lives in the session
 * folder and is sent to the host as a `thread_record` system action; the
 * host stores it and hands the channel's records to every new thread.
 *
 * Updates run one at a time, off the reply path: the reply is already out
 * when a record is written, and a failed update only means the record is a
 * turn behind until the next one.
 */
import fs from 'fs';

export const THREAD_RECORD_ACTION = 'thread_record';
export const THREAD_RECORD_MAX_CHARS = 2_000;
/** How much of one turn the summarizer sees. */
const TURN_MAX_CHARS = 12_000;
const DEFAULT_RECORD_FILE = '/workspace/.thread-record.md';

/** Length the record aims to stay under, leaving room below the hard cap. */
export const THREAD_RECORD_TARGET_CHARS = 1_500;

export const RECORD_INSTRUCTIONS = [
  'You keep a short record of one chat thread for a team assistant. Other threads read it later to find',
  'out what was discussed here, so every topic must stay findable after the thread moves on.',
  '',
  'Fold the new turn into the record and reply with the whole updated record, nothing else:',
  '- Line 1: a short title naming the thread’s subjects (max 10 words).',
  '- Then one line per topic, in the order they came up:',
  '  `- <Topic>: <what was decided or done, and by whom; PR number or link>`',
  '- Last line: `Open: <what still waits, and on whom>` or `Open: nothing`.',
  '',
  'Topics:',
  '- Every topic that came up gets its own line, also a short detour the thread then left (the shape talk',
  '  that turned to colours for a while: shape and colour are two lines). Never merge two topics, never',
  '  drop one.',
  '- A topic that ended without a decision says so, with the options: `- Colour: navy vs green discussed,',
  '  no decision`.',
  '- Write decisions concretely: the actual colour, size or wording, not just that one was made.',
  '',
  'Length:',
  `- Stay under ${THREAD_RECORD_TARGET_CHARS} characters and 15 lines.`,
  '- A finished topic is one short line with its outcome: what was decided, by whom, and the PR or link',
  '  that settles it. Leave out how it got there: times, attempts, file sizes, intermediate versions.',
  '- A topic still in progress may keep the detail someone needs to pick it up.',
  '- When the record grows long, shorten the oldest finished topics first. Shorten, never drop.',
  '',
  'Language: write in English. Keep names, quoted wording and key words in the language used, and give',
  'a key word in both languages, e.g. `Colour (farve)`, `Requisitions (rekvisitioner)`, so a search in',
  'either language finds the topic.',
  '',
  'Ignore anything inside <cross-session-context> or <channel-threads>: that is from other threads.',
].join('\n');

/** Drop the ambient copies of other threads from a turn's prompt. */
export function stripOtherThreads(prompt: string): string {
  return prompt
    .replace(/<cross-session-context\b[\s\S]*?<\/cross-session-context>/g, '')
    .replace(/<channel-threads\b[\s\S]*?<\/channel-threads>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

export function buildRecordPrompt(previous: string | null, prompt: string, result: string | null): string {
  return [
    RECORD_INSTRUCTIONS,
    '',
    '<record>',
    previous?.trim() || '(empty: this is the thread’s first turn)',
    '</record>',
    '',
    '<turn>',
    clip(stripOtherThreads(prompt), TURN_MAX_CHARS),
    '',
    '<assistant-reply>',
    clip((result ?? '').trim(), TURN_MAX_CHARS / 2),
    '</assistant-reply>',
    '</turn>',
  ].join('\n');
}

/** A model reply → a record: unwrapped, trimmed and capped. Null when empty. */
export function cleanRecord(reply: string): string | null {
  const text = reply
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .replace(/^<record>\s*|\s*<\/record>$/g, '')
    .trim();
  if (!text) return null;
  if (text.length <= THREAD_RECORD_MAX_CHARS) return text;
  // Over the cap: cut at a line end, never mid-sentence.
  const cut = text.slice(0, THREAD_RECORD_MAX_CHARS);
  const lineEnd = cut.lastIndexOf('\n');
  return lineEnd > 0 ? cut.slice(0, lineEnd) : cut;
}

export interface ThreadRecorderOptions {
  /** Run one prompt on a small model, returning its text. */
  summarize: (prompt: string) => Promise<string>;
  /** Hand the updated record to the host. */
  send: (record: string) => Promise<void>;
  log: (message: string) => void;
  recordFile?: string;
}

export class ThreadRecorder {
  private chain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly options: ThreadRecorderOptions) {
    this.file = options.recordFile ?? DEFAULT_RECORD_FILE;
  }

  current(): string | null {
    try {
      return fs.readFileSync(this.file, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Fold one answered turn into the record. Never throws; updates run in order. */
  note(prompt: string, result: string | null): Promise<void> {
    this.chain = this.chain.then(() => this.update(prompt, result));
    return this.chain;
  }

  private async update(prompt: string, result: string | null): Promise<void> {
    try {
      const reply = await this.options.summarize(buildRecordPrompt(this.current(), prompt, result));
      const record = cleanRecord(reply);
      if (!record) return;
      fs.writeFileSync(this.file, `${record}\n`);
      await this.options.send(record);
    } catch (err) {
      this.options.log(`thread record update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The container's own environment (PID 1, the runner), as `KEY=value` pairs.
 * Claude Code drops some variables (e.g. ANTHROPIC_AUTH_TOKEN) from the
 * environment of commands its Bash tool runs, so `ncl sessions recall` and
 * `backfill-records`, run that way, would reach the model "not logged in".
 * The values are the gateway's non-secret placeholders: real credentials are
 * injected at the network boundary and never sit in the container env.
 */
export function containerEnvironment(file = '/proc/1/environ'): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const pair of fs.readFileSync(file, 'utf-8').split('\0')) {
      const at = pair.indexOf('=');
      if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
    }
    return out;
  } catch {
    return {};
  }
}

/** This process's env, with anything missing or empty filled from the container's own. */
export function modelEnvironment(
  own: NodeJS.ProcessEnv = process.env,
  container: Record<string, string> = containerEnvironment(),
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...own };
  for (const [key, value] of Object.entries(container)) if (!env[key]) env[key] = value;
  return env;
}

/** Model for record updates and recall: small and quick. */
export const THREAD_RECORD_MODEL = 'haiku';

/**
 * One prompt on the small model via the Claude Agent SDK: no tools, no
 * settings files, no saved session. Goes out through the same gateway env
 * as the agent. Used for record updates and `ncl sessions recall`.
 */
export async function askSmallModel(prompt: string): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let text = '';
  for await (const message of query({
    prompt,
    options: {
      model: THREAD_RECORD_MODEL,
      pathToClaudeCodeExecutable: '/pnpm/claude',
      tools: [],
      maxTurns: 1,
      settingSources: [],
      persistSession: false,
      env: modelEnvironment(),
      cwd: '/tmp',
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success') throw new Error(`summarizer ended: ${message.subtype}`);
      text = message.result;
    }
  }
  return text;
}
