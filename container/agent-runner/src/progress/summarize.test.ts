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
    expect(s).toEqual({ title: 'Fetched from the web', category: 'web' });
    expect(JSON.stringify(s)).not.toContain('sk-live');
    expect(JSON.stringify(s)).not.toContain('example.com');
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
    expect(classifyCommand('git status --short')).toEqual({ title: 'Checked what changed', category: 'run' });
    expect(classifyCommand('ls -la')).toEqual({ title: 'Looked through the files', category: 'inspect' });
  });

  it('names common git and shell commands without echoing them', () => {
    const title = (c: string) => classifyCommand(c).title;
    expect(title('git clone --depth 1 https://github.com/acme/site.git /tmp/site')).toBe('Cloned a repository');
    expect(title('cd /tmp/site && git -C . log --oneline -5')).toBe('Looked at the history');
    expect(title('git commit -m "secret message"')).toBe('Committed changes');
    expect(title('git push origin main')).toBe('Pushed changes');
    expect(title('gh pr create --fill')).toBe('Opened a pull request');
    expect(title('gh pr view 20 --json files')).toBe('Worked on a pull request');
    expect(title('git config user.name CodeBot')).toBe('Set up git');
    // A fallback after || only runs when the first part fails.
    expect(
      title(
        'cd repos && (test -d site && cd site && git fetch -q origin && git reset -q --hard origin/main || git clone -q https://github.com/acme/site.git)',
      ),
    ).toBe('Pulled the latest changes');
    expect(title('test -d site || git clone https://github.com/acme/site.git')).toBe('Cloned a repository');
    expect(title('git add -A && git commit -m "x"')).toBe('Committed changes');
    expect(title('git rev-parse HEAD')).toBe('Used git');
    expect(title('git branch -a')).toBe('Looked at the branches and files');
    expect(title('git checkout -b codebot/x origin/main')).toBe('Switched branches');
    expect(title('cat AGENTS.md; git status --short; git branch -a; git log --oneline')).toBe('Checked what changed');
    // The first command decides, not the order the labels are checked in.
    expect(title('grep -rn kloak src | grep -v x; head -20 src/a.yaml')).toBe('Searched the code');
    expect(title('cd repos && ls; cat notes.md')).toBe('Looked through the files');
    expect(title('cat README.md | head -50')).toBe('Read a file');
    expect(title('ncl sessions recall --question "What waits on Lise?" 2>&1 | head -60')).toBe(
      'Searched the thread records',
    );
    expect(title('ncl sessions search --query "case casen"')).toBe('Searched past messages');
    expect(title('ncl sessions history --id sess-1 --limit 80 | tail -40')).toBe('Read a thread');
    expect(title('ncl sessions records --all')).toBe('Read the thread records');
    expect(title('ncl sessions list')).toBe('Looked through the threads');
    expect(title('ncl tasks create --name x --prompt y')).toBe('Scheduled a task');
    expect(title('ncl groups config get')).toBe('Ran a NanoClaw command');
    // Labels never carry the question asked.
    expect(JSON.stringify(classifyCommand('ncl sessions recall --question "secret"'))).not.toContain('secret');
    expect(title('mkdir -p out && cp a b')).toBe('Organized files');
    expect(title('python3 scripts/build_index.py')).toBe('Ran a script');
    expect(title('echo hi')).toBe('Ran a command');
  });

  it('lists every action in a chained command, in order', () => {
    const title = (c: string) => classifyCommand(c).title;
    // What CodeBot runs after a change: one command, four things done.
    expect(
      title(
        'export GH_TOKEN=x && git add -A && git commit -q -m "m" && git push -q -u origin b 2>&1|tail -1\n' +
          'gh pr create -R o/r --base main --head b --title t --body "b"\n' +
          'sha=$(git rev-parse HEAD); sleep 15\n' +
          'for id in $(gh run list -R o/r --branch b); do\n gh run watch "$id" -R o/r --exit-status >/dev/null && echo ok; done',
      ),
    ).toBe('Committed and pushed changes, opened a pull request and waited for the checks');
    expect(title('yarn build 2>&1 | grep error; git add -A && git commit -m x && git push')).toBe(
      'Ran a build, committed and pushed changes',
    );
    expect(classifyCommand('pnpm test && git commit -m x')).toEqual({
      title: 'Ran tests and committed changes',
      category: 'test',
    });
    // A failure fallback isn't a step that normally runs.
    expect(title('git fetch && git checkout b || git clone https://x/y.git')).toBe('Pulled the latest changes');
    // Look-arounds chained together keep one label.
    expect(title('cat AGENTS.md; git status --short; git branch -a; git log --oneline')).toBe('Checked what changed');
  });

  it('names the preview server and screenshots', () => {
    const title = (c: string) => classifyCommand(c).title;
    expect(
      title(
        '(yarn preview --port 4321 >/tmp/preview.log 2>&1 &); sleep 8; mkdir -p /workspace/agent/shots; ' +
          'agent-browser set viewport 1440 900; agent-browser open http://localhost:4321/',
      ),
    ).toBe('Started the preview and opened a page in the browser');
    expect(classifyCommand('agent-browser screenshot ".row" /workspace/agent/shots/a.png')).toEqual({
      title: 'Took a screenshot',
      category: 'inspect',
    });
    // The bracket trick that keeps pkill from killing its own shell.
    expect(title('pkill -f "[a]stro preview"')).toBe('Stopped the preview');
    expect(title('git status && git commit -m x')).toBe('Committed changes');
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
