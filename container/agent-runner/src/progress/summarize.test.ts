import { describe, expect, it } from 'bun:test';

import { basename, classifyCommand, summarizeStep } from './summarize.js';

describe('summarizeStep', () => {
  it('shows only the basename of files, never the directory', () => {
    const s = summarizeStep('Edit', { file_path: '/workspace/extra/site/src/pages/index.astro', old_string: 'secret' });
    expect(s).toEqual({ title: 'Edited index.astro', category: 'edit' });
    expect(JSON.stringify(s)).not.toContain('/workspace');
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('never includes a Bash command in the title', () => {
    const command = 'curl -H "Authorization: Bearer sk-live-123" https://api.example.com/x';
    const s = summarizeStep('Bash', { command });
    expect(s).toEqual({ title: 'Ran a command', category: 'run' });
    expect(JSON.stringify(s)).not.toContain('sk-live');
  });

  it('classifies test, build, install and git commands', () => {
    expect(classifyCommand('cd app && pnpm test -- --run')).toEqual({ title: 'Ran tests', category: 'test' });
    expect(classifyCommand('bun test src/x.test.ts')).toEqual({ title: 'Ran tests', category: 'test' });
    expect(classifyCommand('python -m pytest -q')).toEqual({ title: 'Ran tests', category: 'test' });
    expect(classifyCommand('npm run build')).toEqual({ title: 'Ran a build', category: 'run' });
    expect(classifyCommand('pnpm install --frozen-lockfile')).toEqual({
      title: 'Installed dependencies',
      category: 'run',
    });
    expect(classifyCommand('git status --short')).toEqual({ title: 'Used git', category: 'run' });
    expect(classifyCommand('ls -la')).toEqual({ title: 'Ran a command', category: 'run' });
  });

  it('uses the model description for Bash only in detailed mode', () => {
    const input = { command: 'pnpm vitest run', description: 'Run the unit tests' };
    expect(summarizeStep('Bash', input, 'concise')?.title).toBe('Ran tests');
    expect(summarizeStep('Bash', input, 'detailed')).toEqual({ title: 'Run the unit tests', category: 'test' });
  });

  it('shows only the hostname of fetched URLs', () => {
    expect(summarizeStep('WebFetch', { url: 'https://example.com/private/path?token=abc' })).toEqual({
      title: 'Read a page on example.com',
      category: 'web',
    });
  });

  it('hides messaging and bookkeeping tools', () => {
    expect(summarizeStep('mcp__nanoclaw__send_message', { text: 'hi' })).toBeNull();
    expect(summarizeStep('mcp__nanoclaw__edit_message', {})).toBeNull();
    expect(summarizeStep('TodoWrite', { todos: [] })).toBeNull();
    expect(summarizeStep('ToolSearch', {})).toBeNull();
  });

  it('labels the question tool and other MCP tools', () => {
    expect(summarizeStep('mcp__nanoclaw__ask_user_question', {})).toEqual({
      title: 'Asked a question',
      category: 'ask',
    });
    expect(summarizeStep('mcp__my_server__do_thing', {})).toEqual({
      title: 'Used my_server: do thing',
      category: 'other',
    });
  });

  it('covers inspection, delegation and unknown tools', () => {
    expect(summarizeStep('Grep', { pattern: 'password' })).toEqual({ title: 'Searched the code', category: 'inspect' });
    expect(summarizeStep('Read', { file_path: 'README.md' })).toEqual({ title: 'Read README.md', category: 'inspect' });
    expect(summarizeStep('Task', { prompt: 'secret plan' })).toEqual({
      title: 'Delegated to a subagent',
      category: 'delegate',
    });
    expect(summarizeStep('Mystery', {})).toEqual({ title: 'Used Mystery', category: 'other' });
  });
});

describe('basename', () => {
  it('handles both separators and clips long names', () => {
    expect(basename('C:\\work\\file.ts')).toBe('file.ts');
    expect(basename('/a/b/')).toBe('b');
    expect(basename(`/x/${'n'.repeat(100)}.ts`).length).toBeLessThanOrEqual(60);
  });
});
