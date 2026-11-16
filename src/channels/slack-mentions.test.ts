import { describe, expect, it } from 'vitest';

import { slackMentionsUsers } from './slack-mentions.js';

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
