/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getAgentMailbox } from './mailbox/index.js';
import type { Destination } from './mailbox/types.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

export type SessionMode = { kind: 'chat' } | { kind: 'task'; taskId: string };

function destinationEntry(destination: Destination): DestinationEntry {
  return {
    name: destination.name,
    displayName: destination.displayName ?? destination.name,
    type: destination.type,
    channelType: destination.channelType ?? undefined,
    platformId: destination.platformId ?? undefined,
    agentGroupId: destination.agentGroupId ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  return getAgentMailbox().operations.getDestinations().map(destinationEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const destination = getAgentMailbox().operations.findDestinationByName(name);
  return destination && destinationEntry(destination);
}

export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const destination = getAgentMailbox().operations.findDestinationByRouting(channelType, platformId);
  return destination && destinationEntry(destination);
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string, mode: SessionMode = { kind: 'chat' }): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(
      [
        '# You are ' + assistantName,
        '',
        `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`,
      ].join('\n'),
    );
  }

  sections.push(buildDestinationsSection(mode));
  if (mode.kind === 'chat') sections.push(buildReadingSection());
  const privateDm = privateDmLines();
  if (mode.kind === 'chat' && privateDm.length) sections.push(privateDm.join('\n').trim());

  return sections.join('\n\n');
}

/** Set by the host for a DM of an agent that also serves shared channels. */
export const PRIVATE_DM_ENV = 'NANOCLAW_PRIVATE_DM';

/**
 * DM discretion: this agent also serves shared channels, and its memory and
 * workspace are read from all of them. The host already keeps this DM's
 * transcript, files and archives out of other threads' reach; what is left
 * is the agent's own judgment, which these lines set.
 */
export function privateDmLines(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env[PRIVATE_DM_ENV] !== '1') return [];
  return [
    '## This DM is private',
    '',
    'This is a one-to-one DM, but you also serve shared channels, and your memory and workspace files are read in all of them. Keep what this person tells you here between the two of you, as a trusted colleague would:',
    '',
    "- Don't repeat, quote or hint at it in a channel or in anyone else's DM, unless they ask you to.",
    "- Don't write it to `/workspace/agent/memory/` or other files under `/workspace/agent/`: every conversation reads those. Keep notes about this DM in `/workspace/dm-notes.md` instead, which only this DM sees. Facts meant for the whole team (a decision, a convention) can go to shared memory only when this person says so.",
    '- If it matters to others, suggest they bring it up themselves, or ask whether you may.',
    "- This DM's past conversations are archived in `/workspace/conversations/`, not the shared folder.",
    '',
  ];
}

/**
 * What the inbound blocks are. Chat only: task runs have no messaging group, so they
 * never receive echo or history rows. The three tags are the ones
 * formatter.ts emits; keep the two in step.
 */
function buildReadingSection(): string {
  return [
    '## Reading messages',
    '',
    'Chat turns can include:',
    '',
    "- `<message>` — the message you are answering. `<dm-history>` and `<channel-history>` are this thread's own earlier timeline. One marked `answered=\"in its own thread\"` started a thread you already replied in: it's done, so don't answer it again.",
    '- `<cross-session-context>` — a copy of something from elsewhere in this conversation: another thread, or a message you or a scheduled task posted here. Its `from` says where; `sender="you"` marks your own. If you can\'t tell whether the current message refers to it or to this thread, ask.',
    '- `<channel-threads>` — the records of the other threads in this conversation, newest first: what each discussed, what was decided, and what is still open and on whom. Each is headed by its session id. They are summaries; messages that came after a record\'s last update follow it as written ("Since this record"). For the exact words open the thread with `ncl sessions history <id>`.',
    '',
    'You took part in every thread here, so answer like someone who followed them all. For "what did we say about X?", "what is still open?" or "do I owe anyone an answer?", start from `<channel-threads>` (or `ncl sessions records`), then open the threads that matter with `ncl sessions history <id>` before you answer: records are summaries and can miss or lag what was said. A topic can span threads (asked for in one, done in another), so for each item you would call unclear or unconfirmed, search for that item first (`ncl sessions search` with its key words in both languages) and open what it finds, and check the work itself (repo, PRs, preview site); only if that finds nothing, say it is unclear and what you checked. When that doesn\'t settle it, or the question may concern another channel or an older thread, ask `ncl sessions recall --question "<the question>"`: it reads the records of every thread you can read and answers by meaning, in any language. When the question names a period ("since Friday", "this week"), add `--since <YYYY-MM-DD>` so it reads only the threads active since then: faster and cheaper. For exact wording or something no record covers, use `ncl sessions search --query "<words>"`: it matches words as written, so give both languages and synonyms (e.g. "farve farver color colour"). Never say you can\'t see the other threads.',
    '',
    "A `<message>`'s `sender_id` is the sender's platform user id. To mention someone on Slack, write `<@` + their `sender_id` + `>`, e.g. `<@U0123ABCD>`; never `@Name` or `<@Name>`, which Slack shows as plain text and which notify nobody.",
  ].join('\n');
}

function buildDestinationsSection(mode: SessionMode): string {
  const all = getAllDestinations();
  const lines = ['## Sending messages', ''];

  if (all.length === 0) {
    lines.push('You currently have no configured destinations. You cannot send messages until an admin wires one up.');
    if (mode.kind === 'chat') return lines.join('\n');
  } else if (all.length === 1) {
    const d = all[0];
    lines.push(`Your destination is \`${d.name}\`${destinationLabel(d)}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      lines.push(`- \`${d.name}\`${destinationLabel(d)}`);
    }
  }

  lines.push('');

  if (mode.kind === 'task') {
    lines.push(
      'This is an isolated task run with no attached chat. Only notify someone when the task asks you to. For a user-visible message, call `send_message({ to: "name", text: "..." })`; for a file, call `send_file` with `to`. Always pass the explicit named destination.',
    );
    const channelDestinations = all.filter((destination) => destination.type === 'channel');
    if (channelDestinations.length > 0) {
      const channelNames = channelDestinations.map((destination) => `\`${destination.name}\``).join(', ');
      lines.push(
        '',
        `For user-visible escalation output, default to your own channel destination(s): ${channelNames} — that's the operator's actual conversation with you. Use an agent-type destination like \`parent\` only when the task explicitly calls for routing through another agent, not as your default escalation path.`,
      );
    }
    lines.push(
      '',
      `Your final output is not sent to the user. End with a concise work-log summary. It is recorded automatically in \`tasks/${mode.taskId}.md\`. Read that file when you need context from earlier runs. Use \`ncl tasks append-log --msg "…"\` only for optional mid-run notes.`,
    );
    return lines.join('\n');
  }

  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking you don\'t want sent.',
  );
  lines.push('');
  lines.push(
    'When replying to an incoming message, default to addressing the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute). Pick a different destination when the request asks for it (e.g., "tell Laura that…").',
  );
  lines.push('');
  lines.push(
    'The `send_message` MCP tool is the same delivery, available mid-turn. Always pass its explicit `to` destination. It is handy for a quick acknowledgment ("on it") before a slow tool call, but your answer still has to be sent after it. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence rather than as one combined reply.',
  );
  lines.push('');
  lines.push(
    'For a short turn, do not narrate. For longer work, send one acknowledgment and then updates only at meaningful milestones, especially before slow operations. Never narrate micro-steps; finish with the outcome, not a play-by-play.',
  );
  return lines.join('\n');
}

function destinationLabel(d: DestinationEntry): string {
  const parts: string[] = [];
  if (d.channelType) parts.push(d.channelType);
  if (d.displayName && d.displayName !== d.name) parts.push(d.displayName);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}
