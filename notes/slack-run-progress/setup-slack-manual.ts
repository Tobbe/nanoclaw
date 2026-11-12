/**
 * Connect Slack with an app you created yourself (Socket Mode tokens).
 *
 * The setup wizard always sends Slack through the NanoClaw account portal
 * (setup/channels/slack-auto.ts: portalEnabled() is always true), and
 * declining the portal returns to channel selection. This runs the same
 * channel flow the wizard uses, minus that pre-step: the add-slack skill
 * (adapter install, token prompts, owner member ID) and then the wiring.
 *
 * Run from the project root, in a real terminal:
 *   pnpm exec tsx notes/slack-run-progress/setup-slack-manual.ts
 */
import * as p from '@clack/prompts';

import { runChannelSkill } from '../../setup/channels/run-channel-skill.js';

p.intro('Connect Slack (your own app, Socket Mode)');
const result = await runChannelSkill('slack', 'Tobbe', { agentName: 'CodeBot', role: 'owner' });
p.outro(`Done: ${typeof result === 'symbol' ? String(result) : JSON.stringify(result)}`);
