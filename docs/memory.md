# Agent Memory

Every agent group has persistent, file-based memory: plain Markdown files that
survive container restarts, session ends, compaction, and provider switches.
There is no database and no embedding store. The agent reads and edits the
files with ordinary file tools, and you can too.

On the host the files live in `groups/<folder>/memory/`. Inside the container
the same directory is mounted at `/workspace/agent/memory/`.

## Layout

```
memory/
├── index.md              # top-level index + Core Memory (always loaded)
└── system/
    ├── index.md          # index for the system folder
    └── definition.md     # how the memory behaves (always loaded)
```

The scaffold is created automatically when a container boots. It only writes
what is missing, so the agent's own edits and accumulated memory are never
overwritten.

Two files are always loaded:

- **`index.md`** holds the Core Memory section (the few durable facts relevant
  in nearly every conversation) and a map of everything else. Headlines and
  pointers only; detail belongs in linked files.
- **`system/definition.md`** tells the agent how its memory works: what to
  store, where to put it, and how to keep it true. It belongs to the agent and
  the agent may improve it over time.

`system/index.md` is a normal folder index and is not injected separately.

Folder layout and Markdown content are flexible, but every durable concept file
still follows the OKF frontmatter rules below. The agent chooses folders based
on which related information will be easiest to find together; a folder may
contain different concept types. Before writing into a new folder, the agent
creates it and its `index.md`.

## How memory reaches the agent

Whenever the provider creates a fresh context window (at startup, after a
clear, and after compaction), a session-start hook injects `index.md` and
`system/definition.md` into the agent's context. Resuming an existing session
injects nothing, because that context already has them.

The hook lives in the agent-runner and is registered with whatever provider
the group runs, so every provider gets the same behavior. For Claude it is
wired through the Agent SDK; other providers wire it through their own
session-start mechanism.

Only those two files are injected, and each is capped at 16k characters (a
truncation notice tells the agent to slim the file). For anything deeper, the
agent follows links from the index and reads the files directly. This keeps
the always-loaded footprint small no matter how large memory grows.

## Portable format (OKF)

`memory/` is an Open Knowledge Format (OKF) v0.1 bundle: one Markdown
concept per file, with YAML frontmatter declaring a
`type` (for example `person`, `project`, `decision`; `index.md` and `log.md`
are exempt). Types are the agent's vocabulary, not a fixed list.

The format is a convention, not a gate. A file with missing or malformed
frontmatter still works as memory; the agent repairs metadata when it next
touches the file. The payoff is portability: any OKF-aware agent or tool can
read the bundle, and switching a group to a different provider carries memory
over untouched (see [provider-migration.md](provider-migration.md)).

## What goes where

| Kind of information | Home |
|---------------------|------|
| Durable facts, people, projects, decisions | `memory/` |
| Role, persona, standing behavior instructions | `/workspace/agent/instructions.prepend.md` |
| Past session transcripts | `conversations/` in the workspace |
| What each thread discussed, decided, and left open | Thread records (below) |

## Thread records

Memory holds durable facts. What happened in each conversation thread lives in
thread records instead. After every answered turn in a chat thread, the runner
asks a small model (Haiku) to fold the thread's new messages into its record: a title,
one line per topic in the order they came up (what was asked, decided or done,
with PR numbers and links), and what is still open and on whom. Finished topics
stay in the record, so a thread that moved on is still findable by its earlier
subjects (`container/agent-runner/src/thread-record.ts`;
`NANOCLAW_THREAD_RECORDS=off` turns it off).

The new messages are read from the session's own mailbox, after a cursor of
the last inbound and outbound messages the record covers. A message no turn
handled (context that didn't wake the agent, a failed turn, a failed update)
is still folded in at the next update; the cursor only moves once a record
is sent.

The runner sends each record to the host as a `thread_record` system action,
with that cursor; the host keeps the newest per session (`thread_records`,
central DB). Wherever a record is shown (`<channel-threads>`, `ncl sessions
records`, recall), the thread's messages after the cursor follow it as
written, the newest 10, so a reader never misses what came after the last
update. A record from before cursors goes by the time it was written. A new
thread starts with the records of its conversation's other threads from the
last 60 days, rendered as `<channel-threads>`. Only records from the same
messaging group are shared, so a channel never sees a DM's threads.

The agent can also run:

- `ncl sessions records` for a fresh copy (`--all` for every conversation it can
  read, each record headed with its conversation's name);
- `ncl sessions recall --question "<question>"` to ask by meaning, in any
  language: the container's ncl fetches `records --all` and has Haiku pick the
  threads that bear on the question (the host has no model access, so this one
  runs in the container);
- `ncl sessions search --query "<words>"` to find exact wording in messages and
  records (word-start matches, so it searches in both languages with synonyms);
- `ncl sessions history <id>` to open a thread.

Across conversations, an agent reads its own conversation plus the group's
shared ones (channels, rooms), never another person's DM. This applies to
`records --all`, recall, search, `ncl sessions history` and `ncl sessions file`
(another DM reads as "session not found").

## DMs to an agent that also serves channels

An agent group's memory and workspace are shared by all its conversations. When
a DM is wired to an agent that also serves a channel or room, the host keeps the
DM as private as telling a colleague (`src/modules/cross-session-context/dm-privacy.ts`):

- other threads can't open, search or recall it (above);
- its conversation archives go to the session folder (`/workspace/conversations/`)
  instead of the shared `conversations/`;
- the agent gets a "This DM is private" section: keep what is said there out of
  channels, other DMs and shared memory, with private notes in
  `/workspace/dm-notes.md`.

The last part rests on the model's judgment. An agent with only DMs (a personal
agent) keeps its usual shared memory and archive.

## Migrating older memory

Groups created before the shared memory tree may still have legacy storage:
`.seed.md`, memory notes inside `CLAUDE.md` or `CLAUDE.local.md`, Claude's
auto-memory directory, or an `imported-agent-memory.md` from an earlier provider
switch. Run `/migrate-memory` to move standing role and persona into
`instructions.prepend.md` and organize durable facts in the shared memory tree.
Older groups may already contain folders named `memories` or `data`. Those are
still valid agent-chosen folders: normal startup neither creates nor deletes
them, and migration preserves their contents.

## Operator notes

- You can read or edit any memory file directly on the host under
  `groups/<folder>/memory/`; changes are picked up the next time a context
  window is created.
- Wrong or stale facts are just text: delete or correct them in place, or ask
  the agent to (it is instructed to prune and update on correction).
- The default templates live at
  `container/agent-runner/src/memory/templates/`, mirroring the generated
  memory tree. NanoClaw copies a template only when that memory file is missing.
  It never overwrites an existing memory file.
