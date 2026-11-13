/**
 * Read what was said in the team channels (CodeBot Team's chats).
 *
 *   bun /workspace/agent/tools/team-messages.ts            # last 50 messages
 *   bun /workspace/agent/tools/team-messages.ts deploy     # messages containing "deploy"
 *   bun /workspace/agent/tools/team-messages.ts --limit 200 pricing
 *
 * Read-only: the team agent's session databases are mounted read-only at
 * /workspace/extra/team/sessions. Prints one line per message, oldest first:
 *   <local time>  <channel/thread>  <who>: <text>
 * Your own (CodeBot's) messages in the channels are shown as "me".
 */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'fs';

const ROOT = '/workspace/extra/team/sessions';
const args = process.argv.slice(2);
let limit = 50;
const li = args.indexOf('--limit');
if (li >= 0) {
  limit = Number(args[li + 1]) || limit;
  args.splice(li, 2);
}
const needle = args.join(' ').toLowerCase();

interface Row {
  id: string;
  timestamp: string;
  thread_id: string | null;
  who: string;
  text: string;
}

if (!existsSync(ROOT)) {
  console.error(`No team data mounted at ${ROOT}.`);
  process.exit(1);
}

const seen = new Map<string, Row>();
for (const dir of readdirSync(ROOT)) {
  const base = `${ROOT}/${dir}`;
  if (!existsSync(`${base}/inbound.db`)) continue;
  try {
    const inbound = new Database(`${base}/inbound.db`, { readonly: true });
    for (const r of inbound
      .query(
        `select id, timestamp, thread_id,
                case
                  when json_extract(content,'$.author.isMe') = 1 then 'me'
                  when coalesce(json_extract(content,'$.senderName'), json_extract(content,'$.sender'))
                       in ('CodeBot', 'CodeBot Team') then 'me'
                  else coalesce(json_extract(content,'$.senderName'), json_extract(content,'$.sender'), 'someone')
                end as who,
                coalesce(json_extract(content,'$.text'), '') as text
           from messages_in where kind in ('chat','chat-sdk')`,
      )
      .all() as Row[]) {
      seen.set(`${r.timestamp}|${r.text}`, r);
    }
    inbound.close();
  } catch (err) {
    console.error(`skipped ${dir}/inbound.db: ${(err as Error).message}`);
  }
  if (!existsSync(`${base}/outbound.db`)) continue;
  try {
    const outbound = new Database(`${base}/outbound.db`, { readonly: true });
    for (const r of outbound
      .query(
        `select id, timestamp, thread_id, 'me' as who,
                coalesce(json_extract(content,'$.text'), '') as text
           from messages_out where kind = 'chat'`,
      )
      .all() as Row[]) {
      seen.set(`${r.timestamp}|${r.text}`, r);
    }
    outbound.close();
  } catch (err) {
    console.error(`skipped ${dir}/outbound.db: ${(err as Error).message}`);
  }
}

// The bot's own channel replies are recorded twice (as its reply, and as
// channel context): keep one when the same text appears within a few seconds.
const sorted = [...seen.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
const deduped = sorted.filter(
  (r, i) =>
    !sorted
      .slice(0, i)
      .some((p) => p.text === r.text && Math.abs(Date.parse(r.timestamp) - Date.parse(p.timestamp)) < 10_000),
);

const rows = deduped
  .filter((r) => r.text && (!needle || r.text.toLowerCase().includes(needle) || r.who.toLowerCase().includes(needle)))
  .slice(-limit);

for (const r of rows) {
  const when = new Date(r.timestamp).toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Europe/Stockholm' });
  const where = (r.thread_id ?? '').replace(/^slack:/, '');
  console.log(`${when}  ${where}  ${r.who}: ${r.text.replace(/\s+/g, ' ')}`);
}
if (rows.length === 0) console.log(needle ? `No team messages mention "${needle}".` : 'No team messages yet.');
