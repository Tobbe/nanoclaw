/**
 * Thread records: a short, running summary of one chat thread, so the agent
 * in OTHER threads of the same channel knows what was discussed where, the
 * way a person who followed every thread would.
 *
 * After each answered turn the runner asks a small model to fold this
 * thread's new messages into its record (topics in the order they came up,
 * what was decided, what is still open and on whom). The new messages are
 * read from the session's own mailbox, after a cursor of the last ones the
 * record covers, so a message no turn handled (accumulated context, a failed
 * turn, a failed update) still reaches the record at the next update. The
 * record lives in the session folder and is sent to the host as a
 * `thread_record` system action with that cursor; the host stores both,
 * shows any messages newer than the cursor alongside the record, and hands
 * the channel's records to every new thread.
 *
 * Updates run one at a time, off the reply path: the reply is already out
 * when a record is written.
 */
import fs from 'fs';

import type { ChatCursor, InboundMessage, OutboundMessage } from './mailbox/types.js';

export const THREAD_RECORD_ACTION = 'thread_record';
export const THREAD_RECORD_MAX_CHARS = 2_000;
/** How much of one turn the summarizer sees. */
const TURN_MAX_CHARS = 12_000;
const DEFAULT_RECORD_FILE = '/workspace/.thread-record.md';
/** Messages per direction one update reads; after a longer gap it keeps the newest. */
export const CHAT_SINCE_LIMIT = 200;

/** Length the record aims to stay under, leaving room below the hard cap. */
export const THREAD_RECORD_TARGET_CHARS = 1_500;

export const RECORD_INSTRUCTIONS = [
  'You keep a short record of one chat thread for a team assistant. Other threads read it later to find',
  'out what was discussed here, so every topic must stay findable after the thread moves on.',
  '',
  'Fold the new turn or messages into the record and reply with the whole updated record, nothing else:',
  '- Line 1: a short title naming the thread’s subjects (max 10 words).',
  '- Then one line per topic, in the order they came up:',
  '  `- <Topic>: <what was decided or done, and by whom; PR number or link>`',
  '- Last line: `Open: <what still waits, and on whom>` or `Open: nothing`.',
  '',
  'Topics:',
  '- Every topic that came up gets its own line, also a short detour the thread then left (the shape talk',
  '  that turned to colors for a while: shape and color are two lines). Never merge two topics, never',
  '  drop one.',
  '- A topic that ended without a decision says so, with the options: `- Color: navy vs green discussed,',
  '  no decision`.',
  '- Write decisions concretely: the actual color, size or wording, not just that one was made.',
  '',
  'Length:',
  `- Stay under ${THREAD_RECORD_TARGET_CHARS} characters and 15 lines.`,
  '- A finished topic is one short line with its outcome: what was decided, by whom, and the PR or link',
  '  that settles it. Leave out how it got there: times, attempts, file sizes, intermediate versions.',
  '- A topic still in progress may keep the detail someone needs to pick it up.',
  '- When the record grows long, shorten the oldest finished topics first. Shorten, never drop.',
  '',
  'Language: write in American English (color, gray, center, organize). Keep names, quoted wording and key',
  'words in the language used, and give a key word in both languages, e.g. `Color (farve)`,',
  '`Requisitions (rekvisitioner)`, so a search in either language finds the topic.',
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

export interface TranscriptRow {
  timestamp: string;
  direction: 'in' | 'out';
  kind: string;
  sender: string;
  text: string;
  ambient?: boolean;
}

/** A thread's own chat lines, oldest first: no ambient copies, no system rows. */
export function transcriptLines(rows: TranscriptRow[]): string[] {
  return rows
    .filter((r) => !r.ambient && r.text.trim() && (r.kind === 'chat' || r.kind === 'chat-sdk'))
    .map(
      (r) =>
        `[${r.timestamp.slice(0, 16).replace('T', ' ')}] ${r.direction === 'out' ? 'you' : r.sender || 'someone'}: ${r.text.trim()}`,
    );
}

function messageText(content: string): { text: string; sender: string; ambient: boolean } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      sender: typeof parsed.sender === 'string' ? parsed.sender : '',
      ambient: parsed.echo !== undefined,
    };
  } catch {
    return { text: content, sender: '', ambient: false };
  }
}

