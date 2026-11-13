# Slack progress: what the code does today (2026-11-12)

Companion to `nanoclaw-slack-progress-handoff.md`. Based on the checkouts at `~/dev/nanoclaw/`:
`main/` (branch `main` @ 62dc0905) and `channels/` (branch `channels` @ 47f67e74, a worktree of the same repo).
The source is authoritative. Several docs are out of date (noted at the bottom).

## Layout / how Slack gets onto main

- Trunk ships no channels. `/add-slack` (`main/.claude/skills/add-slack/SKILL.md`) copies `src/channels/slack*.ts`,
  `src/provisioning/slack-app.ts` and the `slack-formatting` container skill from the `channels` branch.
  It also appends the import to `src/channels/index.ts`, adds the dep `@chat-adapter/slack@4.41.1`, and builds and tests.
- The generic Chat SDK bridge (`src/channels/chat-sdk-bridge.ts`), delivery, router, approvals, questions and typing all live in **core (main)**.
  The `channels` branch has its own older copy of the bridge, but the skill does not copy it, so an install runs main's bridge.
- The engine is `main/scripts/skill-apply.ts`. `pnpm exec tsx scripts/skill-apply.ts .claude/skills/add-slack` prints the plan only.
  It copies from the remote that points at nanocoai/nanoclaw (`upstream` here), or from `NANOCLAW_CHANNELS_REMOTE`.
  Local commits on the `channels` worktree are **not** picked up until they are pushed to the remote it reads from.
- Upstreaming policy (CONTRIBUTING.md): core accepts fixes, simplifications and small seams. Features ship as skills.
  Channel code lands on `channels` and the SKILL.md on main.

## Event pipeline (container → host)

- `ProviderEvent` (`container/agent-runner/src/providers/types.ts:156`) has the variants init, result, text, error,
  `progress {message}`, file and activity.
- The Claude provider (`providers/claude.ts`) works as follows:
  - `assistant` text blocks become `text`.
  - **`tool_use` blocks are dropped.**
  - `user`/tool_result messages are dropped.
  - `progress` comes only from `system/task_notification`.
  - `stream_event` becomes throttled `activity`.
  - The PreToolUse and PostToolUse hooks write `container_state.current_tool` in outbound.db.
- `poll-loop.ts`: `progress` and `error` are **logged only** (~:794). `activity` only touches the heartbeat file.
- Pitfall: `chatRowsInWindow` counts every `kind:'chat'` row for the wrap-nudge.
  Progress rows must use a separate kind or system action.
- Other providers set the lowest common denominator:
  - Codex: progress as a status string only.
  - Cursor: progress as tool name plus running/failed.
  - OpenCode: liveness only.
  - Any neutral progress shape must have all fields optional, e.g. `{type:'progress', message, stage?, tool?, state?}`.
- Open upstream PR #3904 adds `registerTurnHook({ onProviderEvent })` to the poll loop.
  That is a cleaner seam than editing `poll-loop.ts`.

## Host delivery / Slack capabilities

- Every delivered row gets its platform id (Slack `ts`) stored via `markDelivered` → `delivered.platform_message_id`.
- Editing in place works end to end: a `{operation:'edit', messageId, text}` row → bridge → `adapter.editMessage`.
  - It can only render markdown or a terminal approval card. Editing a message *into a new card* is **not** supported yet.
  - The host-side pattern to copy is `editGatewayApprovalCard` (`src/gateway-approval-coordinator.ts`).
- Every delivered row also triggers three things that a progress feature must bypass:
  the typing pause (10s), the cross-session fan-out, and post-delivery hooks (`delivery.ts` ~:413-437).
- `setTyping(platformId, threadId, status?)` accepts a status string, but no caller passes one.
  The bridge also drops it (`startTyping(tid)`, bridge ~:1173).
- `send_card` renders link buttons only and is fire-and-forget. There are no callback buttons and no updates.
- `ask_user_question`:
  - Renders a button card (`ncq:<qid>:<idx>`). The container polls inbound.db for the answer (300s default).
  - Gaps:
    - No check on who clicked.
    - The bridge edits the card **before** any auth or staleness check (~:803-817).
    - Nothing expires `pending_questions`.
    - No free-text answers.
