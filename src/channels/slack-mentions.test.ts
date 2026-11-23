import { describe, expect, it } from 'vitest';

import { hasUnresolvedMention, resolveSlackMentions, slackMentionsUsers } from './slack-mentions.js';

describe('slackMentionsUsers', () => {
  it('sees user mentions', () => {
    expect(slackMentionsUsers({ text: '<@U0C0Y14JRC0> start a new thread' })).toBe(true);
    expect(slackMentionsUsers({ text: 'ask <@W12AB|lise> about it' })).toBe(true);
  });

  it('ignores channel-wide mentions, plain text and missing text', () => {
    expect(slackMentionsUsers({ text: '<!channel> heads up' })).toBe(false);
    expect(slackMentionsUsers({ text: '<!here>' })).toBe(false);
    expect(slackMentionsUsers({ text: 'email me @ tobbe' })).toBe(false);
    expect(slackMentionsUsers({})).toBe(false);
  });
});

describe('resolveSlackMentions', () => {
  const people = [
    { id: 'U0LISE0001', userName: 'Lise Engelbrecht', fullName: 'Lise Engelbrecht' },
    { id: 'U0TOBBE001', userName: 'Tobbe', fullName: 'Tobbe Lundberg' },
  ];
  const plain = (name: string) => `@⁠${name}`;

  it('takes a whole name when it matches one', () => {
    expect(resolveSlackMentions('@Lise Engelbrecht, dine tre rettelser', people)).toBe(
      '<@U0LISE0001>, dine tre rettelser',
    );
    expect(resolveSlackMentions('Forstået @tobbe lundberg.', people)).toBe('Forstået <@U0TOBBE001>.');
  });

  it('takes a display name or a first name only one person has', () => {
    expect(resolveSlackMentions('@Tobbe and @Lise', people)).toBe('<@U0TOBBE001> and <@U0LISE0001>');
  });

  it('keeps a raw id mention and links a bare id', () => {
    expect(resolveSlackMentions('<@U0LISE0001> and @U0TOBBE001', people)).toBe('<@U0LISE0001> and <@U0TOBBE001>');
  });

  it('leaves a name it cannot place as plain text, never <@Name>', () => {
    expect(resolveSlackMentions('@Mads and @channel', people)).toBe(`${plain('Mads')} and ${plain('channel')}`);
    const twoLises = [...people, { id: 'U0LISE0002', fullName: 'Lise Hansen' }];
    expect(resolveSlackMentions('@Lise', twoLises)).toBe(plain('Lise'));
  });

  it('leaves code, links, tokens and e-mail addresses alone', () => {
    const text = 'mail lise@effibo.dk, see `@Lise` and https://x.com/@Lise or <https://a.b|@Lise>';
    expect(resolveSlackMentions(text, people)).toBe(text);
  });

  it('tries the wider list only for a mention the thread cannot place', () => {
    const thread = [people[0]];
    const channel = [...people, { id: 'U0LISE0002', fullName: 'Lise Hansen' }];
    // Tobbe hasn't posted in the thread; the channel knows him.
    expect(resolveSlackMentions('<@U0LISE0001>, @Tobbe knows', thread, channel)).toBe(
      '<@U0LISE0001>, <@U0TOBBE001> knows',
    );
    // Two Lises in the channel, but the thread's Lise wins.
    expect(resolveSlackMentions('@Lise', thread, channel)).toBe('<@U0LISE0001>');
    expect(resolveSlackMentions('@Mads', thread, channel)).toBe(plain('Mads'));
  });

  it('says when a mention was left as plain text', () => {
    expect(hasUnresolvedMention(resolveSlackMentions('@Tobbe', [people[0]]))).toBe(true);
    expect(hasUnresolvedMention(resolveSlackMentions('@Tobbe', people))).toBe(false);
  });
});
