# Design note: live run progress in Slack (draft 1, 2026-11-12)

Covers stage 1 of `nanoclaw-slack-progress-handoff.md`. The evidence behind it, with file references, is in
`slack-progress-findings.md`. Checkouts in `~/dev/nanoclaw/`: `main/` @ 62dc0905 and `channels/` @ 47f67e74.

## 1. Goal and non-goals

**Goal.** A teammate @mentions the agent in a channel. Inside that thread, one message — the *run card* —
updates in place. It shows:

- what the agent is doing (stage, plan or checklist, recent steps)
- whether it is waiting on a person
- how the run ended

The real reply still arrives as a normal thread message.

**In scope for v1:** progress events, the run card, and in-thread questions and approvals that are safe to click.

**Out of scope here:** coding-task workspaces (per-task worktree, push/PR, preview URLs), ACP, and the VPS move.
Those get their own notes.

## 2. What exists today (short version)

| Piece | State |
|---|---|
| Provider → runner progress | `progress {message}` exists but is only logged. Claude drops `tool_use` and tool results. |
| Runner → host channel | Rows in `messages_out`. Rows with `kind:'system'` go to `registerDeliveryAction` handlers and **skip** three things: the typing pause, the cross-session fan-out, and post-delivery hooks. |
| Edit in place | Works for text (`operation:'edit'`). The Slack ts is stored on delivery. The bridge can't edit a message *into a card*, though Chat SDK `editMessage` accepts cards. |
| Typing status | `setTyping(…, status)` exists in core, but the bridge drops `status`. Slack would show it via `assistant.threads.setStatus`, which needs the Agents & AI Apps feature and the `assistant:write` scope. |
| Questions | `ask_user_question` posts buttons. Problems: any channel member can answer, the card is edited before the click is checked, nothing expires, and there is no free text. |
| Approvals | Module approvals are DM-only. Gateway approvals have the right pattern: bound, expiring, claimed atomically, edited only after the claim. |
| Chat SDK 4.41.1 has, unused | `Select`, `RadioSelect`, `TextInput`, `Modal`/`openModal`, `postEphemeral`, `deleteMessage`, native streaming with `task_update`/`plan_update` chunks. |

## 3. Design

### 3.1 A neutral progress model (container)

Extend the existing event so the change is backward-compatible. Every structured field is optional:

```ts
| { type: 'progress'; message: string; detail?: ProgressDetail }

type ProgressDetail =
  | { kind: 'step';    id: string; title: string; state: 'running' | 'done' | 'failed'; tool?: string; category?: StepCategory }
  | { kind: 'plan';    items: { id: string; title: string; state: 'pending' | 'running' | 'done' | 'failed' }[] }
  | { kind: 'waiting'; on: 'question' | 'approval'; summary: string }
  | { kind: 'status';  text: string }            // Codex-style status strings

type StepCategory = 'inspect' | 'edit' | 'run' | 'test' | 'web' | 'delegate' | 'other';
```

How each provider fills it:

- **Claude** (`providers/claude.ts`):
  - A `tool_use` block becomes a `step` with state `running`, using `tool_use_id` as the id.
  - The `tool_result` in the next `user` message becomes `done`, or `failed` if `is_error` is set.
  - The `TodoWrite` input becomes `plan`. Newer Claude Code CLIs may use `Task*` tools instead; check against the CLI bundled in the image.
  - Our own `ask_user_question` tool, and approval tools, become `waiting`.
  - `task_notification` stays as it is.
- **Cursor:** its tool name and running/failed state map straight to `step`.
- **Codex:** `status`.
- **OpenCode:** nothing. The card then shows elapsed time only.

**Safety lives in the container, where the raw input is.** A provider-neutral `summarizeStep(tool, input, level)`
in agent-runner builds the `title` from allowlisted fields only:

- the tool name
- for file tools, the file's basename
- for Bash, a fixed label such as "Ran tests" or "Ran a command"

Raw commands, full paths and tool output never leave the container unless the level is `detailed` and
`showCommands` is set. Model reasoning is never included.

`category` comes from a small table. For example, `Read`/`Grep`/`Glob` count as `inspect`, and a Bash command
that matches a test pattern counts as `test`. The table is how the card can say "Inspecting → Editing → Testing"
without sending raw commands to the host.

### 3.2 Runner sink: snapshots, not deltas

A sink in the poll loop collects progress into one `RunProgress` snapshot per turn. It contains:

