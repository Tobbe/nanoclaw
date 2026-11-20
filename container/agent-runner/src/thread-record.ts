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

export const RECORD_INSTRUCTIONS = [
  'You keep a short record of one chat thread for a team assistant. Other threads read it later to find',
  'out what was discussed here, so every topic must stay findable after the thread moves on.',
  '',
  'Fold the new turn into the record and reply with the whole updated record, nothing else:',
  '- Line 1: a short title naming the thread’s subjects (max 10 words).',
  '- Then one line per topic, in the order they came up:',
  '  `- <Topic>: <what was asked, decided or done, and by whom; PR numbers and preview links>`',
  '  Keep every topic, also finished ones. Update a topic’s line instead of adding a second one.',
  '  Write down decisions concretely (the actual colour, size, wording), not just that one was made.',
  '- Last line: `Open: <what still waits, and on whom>` or `Open: nothing`.',
  'Write in English, but keep names, quoted wording and key words in the language used (fx "farve",',
  '"rekvisition"), so a search in either language finds them. At most 15 lines.',
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
  return text.length <= THREAD_RECORD_MAX_CHARS ? text : text.slice(0, THREAD_RECORD_MAX_CHARS);
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

/** Model for record updates: small and quick, the record is a few lines. */
export const THREAD_RECORD_MODEL = 'haiku';

/**
 * One-shot summarizer on the Claude Agent SDK: no tools, no settings files,
 * no saved session. Goes out through the same gateway env as the agent.
 */
export async function summarizeWithClaude(prompt: string): Promise<string> {
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
      env: { ...process.env },
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
