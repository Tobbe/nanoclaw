/**
 * Give a private (DM) agent read-only access to the team channels.
 *
 * Run it right after you approve someone's DM with "Connect new agent" (and
 * once for your own DM agent). It:
 *   1. mounts the team agent's workspace and live session data read-only,
 *   2. copies the team-messages lookup tool into the agent's workspace,
 *   3. adds the "Team channels" section to its standing instructions
 *      (replacing an earlier copy), with the owner's name filled in,
 *   4. restarts the agent so it picks this up.
 *
 * The mount allowlist (~/.config/nanoclaw/mount-allowlist.json) must already
 * allow both team paths read-only; that is a one-time step per install.
 *
 *   pnpm exec tsx notes/slack-run-progress/team-reader/setup.ts \
 *     --agent <agent-group-id> --owner "<first name>"
 *
 * Options: --team <team agent-group id> (default: CodeBot Team), --dry-run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULT_TEAM = 'ag-810e2279-3c91-4dba-9d38-4c1010129514';
const START = '<!-- team-reader:start';
const END = '<!-- team-reader:end -->';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const agentId = arg('agent');
const owner = arg('owner');
const teamId = arg('team') ?? DEFAULT_TEAM;
const dryRun = process.argv.includes('--dry-run');
if (!agentId || !owner) {
  console.error('Usage: setup.ts --agent <agent-group-id> --owner "<first name>" [--team <id>] [--dry-run]');
  process.exit(1);
}
if (agentId === teamId) {
  console.error('That is the team agent itself; run this for a private DM agent.');
  process.exit(1);
}

function ncl(...args: string[]): unknown {
  const out = execFileSync(path.join(ROOT, 'bin/ncl'), args, { cwd: ROOT, encoding: 'utf8' });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function step(what: string, fn: () => void): void {
  console.log(`${dryRun ? '[dry run] ' : ''}${what}`);
  if (!dryRun) fn();
}

const agent = ncl('groups', 'get', '--id', agentId) as { folder: string; name: string };
const team = ncl('groups', 'get', '--id', teamId) as { folder: string; name: string };
const mounts: Array<[string, string]> = [
  [path.join(ROOT, 'groups', team.folder), 'team/workspace'],
  [path.join(ROOT, 'data', 'v2-sessions', teamId), 'team/sessions'],
];

const allowlistPath = path.join(process.env.HOME ?? '', '.config/nanoclaw/mount-allowlist.json');
const allowed = (JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) as { allowedRoots: Array<{ path: string }> })
  .allowedRoots;
for (const [host] of mounts) {
  if (!allowed.some((r) => r.path === host)) {
    console.error(`Not in the mount allowlist yet: ${host}\nAdd it read-only to ${allowlistPath} first.`);
    process.exit(1);
  }
}

console.log(`Giving ${agent.name} (${agent.folder}) read-only access to ${team.name}'s channels, owner "${owner}".`);

for (const [host, container] of mounts) {
  step(`mount ${host} → /workspace/extra/${container} (read-only)`, () =>
    ncl('groups', 'config', 'add-mount', '--id', agentId, '--host', host, '--container', container, '--ro'),
  );
}

const groupDir = path.join(ROOT, 'groups', agent.folder);
step(`copy team-messages.ts → groups/${agent.folder}/tools/`, () => {
  fs.mkdirSync(path.join(groupDir, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'team-messages.ts'), path.join(groupDir, 'tools', 'team-messages.ts'));
});

step(`add the Team channels section to groups/${agent.folder}/instructions.prepend.md`, () => {
  const file = path.join(groupDir, 'instructions.prepend.md');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const section = fs.readFileSync(path.join(HERE, 'instructions.md'), 'utf8').replaceAll('{{owner}}', owner).trim();
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start >= 0 && end > start) {
    text = text.slice(0, start) + section + text.slice(end + END.length);
  } else {
    // An unmarked copy from before this script existed is replaced too.
    const legacy = text.indexOf('## Team channels (read-only)');
    if (legacy >= 0) text = text.slice(0, legacy);
    text = `${text.trimEnd()}\n\n${section}\n`;
  }
  fs.writeFileSync(file, text);
});

step('restart the agent', () => ncl('groups', 'restart', '--id', agentId));
console.log('Done.');
