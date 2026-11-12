# Handoff: NanoClaw Slack coding progress

## User goal

Build toward a Slack experience where a teammate can ask NanoClaw to do coding work and the rest of the team can see what is happening while it runs.

### Desired experience for the team

- A teammate mentions the agent in a channel; NanoClaw responds in that message's thread and keeps the task visible there.
- One updating progress card/message gives a readable sense of the work: current stage, checklist or milestones, safe tool activity, and whether the run is waiting for a person.
- The card updates in place as work progresses. It should not flood the channel with a post for every token or tool event.
- When NanoClaw needs input, teammates can respond through Slack controls (choice buttons/selects, and potentially free text or a form) and the correct in-flight task resumes.
- Risky actions can request approval in Slack, with the decision bound to the authorized Slack user and task.
- The completed reply summarizes changes and test results and links to a diff or PR when the coding workflow provides one. Failures and cancellations should be clear too.
- Show concise narration/status and useful activity, not private model reasoning. Keep raw commands, paths, and sensitive output hidden or configurable by default.

### Example: a marketing teammate edits a landing page

A teammate in marketing asks in Slack to change a headline, button text, or other small landing-page detail. The agent asks follow-up questions in the thread if needed, edits an approved repository in an isolated workspace, and posts progress while it works. It then shares a preview URL and a short change summary (plus a diff or PR); a human reviews and approves before publication. The initial use case should be limited to approved sites and small content edits, with publish access gated separately from proposing changes. The interaction should feel usable to someone who does not know Git.

The user is open to some changes eventually being upstreamed into NanoClaw core. Do not assume every capability must remain a user-installed skill. Evaluate core abstractions versus channel/provider-specific skill boundaries, and keep the design upstreamable where practical.

## Conversation context and implementation choice

- The user compared NanoClaw with OpenClaw, Hermes Agent, and OpenACP. The useful comparison is their Slack task-progress and interaction UX; see the inspiration notes below.
- We inspected [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp). It wraps the Claude Agent SDK in ACP and exposes structured tool/progress, permission, and elicitation events.
- **We decided to defer ACP for the first implementation.** NanoClaw already calls the Claude Agent SDK directly, so adding ACP first would introduce a client/protocol/session layer before Slack can display progress. Revisit ACP if supporting multiple interchangeable ACP agents becomes a near-term requirement.
- The user wants to try a patched local NanoClaw first and may later move it to a VPS. NanoClaw v2 supports Linux/Docker, and the Slack add-on uses Socket Mode by default, so a public webhook URL is generally unnecessary.

## Current workspace state

The current Codex workspace at `/Users/tobbe/Documents/Codex/2026-11-11/nano` does **not** contain a NanoClaw checkout. It only has `work/` and `outputs/` directories. Before implementation, obtain/clone the intended NanoClaw fork and branch here, then inspect its `AGENTS.md`, `CLAUDE.md`, contribution guidance, and source. NanoClaw changes quickly; source is authoritative over architecture drafts.

## NanoClaw findings to verify against the checkout

