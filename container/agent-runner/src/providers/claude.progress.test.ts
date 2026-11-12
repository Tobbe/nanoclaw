import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ClaudeProvider must surface tool activity as structured `progress` events
// (via ClaudeProgressTranslator) without changing any of the events it
// already emitted. Deleting the translator call in claude.ts goes red here.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-progress-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Claude provider progress events', () => {
  it('emits step progress for tool calls alongside the existing events', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-p' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pnpm test' } },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false }] },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    );

    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: Array<{ type: string; detail?: { state?: string; title?: string } }> = [];
    for await (const e of q.events) events.push(e as (typeof events)[number]);

    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.map((e) => `${e.detail?.title}:${e.detail?.state}`)).toEqual([
      'Ran tests:running',
      'Ran tests:done',
    ]);
    // Existing translation is untouched.
    expect(events.filter((e) => e.type === 'init')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(events.findIndex((e) => e.type === 'result')).toBe(events.length - 1);
  });
});
