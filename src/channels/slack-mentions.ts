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

/** Someone the bot may mention: a Slack user id and the names Slack knows them by. */
export interface MentionablePerson {
  id: string;
  /** Display name, or the real name when they have none. */
  userName?: string;
  fullName?: string;
}

/** Marks an `@` the adapter must leave alone: it links `@word`, but not `@` + U+2060. */
const KEEP_PLAIN = '@⁠';

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/**
 * Turn the `@Name` mentions an agent writes into real `<@U…>` mentions.
 *
 * Slack's adapter only resolves `@word` by display name, one word, and posts
 * anything it can't resolve as a literal `<@word>` that notifies nobody. So
 * `@Lise Engelbrecht`, for someone with no display name, came out as
 * `<@Lise> Engelbrecht`. Here a mention matches someone's full or display
 * name (longest first, so the whole name is taken), else their first name
 * when only one person has it. One that still matches no one, or more than
 * one person, stays plain text. Code spans, `<…>` tokens, URLs and e-mail
 * addresses are left as they are.
 */
export function resolveSlackMentions(text: string, people: MentionablePerson[]): string {
  if (!text.includes('@')) return text;
  const names: { name: string; ids: Set<string> }[] = [];
  const firstNames = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(id);
    map.set(key, set);
  };
  const full = new Map<string, Set<string>>();
  for (const p of people) {
    for (const n of [p.fullName, p.userName]) {
      const name = n?.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!name || name === p.id.toLowerCase()) continue;
      add(full, name, p.id);
      add(firstNames, name.split(' ')[0], p.id);
    }
  }
  for (const [name, ids] of full) names.push({ name, ids });
  names.sort((a, b) => b.name.length - a.name.length);

  let out = '';
  let i = 0;
  while (i < text.length) {
    // Code: ``` fences and single-line `spans`.
    if (text[i] === '`') {
      const marker = text.startsWith('```', i) ? '```' : '`';
      const close = text.indexOf(marker, i + marker.length);
      if (close !== -1 && (marker === '```' || !text.slice(i, close).includes('\n'))) {
        out += text.slice(i, close + marker.length);
        i = close + marker.length;
        continue;
      }
    }
    // Slack tokens: <@U…>, <!channel>, <https://…|label>.
    if (text[i] === '<') {
      const close = text.indexOf('>', i);
      if (close !== -1 && !text.slice(i, close).includes('\n')) {
        out += text.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    // URLs, which may contain /@handle.
    const url = /^https?:\/\/\S+/.exec(text.slice(i, i + 2048));
    if (url) {
      out += url[0];
      i += url[0].length;
      continue;
    }
    if (text[i] === '@' && !isWordChar(text[i - 1]) && isWordChar(text[i + 1])) {
      const rest = text.slice(i + 1).toLowerCase();
      const whole = names.find((n) => rest.startsWith(n.name) && !isWordChar(text[i + 1 + n.name.length]));
      if (whole && whole.ids.size === 1) {
        out += `<@${[...whole.ids][0]}>`;
        i += 1 + whole.name.length;
        continue;
      }
      let end = i + 1;
      while (isWordChar(text[end])) end += 1;
      const word = text.slice(i + 1, end);
      const ids = /^[UW][A-Z0-9]{6,}$/.test(word) ? new Set([word]) : firstNames.get(word.toLowerCase());
      out += ids && ids.size === 1 && !whole ? `<@${[...ids][0]}>` : `${KEEP_PLAIN}${word}`;
      i = end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}
