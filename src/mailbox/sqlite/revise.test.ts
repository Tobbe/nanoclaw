import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA } from './schema.js';
import { reviseContent, wrapSqliteInbound } from './index.js';

describe('reviseMessage', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function mailbox() {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    let sequence = 0;
    const inbound = wrapSqliteInbound(db, () => (sequence += 2));
    const add = (id: string, content: object, status = 'completed') =>
      db
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
           VALUES (?, ?, 'chat-sdk', '2026-01-01T00:00:00.000Z', ?, 1, ?)`,
        )
        .run(id, (sequence += 2), status, JSON.stringify(content));
    const row = (id: string) =>
      db.prepare('SELECT status, content FROM messages_in WHERE id = ?').get(id) as {
        status: string;
        content: string;
      };
    return { inbound, add, row };
  }

  it('deletes the message and its copies in other threads, and hides them from history', () => {
    const { inbound, add, row } = mailbox();
    add('1.1:ag', { text: 'call list', sender: 'Lise', attachments: [{ name: 'a.csv' }] });
    add('1.1:ag:echo:sess-2', { text: 'call list', echo: { surface: 's' } });
    add('1.10:ag', { text: 'a different message whose id shares the prefix' });
    add('2.2:ag', { text: 'kept' });

    expect(inbound.reviseMessage('1.1:ag', { kind: 'deleted', at: '2026-01-02T00:00:00.000Z' })).toBe(2);
    const deleted = JSON.parse(row('1.1:ag').content);
    expect(deleted).toEqual({ sender: 'Lise', text: '', deleted: '2026-01-02T00:00:00.000Z' });
    expect(JSON.parse(row('1.1:ag:echo:sess-2').content).deleted).toBe('2026-01-02T00:00:00.000Z');
    expect(JSON.parse(row('1.10:ag').content).text).toBe('a different message whose id shares the prefix');
    expect(inbound.getInboundHistory(10).map((m) => JSON.parse(m.content).text)).toEqual([
      'kept',
      'a different message whose id shares the prefix',
    ]);
  });

  it('never hands a deleted message to the agent if it was still waiting', () => {
    const { inbound, add, row } = mailbox();
    add('3.3:ag', { text: 'oops' }, 'pending');
    inbound.reviseMessage('3.3:ag', { kind: 'deleted', at: '2026-01-02T00:00:00.000Z' });
    expect(row('3.3:ag').status).toBe('completed');
  });

  it('replaces the text of an edited message and keeps the rest', () => {
    const { inbound, add, row } = mailbox();
    add('4.4:ag', { text: 'Rundere knapper', formatted: { old: true }, sender: 'Lise' }, 'pending');
    expect(
      inbound.reviseMessage('4.4:ag', { kind: 'edited', text: 'Runde knapper', at: '2026-01-02T00:00:00.000Z' }),
    ).toBe(1);
    expect(row('4.4:ag')).toEqual({
      status: 'pending',
      content: JSON.stringify({ text: 'Runde knapper', sender: 'Lise', editedAt: '2026-01-02T00:00:00.000Z' }),
    });
  });

  it('changes nothing when no message has that id', () => {
    const { inbound } = mailbox();
    expect(inbound.reviseMessage('9.9:ag', { kind: 'deleted', at: '2026-01-02T00:00:00.000Z' })).toBe(0);
  });

  it('leaves content that is not a JSON object alone', () => {
    expect(reviseContent('not json', { kind: 'deleted', at: 'x' })).toBeNull();
    expect(reviseContent('[1]', { kind: 'deleted', at: 'x' })).toBeNull();
  });
});
