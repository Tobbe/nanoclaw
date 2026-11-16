/**
 * Whether a raw Slack message mentions any user. `<@U123>` and `<@W123>`
 * (optionally `<@U123|name>`) are user mentions; `@channel`, `@here` and
 * `@everyone` are `<!channel>` and friends, which address everyone, so they
 * don't count. The bridge asks only about messages that don't mention the
 * bot, so true means the message is addressed to someone else.
 */
export function slackMentionsUsers(raw: Record<string, unknown>): boolean {
  return typeof raw.text === 'string' && /<@[UW][A-Z0-9]+(\|[^>]*)?>/.test(raw.text);
}
