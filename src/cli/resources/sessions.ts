import {
  formatHistoryLines,
  HISTORY_DEFAULT_LIMIT,
  sessionFile,
  sessionHistory,
  type HistoryRow,
} from '../../modules/cross-session-context/index.js';
import {
  formatSearchHits,
  SEARCH_DEFAULT_LIMIT,
  sessionBackfillCandidates,
  sessionRecords,
  sessionSearch,
  type BackfillCandidate,
  type SearchHit,
} from '../../modules/cross-session-context/search.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'session',
  plural: 'sessions',
  table: 'sessions',
  description:
    'Session — the runtime unit. Maps one (agent_group, messaging_group, thread) combination to a container with its own inbound.db and outbound.db. Created automatically by the router when a message arrives.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group this session runs.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'Messaging group this session serves. Null for agent-shared sessions.',
    },
    {
      name: 'thread_id',
      type: 'string',
      description: 'Thread ID. Only set for per-thread session mode.',
    },
    {
      name: 'agent_provider',
      type: 'string',
      description: 'Provider override. Null means inherit from agent group.',
    },
    {
      name: 'status',
      type: 'string',
      description: '"active" receives messages. "closed" is archived.',
      enum: ['active', 'closed'],
    },
    {
      name: 'container_status',
      type: 'string',
      description:
        '"running" — container alive and polling. "stopped" — container exited; the sweep will restart it automatically when due messages arrive. "idle" — reserved, currently unused.',
      enum: ['running', 'idle', 'stopped'],
    },
    { name: 'last_active', type: 'string', description: 'Last message or heartbeat. Used for stale detection.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    history: {
      access: 'open',
      description:
        'Read a session transcript: inbound + outbound messages merged chronologically. Only the ' +
        'conversation itself by default; `--all` adds system rows (progress cards, record updates, ncl ' +
        'requests) and copies of other threads.\n\n' +
        'Output: pipe-separated lines "timestamp|direction(in/out)|kind|sender|text" (text capped at ' +
        '2,000 chars, a cut one ends in …), the newest --limit rows in chronological order; `--json` returns the raw rows ' +
        'with ISO timestamps and uncapped text. Use after `ncl sessions list` to ' +
        'catch up fully on another conversation of your agent group (you only ever see your own ' +
        "group's sessions).",
      examples: [`# Catch up on another session of your group:\nncl sessions history sess-1751234-abc123 --limit 100`],
      args: [
        { name: 'id', type: 'string', description: 'Session id (from `ncl sessions list`).', required: true },
        {
          name: 'limit',
          type: 'number',
          description: `Max rows returned, newest first (default ${HISTORY_DEFAULT_LIMIT}).`,
          default: HISTORY_DEFAULT_LIMIT,
        },
        {
          name: 'all',
          type: 'boolean',
          description: 'Also system rows and ambient copies of other threads (hidden by default).',
        },
      ],
      // Self-scoped in the handler: custom ops bypass the dispatcher's generic
      // scope post-filter, so cross-group callers get "session not found"
      // (the dispatcher's sessions pre-handler check covers this verb too).
      handler: async (args, ctx) => await sessionHistory(args, ctx),
      formatHuman: (data) => formatHistoryLines(data as HistoryRow[]),
    },
    file: {
      access: 'open',
      description:
        'Fetch a file that arrived in another session of your agent group (a `[file: inbox/...]` path from `ncl sessions history`) into your own session, so you can open it. Pass the path with --path. Prints the path to read it from.',
      examples: [
        `# Open the image someone posted in an earlier thread:\nncl sessions file sess-1751234-abc123 --path inbox/1751234.5678/image.png`,
      ],
      args: [
        { name: 'id', type: 'string', description: 'Session id the file arrived in.', required: true },
        {
          name: 'path',
          type: 'string',
          description: "The file's path from `ncl sessions history`, like inbox/<folder>/<name>.",
          required: true,
        },
      ],
      // Self-scoped in the handler, like history.
      handler: async (args, ctx) => await sessionFile(args, ctx),
      formatHuman: (data) => `Saved to ${(data as { path: string }).path}`,
    },
    search: {
      access: 'open',
      description:
        "Search everything said in all your conversations: every thread's messages (in and out) and every thread record. " +
        'Matches any of the words (case-insensitive, word starts: "farve" also finds "farver"); more words matched rank higher, then newer. ' +
        'Words only match as written, so search in both languages and with synonyms ("farve farver color colour"). ' +
        'Each hit names its session; open the whole thread with `ncl sessions history <id>`.',
      examples: [
        `# Where did we talk about button colors?\nncl sessions search --query "farve farver color colour knap button"`,
      ],
      args: [
        { name: 'query', type: 'string', description: 'Words to look for, in any language.', required: true },
        {
          name: 'limit',
          type: 'number',
          description: `Max hits (default ${SEARCH_DEFAULT_LIMIT}).`,
          default: SEARCH_DEFAULT_LIMIT,
        },
        {
          name: 'group',
          type: 'string',
          description:
            'Agent group id. Agents search their own; a global-scope agent may name another group (its shared channels only).',
        },
      ],
      // Self-scoped in the handler, like history.
      handler: async (args, ctx) => await sessionSearch(args, ctx),
      formatHuman: (data) => formatSearchHits(data as SearchHit[]),
    },
    records: {
      access: 'open',
      description:
        'The records of the other threads in this conversation, newest first: what each thread discussed, what was decided, ' +
        'and what is still open and on whom. A new thread gets these at its start; run this for a fresh copy.',
      examples: [
        `ncl sessions records`,
        `# Every conversation you can read, not just this one:\nncl sessions records --all`,
      ],
      args: [
        {
          name: 'all',
          type: 'boolean',
          description:
            'Records of every conversation you can read (this one and the shared channels), not just this one.',
        },
        {
          name: 'group',
          type: 'string',
          description:
            'Agent group id: required on the host; with --all, a global-scope agent may name another group (its shared channels only).',
        },
        { name: 'conversation', type: 'string', description: 'Messaging group id (host only).' },
        {
          name: 'since',
          type: 'string',
          description:
            'Only threads active since this date or time (YYYY-MM-DD or ISO 8601), e.g. the start of the period a question asks about.',
        },
      ],
      handler: async (args, ctx) => await sessionRecords(args, ctx),
      formatHuman: (data) => String(data),
    },
    'backfill-candidates': {
      access: 'open',
      description:
        'The threads you can read that have no thread record yet, oldest first. ' +
        'Used by `ncl sessions backfill-records`, which writes one for each.',
      examples: [`ncl sessions backfill-candidates`],
      args: [
        {
          name: 'over',
          type: 'number',
          description: 'Also list threads whose record is at least this many characters, to rebuild it.',
        },
        {
          name: 'containing',
          type: 'string',
          description: 'Also list threads whose record contains any of these words (case-insensitive), to rebuild it.',
        },
        {
          name: 'group',
          type: 'string',
          description:
            'Agent group id: required on the host; a global-scope agent may name another group (its shared channels only).',
        },
      ],
      handler: async (args, ctx) => await sessionBackfillCandidates(args, ctx),
      formatHuman: (data) =>
        (data as BackfillCandidate[]).map((c) => `${c.sessionId}  ${c.conversation}  ${c.createdAt}`).join('\n') ||
        'Every thread has a record.',
    },
    'backfill-records': {
      access: 'open',
      description:
        'Write thread records for the threads that have none (see backfill-candidates): a small model reads each ' +
        'transcript and writes its record, as for live threads. Never replaces an existing record. ' +
        'Runs inside your container and can take several minutes; give it a long timeout.',
      examples: [
        `ncl sessions backfill-records`,
        `# Also rebuild records cut at the cap:\nncl sessions backfill-records --over 1900`,
      ],
      args: [
        {
          name: 'over',
          type: 'number',
          description: 'Also rebuild records at least this many characters long. A record updated meanwhile is kept.',
        },
        {
          name: 'containing',
          type: 'string',
          description:
            'Also rebuild records containing any of these words, e.g. "colour grey". A record updated meanwhile is kept.',
        },
        {
          name: 'group',
          type: 'string',
          description: 'Another agent group to backfill (global-scope agents only; its shared channels).',
        },
      ],
      handler: async () => {
        throw new Error('backfill-records runs inside agent containers (it needs the model gateway)');
      },
    },
    recall: {
      access: 'open',
      description:
        'Ask what was discussed, in plain words and any language ("what did we say about the colors?"). ' +
        'A small model reads the records of every thread you can read and answers by meaning, naming the threads, ' +
        'so the words need not match. Runs inside your container; open a named thread with `ncl sessions history <id>`, ' +
        'and use `ncl sessions search` for exact wording.',
      examples: [
        `ncl sessions recall --question "hvad sagde vi om farverne på knapperne?"`,
        `# A question about a period: only the threads active in it, faster and cheaper:\nncl sessions recall --since 2026-11-20 --question "what is waiting on Lise?"`,
      ],
      args: [
        { name: 'question', type: 'string', description: 'What you want to know.', required: true },
        {
          name: 'since',
          type: 'string',
          description:
            'Only threads active since this date (YYYY-MM-DD or ISO 8601). Use it whenever the question names a period ("since Friday", "this week"): fewer records to read makes the answer faster and cheaper.',
        },
        {
          name: 'group',
          type: 'string',
          description: "Another agent group's threads to ask about (global-scope agents only; its shared channels).",
        },
      ],
      // The container's ncl answers this itself (the host has no model
      // access); a request reaching the host came from somewhere else.
      handler: async () => {
        throw new Error('recall runs inside agent containers (it needs the model gateway)');
      },
    },
  },
});