/** Channel types that carry copies from elsewhere, never this thread's own messages. */
const NOT_THIS_THREAD = new Set(['session-echo', 'agent']);

/**
 * A session's chat rows → this thread's transcript rows, oldest first, and
 * the cursor past every row read (skipped ones too, so they aren't read again).
 */
export function chatTranscript(
  chat: { inbound: InboundMessage[]; outbound: OutboundMessage[] },
  after: ChatCursor,
): { rows: TranscriptRow[]; through: ChatCursor } {
  const through = { ...after };
  const rows: TranscriptRow[] = [];
  for (const m of chat.inbound) {
    through.inbound = Math.max(through.inbound, m.sequence ?? 0);
    if (m.channelType && NOT_THIS_THREAD.has(m.channelType)) continue;
    const { text, sender, ambient } = messageText(m.content);
    rows.push({ timestamp: m.timestamp, direction: 'in', kind: m.kind, sender, text, ...(ambient ? { ambient } : {}) });
  }
  for (const m of chat.outbound) {
    through.outbound = Math.max(through.outbound, m.sequence ?? 0);
    rows.push({
      timestamp: m.timestamp,
      direction: 'out',
      kind: m.kind,
      sender: '',
      text: messageText(m.content).text,
    });
  }
  rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return { rows, through };
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
  /** Hand the updated record to the host, with the cursor of the last messages it covers. */
  send: (record: string, covered: ChatCursor | null) => Promise<void>;
  /**
   * This thread's chat after a cursor (the mailbox's `getChatSince`). Null or
   * absent: each turn's own prompt is folded instead.
   */
  readChat?: (after: ChatCursor) => { rows: TranscriptRow[]; through: ChatCursor } | null;
  log: (message: string) => void;
  recordFile?: string;
}

const START: ChatCursor = { inbound: 0, outbound: 0 };

export class ThreadRecorder {
  private chain: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly cursorFile: string;

  constructor(private readonly options: ThreadRecorderOptions) {
    this.file = options.recordFile ?? DEFAULT_RECORD_FILE;
    this.cursorFile = `${this.file}.cursor.json`;
  }

  /** The last messages the record covers; null before the first chat-based update. */
  cursor(): ChatCursor | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cursorFile, 'utf-8')) as Partial<ChatCursor>;
      if (typeof parsed.inbound === 'number' && typeof parsed.outbound === 'number') {
        return { inbound: parsed.inbound, outbound: parsed.outbound };
      }
    } catch {
      /* none yet */
    }
    return null;
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
      const previous = this.current();
      const cursor = this.cursor();
      let turn = prompt;
      let reply = result;
      let through: ChatCursor | null = null;
      // A record from before cursors existed folds this turn as it always
      // did, then starts counting; anything else reads the stored messages.
      const chat = cursor || !previous ? this.options.readChat?.(cursor ?? START) : null;
      if (chat) {
        const lines = transcriptLines(chat.rows);
        if (lines.length === 0) {
          // Nothing new (an earlier update this turn already folded it).
          if (!cursor || chat.through.inbound !== cursor.inbound || chat.through.outbound !== cursor.outbound) {
            this.saveCursor(chat.through);
          }
          return;
        }
        turn = `<new-messages>\n${lines.join('\n')}\n</new-messages>`;
        reply = null;
        through = chat.through;
      } else if (this.options.readChat) {
        through = this.options.readChat(START)?.through ?? null;
      }
      const record = cleanRecord(await this.options.summarize(buildRecordPrompt(previous, turn, reply)));
      if (!record) return;
      fs.writeFileSync(this.file, `${record}\n`);
      await this.options.send(record, through);
      if (through) this.saveCursor(through);
    } catch (err) {
      this.options.log(`thread record update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private saveCursor(cursor: ChatCursor): void {
    fs.writeFileSync(this.cursorFile, `${JSON.stringify(cursor)}\n`);
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