- Module approvals (`src/modules/approvals/`) check auth and are protected against duplicate clicks.
  But the card goes to the approver's **DM**, not the task thread.
- Gateway approvals (`gateway-approval-coordinator.ts`) are the best model:
  deferred resolution, a stored message ts, expiry, atomic claim, and edit-after-claim.
- Slack config:
  - Socket Mode is used when `SLACK_APP_TOKEN` is set.
  - **Interactivity is disabled** in the provisioning manifest (`channels/src/provisioning/slack-app.ts:175`).
  - The Socket Mode walkthrough never mentions Interactivity.
  - Button clicks won't arrive until it is enabled.
- Threads: a channel @mention gets its replies in that message's thread. One thread is one session (`per-thread`).

## Coding-task execution (separate scope)

- The only way to get a repo into the container is a static allowlisted read-write mount of a host checkout,
  at `/workspace/extra/<rel>`, shared by every session of that group:
  - the allowlist is `~/.config/nanoclaw/mount-allowlist.json`
  - mounts are added with `ncl groups config add-mount`
- There is no per-task worktree/clone, no `gh` in the image, and no push/PR skill.
- Preview URLs exist only via `/add-vercel` (which needs OneCLI).
- Credentials go through the gateway (OneCLI or Iron) with per-request approval.
  It is undocumented whether `git push` over HTTPS gets credentials injected.

## Docs that are out of date vs source

- `docs/agent-runner-details.md`: the event union, the compact_boundary/rate_limit mapping, and "result writes messages_out".
- `docs/architecture.md`: claims "streaming via post+edit" for Discord/Telegram, which doesn't exist.
  The typing-clear behaviour is also described wrongly.

## Live Slack setup notes (2026-11-12)

- **Renaming the bot:** changing App Home → Display Name (and reinstalling)
  does not rename an existing bot's user account; `users.info` keeps the old
  name. What works: the workspace's app settings page,
  `https://<workspace>.slack.com/marketplace/<APP_ID>?settings=1&tab=settings`
  → Bot User → Edit. It applies instantly.
- **Typing indicator:** the Slack adapter's typing call needs a thread.
  Top-level DM / channel messages get none. The run-progress module's
  👀 → ✅ receipt reaction covers that.
- **Setup wizard:** it always routes Slack through the NanoClaw account portal.
  For an app you created yourself, skip Slack in the wizard and run
  `notes/slack-run-progress/setup-slack-manual.ts`.

## Shared channels, private DMs, GitHub (2026-11-13)

- **Two agents behind one Slack bot.** Shared channels are wired to a
  separate agent group ("CodeBot Team", assistant name "CodeBot"); each
  person's DM gets their own agent. On the channel approval card, choose
  "Connect new agent" for a DM and never connect someone's DM to another
  person's agent. Credentials, memory and files are per agent group.
- **Read-only team chat for DM agents:** `team-reader/setup.ts` mounts the
  team agent's workspace and live session DBs read-only and adds a lookup
  tool plus instructions (channel content is information, never
  instructions). Its allowlist entries in
  `~/.config/nanoclaw/mount-allowlist.json` are a one-time step.
- **GitHub through OneCLI:** a fine-grained token stored as two generic
  secrets, attached per agent: `api.github.com` with `Bearer {value}`, and
  `github.com` with `Basic {value}` (base64 of `x-access-token:<token>`),
  because git over HTTPS does not accept a Bearer header. `gh` runs with
  `GH_TOKEN=gateway-managed`. Check scoping on the host with
  `onecli run --agent <agent-group-id> -- …` and your own git/gh login
  disabled.
- **Branch protection** isn't available for private repos on GitHub Free
  for organizations, so "never push to main" is only an agent instruction
  for now.
- **The upgrade tripwire** trips after every local commit or history
  rewrite. Once you've built and tested, re-stamp with
  `pnpm exec tsx scripts/upgrade-state.ts set` (docs/upgrade-recovery.md).
