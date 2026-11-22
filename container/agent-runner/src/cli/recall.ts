/**
 * `ncl sessions recall --question "…"` — answer "what did we say about X?"
 * by meaning, across every thread the agent can read.
 *
 * The host keeps a short record per thread (thread-record.ts) and serves
 * them with `ncl sessions records --all`, but has no model access. So the
 * container's ncl answers recall itself: fetch the records, hand them and
 * the question to the small model, print what it picks. The words need not
 * match ("farver" finds "Color (farve): navy"), which `ncl sessions search`
 * can't do.
 */
export const RECALL_COMMAND = 'sessions-recall';
const NO_MATCH = 'NONE';

export const RECALL_INSTRUCTIONS = [
  'Below are short records of a team’s chat threads, each headed by [when · where · session id].',
  'Find the threads that answer or bear on the question, judging by meaning in any language',
  '(Danish, English, …), not by matching words.',
  '',
  'A topic can span threads: one asks for something, another shows it was done or changed, often under',
  'another name (a "real case" asked for in one thread can be "the case text in PR #12" in another).',
  'A record\'s "Since this record" lines are newer than the record: read them too.',
  'Include the threads that settle or update what the question is about, not only the one where it was raised.',
  '',
  'Reply with up to 10 threads, most relevant first, two lines each and nothing else:',
  '- its header line exactly as given;',
  '- `  ↳ ` and what in it bears on the question, at most 20 words (who, what, PR or link).',
  'The reader opens each thread for the details, so keep it short.',
  `If no thread bears on the question, reply exactly ${NO_MATCH}.`,
].join('\n');

export function buildRecallPrompt(question: string, records: string): string {
  return [
    RECALL_INSTRUCTIONS,
    '',
    '<question>',
    question.trim(),
    '</question>',
    '',
    '<records>',
    records,
    '</records>',
  ].join('\n');
}

export interface RecallDeps {
  /** The `ncl sessions records --all` text. */
  fetchRecords: () => Promise<string>;
  ask: (prompt: string) => Promise<string>;
}

export const FOOTER = [
  'These are pointers, not the answer. Open every thread you will cite with',
  '`ncl sessions history <session id>` (all of them, not a few) and read what was actually said, the',
  'newest messages too. Leave out what you did not open rather than citing it from these lines, and',
  'never tell the reader to check something because you only had summaries.',
  'Then, for each item you would call unclear or unconfirmed, search for that item before answering:',
  '`ncl sessions search --query "<its key words in both languages, with synonyms>"` (e.g. "case casen',
  'Frydenlund rigtige"), and open the thread it finds; check the work itself (repo, PRs, preview site) too.',
  'Only if that finds nothing, say it is unclear and what you checked.',
].join('\n');

/** The text recall prints. Throws on a missing question or a failed fetch/model call. */
export async function recall(question: string, deps: RecallDeps): Promise<string> {
  if (!question.trim()) throw new Error('--question is required');
  const records = (await deps.fetchRecords()).trim();
  // The host's "No thread records yet." / "No thread records since …".
  if (!records || records.startsWith('No thread records')) return records || 'No thread records yet.';
  const reply = (await deps.ask(buildRecallPrompt(question, records))).trim();
  if (!reply || reply === NO_MATCH) {
    return `No thread record bears on that. Try \`ncl sessions search\` with words from the question, in both languages.`;
  }
  return `${reply}\n\n${FOOTER}`;
}