- Current NanoClaw is v2. Slack is an add-on channel skill rather than a channel shipped in trunk. See [NanoClaw changelog](https://github.com/nanocoai/nanoclaw/blob/main/CHANGELOG.md), [skills repository](https://github.com/nanocoai/nanoclaw-skills), and [contribution guidance](https://github.com/nanocoai/nanoclaw/blob/main/CONTRIBUTING.md).
- The Slack skill uses Socket Mode by default. For local experiments use a dedicated Slack app/workspace if possible. During VPS cutover, only one instance should consume the same Slack bot connection at a time.
- NanoClaw's provider boundary returns an `AsyncIterable<ProviderEvent>`. Current events include `init`, `result`, `error`, `progress`, and `activity`.
- The Claude provider wraps `@anthropic-ai/claude-agent-sdk`'s `query()`. Its translator currently yields `activity` for underlying SDK events and maps a limited set to result/error/progress. `progress` is described as logging-only; the agent runner does not deliver it to channels. This is likely the shortest seam for a first progress implementation.
- NanoClaw already has card and interactive-choice mechanisms. The documented `send_card` is mainly display-oriented with URL buttons; `ask_user_question` returns choice selections to the agent. Inspect the current Slack adapter's actual callback/update behavior before assuming more.
- Current architecture docs explicitly warn that they are drafts and may drift. Verify details against actual source.

Useful references:

- [NanoClaw agent-runner details](https://github.com/nanocoai/nanoclaw/blob/main/docs/agent-runner-details.md)
- [NanoClaw architecture](https://github.com/nanocoai/nanoclaw/blob/main/docs/architecture.md)
- [NanoClaw Slack skill repository](https://github.com/nanocoai/nanoclaw-skills)
- [NanoClaw customization guidance](https://github.com/nanocoai/nanoclaw/blob/main/docs/customizing.md)
- [Claude ACP adapter, deferred option](https://github.com/agentclientprotocol/claude-agent-acp)
- [NanoClaw issue #1440: No intermediate feedback during long-running agent sessions](https://github.com/nanocoai/nanoclaw/issues/1440) — discusses progress updates/tool-use summaries while long tasks run.
- [NanoClaw issue #1686: Long-running session mode for deep work dispatch](https://github.com/nanocoai/nanoclaw/issues/1686) — proposes persistent sessions and streamed responses for deep work; its proposal is Telegram-focused.
- [NanoClaw PR #1687: `/deep` mode for long-running sessions](https://github.com/nanocoai/nanoclaw/pull/1687) — preserves a container session across turns (1-hour idle timeout, 4-hour maximum); addresses session lifetime/context continuity, not user-visible progress.
- [NanoClaw PR #3936: opt-in Telegram live progress message](https://github.com/nanocoai/nanoclaw/pull/3936) — sends an editable “Working on it…” message with elapsed time during long turns, then deletes it when work ends. It is Telegram-specific and opt-in via `TELEGRAM_PROGRESS_MESSAGE=true`; it does not currently surface tool/step status because the host does not pass that status yet.

## Slack integration patterns to study

Use these as UX/implementation references, not necessarily as dependencies. Inspect current docs/code before copying implementation details.

### OpenACP: live activity as the aspiration

- Its advertised UX emphasizes live agent output, tool calls, and permission requests, with Slack sessions organized around channels/threads and action buttons. This is a useful reference for how much work can be visible and how approvals can interrupt a run.
- Do not depend on its implementation as-is: as of the handoff date, the GitHub link on [openacp.ai](https://openacp.ai/) points to a repository URL that returns 404. The fork we found is [phpclub/ai-OpenACP](https://github.com/phpclub/ai-OpenACP); it identifies itself as forked from the missing upstream, so treat it as a reference rather than assuming it is the maintained canonical source.
- References: [OpenACP site](https://openacp.ai/), [found fork](https://github.com/phpclub/ai-OpenACP).

### OpenClaw: progress cards and polished Slack-native output

- In a Slack thread, progress mode can keep narration and a live plan/task card together; detailed per-tool rows are configurable. This is a strong reference for one evolving task view rather than a flood of status posts.
- It also supports partial/native Slack text streaming and structured Block Kit presentations, including native tables/charts and approval/modal surfaces. These are separate capabilities from the progress card.
- References: [Slack streaming behavior](https://github.com/openclaw/openclaw/blob/main/docs/concepts/streaming.md), [Slack rich messages](https://docs.openclaw.ai/channels/slack/rich-messages).

### Hermes: tool rows, live status, and clarification controls

- Its Slack-native task card shows one row per tool call with running/complete/error updates. A separate status line can show a current operation such as running tests or reading a file.
- Clarification prompts use one-tap choices plus an “Other” free-text path; approval prompts are interactive too. This is a useful pattern for Claude asking the team questions and waiting for an answer.
- Caveat: Hermes task cards need a thread and are opt-in, as is gateway streaming. Decide which behaviors should be NanoClaw defaults rather than inheriting Hermes defaults.
- References: [Hermes Slack docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack), [Hermes streaming/configuration docs](https://hermes-agent.nousresearch.com/docs/user-guide/configuration).

### Suggested NanoClaw direction

Combine the useful patterns: OpenClaw/Hermes-style single updating Slack task card; OpenACP-style visibility into useful execution activity; Hermes-style question/approval controls. Keep the card concise by default, with optional detailed tool activity. Reuse NanoClaw's current Slack card and question mechanisms where possible, but inspect the actual adapter contract first.

Implementation-wise, extend NanoClaw's existing Claude SDK event handling and emit a provider-neutral event model. ACP is deferred; the short rationale is above.

## Proposed implementation stages

1. **Inspect and write a small design note.** Confirm current SDK event types, agent-runner handling, Slack adapter capabilities, message edit support, interaction callbacks, and provider-contract conventions. Assess what belongs in core versus channel/provider skills with upstreaming in mind.
2. **Provider-neutral progress events.** Extend event handling so useful statuses/tool lifecycle events reach the host instead of only serving as liveness signals or logs.
3. **Thread-level progress card.** Create/update one Slack task card per run. Support concise default status and optional detailed tool rows, plans/checklists, question-waiting, approval-waiting, completion/failure/cancel states. Fall back to readable text when rich rendering is unavailable.
4. **Interactive responses.** Route button/selection/free-text/form submissions to the correct pending question or approval. Bind each callback to the initiating user, channel, thread, and request; handle stale/duplicate clicks safely.
5. **Coding-task execution boundary (separate scope).** Determine whether a task can access a pre-mounted code workspace today. If the target is “clone repo, work safely, run tests, open PR,” add/configure isolated repository/worktree setup and GitHub permissions separately from progress UI.
6. **VPS cutover later.** Linux/Docker is supported. Preserve the customized checkout and add-on skills. If conversation continuity matters, migrate a stopped install's persistent state (central DB, session DBs, group folders/memory) and separately re-authenticate or securely migrate the credential gateway and Slack app secrets. Verify on VPS before disabling the local instance.

## Initial acceptance criteria

- A coding task launched from Slack gets a thread-level place for progress, then that one progress card updates instead of generating status spam.
- Teammates can distinguish inspection/planning, edits, test execution, waiting on a person, and completion/failure/cancellation.
- Optional details show safe tool summaries and plan/checklist state; private reasoning and raw sensitive command output stay hidden.
- The agent can ask a structured question; teammates can choose an answer or provide free text when needed, and the correct task resumes.
- Risky operations can pause for Slack approval with a clear action summary; only an authorized user can approve or deny.
- The final reply reports useful outcomes (changed files, tests, diff/PR links when available) and does not duplicate already-streamed content.
- Restarts, Slack API errors/rate limits, cancellation, stale actions, and duplicate deliveries do not leave misleading cards or lose the final result.
- Status can fall back to readable text on other channels; Slack-specific blocks/actions do not leak into provider contracts.
- Core/skill split is deliberately evaluated with the user's upstreaming interest in mind.

## Scope cautions

- Do not equate progress UI with a full coding-agent workflow. Repository checkout, isolated worktrees, branch handling, CI/test reporting, and PR creation may be additional work.
- Do not assume `send_card` supports arbitrary Block Kit actions, modals, or editable task cards. Inspect the adapter's send, update, and callback paths first.
- Do not run local and VPS instances concurrently against the same bot during cutover.
- Freshly review source before implementation; web documentation may be ahead of or differ from the eventual checkout.