- `runId`, a counter `seq`, `startedAt` and `stage`
- `plan[]`
- the last N `steps[]`, plus a count of earlier ones
- `waiting?`
- `terminal?`, one of `done`, `failed` or `cancelled`

It writes the snapshot as `kind:'system'` with content `{action:'run_progress', snapshot}`.

- **Throttle.** At most one write every 2.5s. State changes such as `waiting` or `terminal` are written immediately.
- **Why snapshots.** The host keeps only the highest `seq`. Duplicate or reordered rows, restarts and replays
  then can't produce a wrong card. This is the property the acceptance criteria ask for.
- **Why `system`.** It skips the typing pause, the fan-out and post-delivery hooks for free. It also stays out of
  `chatRowsInWindow`, so it doesn't distort the wrap-nudge.
- **Where it plugs in.** Through `registerTurnHook({ onProviderEvent })` if upstream PR #3904 merges. That
  hook is fire-and-forget and can't stall the stream. Until then, a small call at `poll-loop.ts` ~:585
  that can be dropped later.

### 3.3 Host: run-progress module (`src/modules/run-progress/`)

- **Delivery action.** It registers `run_progress` as an unguarded delivery action: the card is display-only and
  carries no privilege.
- **State table.** It persists the card in a central DB table `run_progress_cards` with these columns:
  - `session_id`, `run_id`
  - `channel_type`, `instance`, `platform_id`, `thread_id`
  - `platform_message_id`
  - `last_seq`, `state`, `created_at`, `updated_at`
- **When to post.** It posts the card only after the run has lasted **8s**, or when the first `waiting` arrives.
  Quick answers never get a card.
- **How to render.** It renders a neutral `ProgressView` into card parts that already exist on main (Text, Fields,
  Divider). It posts once, then edits through `operation:'edit'`. The editing pattern to follow is
  `editGatewayApprovalCard`.
- **Rate limits.** At most one edit every 3s per card, plus a limit across the whole install, because Slack
  `chat.update` limits apply per method per workspace. If Slack returns 429, keep the newest snapshot and retry
  later.
- **No long retries for card edits.** By default the Slack adapter's WebClient retries a rate-limited (429) call for
  about 30 minutes (`retryPolicies.tenRetriesInAboutThirtyMinutes`), which could hold up real replies.
  As built: card calls run from the card manager's own 1s tick, never from the delivery path, so replies
  never wait on them. An edit still pending after 15s is abandoned; the next edit replaces it, after a 30s
  back-off. Posts are never abandoned, so a late post can't create a second card.
- **Elapsed-time refresh** (asked for 2026-11-12). While a run is running or waiting, the host re-renders the
  card when no edit has happened for **15s**, so the elapsed time keeps moving through one long step.
  - Elapsed is computed on the host from `startedAt`, so a refresh doesn't need a new snapshot.
  - It shows `45s`, `1m 05s` or `1h 02m`, exact at the moment of each edit.
  - Refreshes go through the same per-card and install-wide rate limits. When Slack is rate-limiting, they are
    the first thing to drop.
  - The timer stops at the final state, and a host restart re-arms it for non-final cards whose container is
    still running.
- **When the run ends.**
  - The card gets its final state: "Done in 4m 12s · 6 steps" or "Failed: …". It doesn't repeat the reply text.
  - If the container exits without a final snapshot (crash, cancel, timeout), the existing container-exit hook
    (`container-runner.ts` ~:827) marks the card "Stopped".
  - At startup, any card that isn't finished and has no running container is marked "Interrupted".
- **Channels that can't edit messages.** The module skips the card and only uses the typing status.

Example card in concise mode:

```
🔧 Working · 2m 05s                        (stage: Testing)
✅ Inspect landing page   ✅ Edit headline   ⏳ Run tests   ◻️ Share preview
Latest: Ran tests (12s)
```

The detailed mode adds the last 5 step rows: ⏳ running, ✅ done, ❌ failed.

### 3.4 Slack-specific additions (`channels` branch)

- **Forward typing status.** Pass the `status` argument through to `adapter.startTyping(tid, status)`. It shows
  the current stage under the composer where the Agents & AI Apps feature is enabled. Otherwise it does nothing.
- **Optional native rendering.** Slack's native streaming API (`chat.startStream`) with `task_update`/`plan_update`
  chunks is Slack's own task-card UI. It's attractive, but it needs one open stream per message and possibly the
  agent features. Verify it in the test workspace before choosing it over Block Kit; Block Kit is the default.
