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

/** True when resolving left some `@word` as plain text, so a wider list may help. */
export function hasUnresolvedMention(text: string): boolean {
  return text.includes(KEEP_PLAIN);
}

interface NameIndex {
  names: { name: string; ids: Set<string> }[];
  firstNames: Map<string, Set<string>>;
}

function indexPeople(people: MentionablePerson[]): NameIndex {
  const full = new Map<string, Set<string>>();
  const firstNames = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(id);
    map.set(key, set);
  };
  for (const p of people) {
    for (const n of [p.fullName, p.userName]) {
      const name = n?.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!name || name === p.id.toLowerCase()) continue;
      add(full, name, p.id);
      add(firstNames, name.split(' ')[0], p.id);
    }
  }
  const names = [...full].map(([name, ids]) => ({ name, ids }));
  names.sort((a, b) => b.name.length - a.name.length);
  return { names, firstNames };
}

/**
 * Turn the `@Name` mentions an agent writes into real `<@U…>` mentions.
 *
 * Slack's adapter only resolves `@word` by display name, one word, and posts
 * anything it can't resolve as a literal `<@word>` that notifies nobody. So
 * `@Lise Engelbrecht`, for someone with no display name, came out as
 * `<@Lise> Engelbrecht`. Here a mention matches someone's full or display
 * name (longest first, so the whole name is taken), else their first name
 * when only one person has it. `wider` is a second list (the channel's
 * members) tried only for a mention the first list (the thread's people)
 * can't place, so a thread participant wins a shared first name. One that
 * still matches no one, or more than one person, stays plain text. Code
 * spans, `<…>` tokens, URLs and e-mail addresses are left as they are,
 * except `<!channel>`, `<!here>` and `<!everyone>`: the agent must never
 * notify a whole channel, so those become plain text.
 */
export function resolveSlackMentions(
  text: string,
  people: MentionablePerson[],
  wider: MentionablePerson[] = [],
): string {
  if (!text.includes('@') && !text.includes('<!')) return text;
  const tiers = [indexPeople(people), ...(wider.length ? [indexPeople(wider)] : [])];

  // The id `@` + rest of the text at `at` resolves to, and how many characters it spans.
  const place = (at: number): { id: string; length: number } | null => {
    const rest = text.slice(at + 1).toLowerCase();
    let end = at + 1;
    while (isWordChar(text[end])) end += 1;
    const word = text.slice(at + 1, end);
    if (/^[UW][A-Z0-9]{6,}$/.test(word)) return { id: word, length: end - at };
    for (const { names, firstNames } of tiers) {
      const whole = names.find((n) => rest.startsWith(n.name) && !isWordChar(text[at + 1 + n.name.length]));
      if (whole) {
        if (whole.ids.size === 1) return { id: [...whole.ids][0], length: 1 + whole.name.length };
        return null;
      }
      const ids = firstNames.get(word.toLowerCase());
      if (ids?.size === 1) return { id: [...ids][0], length: end - at };
      if (ids) return null;
    }
    return null;
  };

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
        const broadcast = /^<!(channel|here|everyone)(\|[^>]*)?>$/.exec(text.slice(i, close + 1));
        out += broadcast ? `${KEEP_PLAIN}${broadcast[1]}` : text.slice(i, close + 1);
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
      const hit = place(i);
      if (hit) {
        out += `<@${hit.id}>`;
        i += hit.length;
        continue;
      }
      let end = i + 1;
      while (isWordChar(text[end])) end += 1;
      out += `${KEEP_PLAIN}${text.slice(i + 1, end)}`;
      i = end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}
