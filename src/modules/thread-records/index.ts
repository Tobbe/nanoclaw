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

registerDeliveryAction(
  'thread_record',
  async (content, session) => {
    if (typeof content.record !== 'string') {
      log.warn('thread_record: no record in payload', { sessionId: session.id });
      return;
    }
    if (await saveThreadRecord(session, content.record)) log.debug('thread_record saved', { sessionId: session.id });
  },
  unguarded(
    "stores the session's own summary for its agent group's other threads in the same conversation; grants nothing",
  ),
);
