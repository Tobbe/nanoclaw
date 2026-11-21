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
  'Reply with up to 5 threads, most relevant first. For each: its header line exactly as given,',
  'then the record lines that matter, copied as written. Nothing else.',
  `If no thread bears on the question, reply exactly ${NO_MATCH}.`,
].join('\n');

export function buildRecallPrompt(question: string, records: string): string {
  return [RECALL_INSTRUCTIONS, '', '<question>', question.trim(), '</question>', '', '<records>', records, '</records>'].join(
    '\n',
  );
}

export interface RecallDeps {
  /** The `ncl sessions records --all` text. */
  fetchRecords: () => Promise<string>;
  ask: (prompt: string) => Promise<string>;
}

const FOOTER = 'Open a thread in full with `ncl sessions history <session id>`; find exact wording with `ncl sessions search`.';

/** The text recall prints. Throws on a missing question or a failed fetch/model call. */
export async function recall(question: string, deps: RecallDeps): Promise<string> {
  if (!question.trim()) throw new Error('--question is required');
  const records = (await deps.fetchRecords()).trim();
  if (!records || records === 'No thread records yet.') return 'No thread records yet.';
  const reply = (await deps.ask(buildRecallPrompt(question, records))).trim();
  if (!reply || reply === NO_MATCH) {
    return `No thread record bears on that. Try \`ncl sessions search\` with words from the question, in both languages.`;
  }
  return `${reply}\n\n${FOOTER}`;
}