- **Interactivity.** Turn it on in the provisioning manifest (`slack-app.ts:175`) and the Socket Mode setup steps.
  Buttons won't work without it.

### 3.5 Questions and approvals in the thread (phase 2)

Generalize the gateway-approval pattern into one core helper for *bound actions*. A pending row records:

- `request_id`, `session_id`, `run_id`
- the channel, thread and card `ts`
- `allowed` responders: `initiator`, `initiator+admins` (the default), or `members`
- `expires_at` and `status`

When someone clicks:

1. Claim the request atomically.
2. Only after a successful claim, edit the card to show who answered.
3. Send a private (ephemeral) reply to an unauthorized clicker, or to anyone clicking an expired or already-answered card.

Changes this requires:

- **`ask_user_question`** uses deferred resolution, so the bridge no longer edits the card before checking the
  click. This is a security fix worth upstreaming on its own. `pending_questions` gains the card's `ts`, an expiry
  and a sweep.
- **Question card layout** (asked for 2026-11-12, modelled on Claude Code's question dialog):
  - the question as markdown, so inline code shows as code
  - a `RadioSelect` where each option has a label and a description line, the recommended option first
  - an "Other" choice with a text input
  - **Skip** and **Submit** buttons
  - Submit returns `{choice, otherText?}` to the waiting `ask_user_question`. Skip returns `skipped`.
  - On other channels it falls back to numbered options in plain text.
  - To support this, `ask_user_question` options gain an optional `description`.
- **Free text.** An "Other…" button opens a Slack modal with a `TextInput`. Where modals aren't available, the next
  thread reply from an authorized person is used, like the existing reject-reason capture.
- **Approvals in the thread.** The approval card goes in the run's thread, not the approver's DM, with the same
  binding. *Which* actions count as risky is a separate decision. Two candidate sources: the SDK's
  `canUseTool`/PreToolUse hook, and the gateway's write approvals, which already exist.
- **On the run card.** While a question or approval is pending, the card says "⏸ Waiting for @alice: …".

### 3.6 Configuration

Detail level is set per wiring (`messaging_group_agents`) or in `container.json`, with these options:

- `progress: off | concise | detailed` — defaults to `off` while we test, then `concise`
- `showCommands: false`
- `cardAfterMs: 8000`
- `responders: initiator+admins`

## 4. Core vs skill split, with upstreaming in mind

CONTRIBUTING only accepts fixes, simplifications and small seams into core. Features have to be skills.

| Change | Where | Upstream as |
|---|---|---|
| Bridge passes `status` to `startTyping` | core | fix |
| Bridge can edit a message into a card | core | small seam |
| Click checked before card edit; responder binding and expiry for questions | core | security/hardening fix |
| `ProgressDetail` added to `progress`, plus Claude/Cursor mapping and `summarizeStep` | core (provider contract) | seam; inert because nothing consumes it until a sink is installed |
| Turn-hook registry | core | upstream PR #3904 (already open) |
| Runner sink + host `run-progress` module + card renderer | **skill** `/add-run-progress` (payload on main) | feature skill |
| Slack typing status, Interactivity, optional native stream | `channels` branch + SKILL.md | channel change |
| Bound-action helper + in-thread approvals | core helper (seam) + skill for policy | split |

**Fork workflow:**

- Core work goes on feature branches in `main/`.
- Slack work goes on `channels/`, pushed to your fork.
- Apply skills to a dev install with `NANOCLAW_CHANNELS_REMOTE=origin` so the skill engine reads your fork's `channels`.

## 5. Milestones (each one demo-able)

1. **M0 – setup.**
   - Install dependencies, match CI's Bun, start Colima, build the image, get tests green.
   - Apply `/add-slack` on a dev branch.
   - Create a Slack test app with Socket Mode and Interactivity.
2. **M1 – events.** `ProgressDetail`, the Claude mapping, `summarizeStep` and the runner sink.
   Unit tests replay recorded SDK message streams into the expected snapshots. No UI yet; check it in the logs.
3. **M2 – typing status.** Forward `status` in the bridge. Slack shows "Inspecting…" or "Running tests…"
   if the agent features are on. This is the cheapest visible result.
4. **M3 – run card.** The host module, the table, throttling, end states and restart sweep, tested against a fake adapter.
   Then try it live in Slack.
5. **M4 – safe questions.** Deferred resolution, binding, expiry, ephemeral rejections and the "Other…" modal.
6. **M5 – approvals in the thread**, then the coding-workspace note and its implementation.

## Status

**M1 is done** (2026-11-12), committed as a5842b4e on `feat/slack-run-progress`.

**M3 is done** (2026-11-12) on the same branch. It is tested against a fake Slack only; it has not been seen in a real workspace yet.
- `src/channels/chat-sdk-bridge.ts`: display-card building is pulled into `buildDisplayCard`.
  `{type:'card', operation:'edit', messageId}` now edits a message into a card, using the same builder and limits as a posted card.
- `src/modules/run-progress/render.ts`: snapshot plus now → card and text fallback.
  - Title is `⏳ Working on it · 1m 24s`, `⏸️ Waiting for an answer`, `✅ Done`, `❌ Failed`, `⏹️ Stopped` or `⏹️ Interrupted`.
  - The body is the plan (✓ ◉ ○) plus "Latest: …", or the last 5 steps when there is no plan.
  - A summary line ("6 steps · 1 failed") is added at the end.
  - Agent text is neutralized: hidden characters are made visible, and `<`/`>` are swapped so text can't become a Slack mention or link.
- `src/modules/run-progress/manager.ts`: one card per run.
  - Posts it after 8s, or at once when the run starts waiting on a person.
  - Edits on change at most every 3s, refreshes every 15s, and writes the final state.
  - Marks a card "Interrupted" when its container has been gone for 30s.
  - Never reopens a finished run.
  - Starts at most 1 platform call per second across the install: final states first, refreshes last.
- `src/modules/run-progress/store.ts`: module migration `module:run-progress:cards` (table `run_progress_cards`).
  At startup, open cards are restored and closed as Interrupted if their container doesn't come back. Finished rows are pruned after 7 days.
- The runner now also puts the route in the payload, because system-action handlers don't see the row's columns.
  The host honors it only when it names the session's own chat.
- Known edge: if a host restart happens after a run's final snapshot was delivered but before the card's final edit,
  the card stays "Working" until the container exits. It then becomes "Interrupted".

Container side (`container/agent-runner/src/`):
- `progress/types.ts`: the progress model.
- `progress/summarize.ts`: safe step titles.
- `progress/tracker.ts`: builds the snapshot.
- `progress/sink.ts`: throttled `run_progress` system rows, on by default. `NANOCLAW_RUN_PROGRESS=off` turns it off.
- `providers/claude-progress.ts`: converts SDK `tool_use` / `tool_result` / `TodoWrite` / `ask_user_question` into progress events.
- `poll-loop.ts`: a run starts at the first progress event and ends at the turn's result. Retries keep it open; a throw ends it as failed or cancelled.

Host side:
- `src/modules/run-progress/` validates incoming snapshots and keeps the newest `seq` per run.

Tests after M3: 4,705 host tests and 699 agent-runner tests pass. Format and both typechecks are green.
M3 added 26 host tests (renderer, manager, store, target resolution, bridge card edit).

## 6. Decisions (2026-11-12)

1. **Progress is on by default** (`progress: concise`) for every wiring.
2. **No responder restrictions for the first test.** Anyone who can reach the bot can answer.
   Binding and expiry are still built: they protect against stale and duplicate clicks, not just bad actors.
3. **Agents & AI Apps is not available everywhere.**
   - It needs a paid Slack plan or a developer sandbox.
   - `assistant.threads.setStatus` is due to be deprecated in Feb 2027 in favour of `agents.sessions.setStatus`.
   - So the **Block Kit run card is the main UI**, and typing status / native task UI are best-effort extras.
4. **Plan or checklist:** build it from whatever the agent's todo tool emits, then try it.
5. **Not upstreaming for now.** Everything stays on the fork. We'll still keep the core/skill seams clean so
   upstreaming stays possible later.

## 7. Original open questions

1. **Default:** should progress be on for every Slack wiring, or opt-in per channel?
2. **Who may answer** questions and approvals by default: only the person who asked, that person plus admins, or anyone in the channel?
3. **Agent features:** does your Slack workspace allow the Agents & AI Apps feature (the typing status and native task UI)? Or should the design assume plain Block Kit only?
4. **Plan source:** is it fine to show the agent's own todo list (`TodoWrite`) on the card as the checklist?
5. **Upstreaming order:** should I open the small core fixes (typing status, check-before-edit) upstream early, or keep everything on the fork until it works end to end?
