import type { SlackAdapter } from '@chat-adapter/slack';
import { describe, expect, it, vi } from 'vitest';

import { resolveSlackThreadMentions } from './slack.js';

const users: Record<string, { userId: string; userName?: string; fullName?: string; isBot: boolean }> = {
  U0LISE0001: { userId: 'U0LISE0001', fullName: 'Lise Engelbrecht', isBot: false },
  U0TOBBE001: { userId: 'U0TOBBE001', userName: 'Tobbe', fullName: 'Tobbe Lundberg', isBot: false },
  U0BOT00001: { userId: 'U0BOT00001', userName: 'CodeBot', isBot: true },
};

function fakeAdapter(channel: string, members: string[], participants: string[]) {
  const membersCall = vi.fn(async () => ({ members }));
  const adapter = {
    chat: { getState: () => ({ getList: async () => participants }) },
    getUser: async (id: string) => users[id] ?? null,
    decodeThreadId: () => ({ channel, threadTs: '1.1' }),
    webClient: { conversations: { members: membersCall } },
  } as unknown as SlackAdapter;
  return { adapter, membersCall };
}

describe('resolveSlackThreadMentions', () => {
  it('tags someone in the channel who has not posted in the thread', async () => {
    const { adapter } = fakeAdapter('C0TEST0001', ['U0LISE0001', 'U0TOBBE001', 'U0BOT00001'], ['U0LISE0001']);
    expect(await resolveSlackThreadMentions(adapter, '<@U0LISE0001>, @Tobbe knows', 'slack:C0TEST0001:1.1')).toBe(
      '<@U0LISE0001>, <@U0TOBBE001> knows',
    );
  });

  it('asks Slack for the members only when the thread falls short, then caches them', async () => {
    const { adapter, membersCall } = fakeAdapter('C0TEST0002', ['U0LISE0001', 'U0TOBBE001'], ['U0LISE0001']);
    await resolveSlackThreadMentions(adapter, '@Lise', 'slack:C0TEST0002:1.1');
    expect(membersCall).not.toHaveBeenCalled();
    await resolveSlackThreadMentions(adapter, '@Tobbe', 'slack:C0TEST0002:1.1');
    await resolveSlackThreadMentions(adapter, '@Tobbe again', 'slack:C0TEST0002:1.1');
    expect(membersCall).toHaveBeenCalledTimes(1);
  });

  it('keeps the plain name when Slack refuses the member list', async () => {
    const { adapter, membersCall } = fakeAdapter('C0TEST0003', [], ['U0LISE0001']);
    membersCall.mockRejectedValue(new Error('missing_scope'));
    expect(await resolveSlackThreadMentions(adapter, '@Tobbe', 'slack:C0TEST0003:1.1')).toBe('@⁠Tobbe');
  });
});
