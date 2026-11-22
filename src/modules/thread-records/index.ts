/**
 * Thread records: the host end of the runner's `thread_record` action.
 * Storage, seeding and listing live with the rest of cross-session context
 * (src/modules/cross-session-context/thread-records.ts); this module only
 * registers the delivery action, which needs delivery.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { saveThreadRecord } from '../cross-session-context/index.js';
import { backfillThreadRecordFrom, parseCovered } from '../cross-session-context/thread-records.js';

registerDeliveryAction(
  'thread_record',
  async (content, session) => {
    if (typeof content.record !== 'string') {
      log.warn('thread_record: no record in payload', { sessionId: session.id });
      return;
    }
    if (await saveThreadRecord(session, content.record, new Date(), parseCovered(content.covered))) {
      log.debug('thread_record saved', { sessionId: session.id });
    }
  },
  unguarded(
    "stores the session's own summary for its agent group's other threads in the same conversation; grants nothing",
  ),
);

/**
 * `thread_record_backfill`: a record for ANOTHER thread, written by
 * `ncl sessions backfill-records` from that thread's transcript. Accepted
 * only for a thread the sending session may read (the same rules as
 * `ncl sessions history`), and only when it has no record yet.
 */
registerDeliveryAction(
  'thread_record_backfill',
  async (content, session) => {
    await backfillThreadRecordFrom(session, content);
  },
  unguarded(
    'stores a summary of a thread the sending session may already read in full (same checks as sessions history); grants nothing',
  ),
);
