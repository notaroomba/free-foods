import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EventRow {
  id: number; dedup_key: string; message_id: string | null; thread_key: string | null; source: string | null;
  title: string; food: string | null; start_at: string; end_at: string | null;
  location: string | null; host: string | null; notes: string | null;
  leftovers: number; confidence: number | null; cancelled: number;
  sender: string | null; subject: string | null; updated_at: string;
}
export interface MessageRecord {
  id: string; receivedAt: string; sender: string | null; subject: string | null; snippet: string;
  matched: string; isFreeFood: number | null; result: string | null;
  threadKey?: string;
}
export interface EventInput {
  dedupKey: string; messageId: string; threadKey?: string | null; source?: string | null; title: string; food: string | null;
  startAt: string; endAt: string | null; location: string | null; host: string | null; notes: string | null;
  leftovers: boolean; confidence: number; cancelled: boolean; sender: string; subject: string;
}

const path = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/freefood.db` : './freefood.db');
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);
db.exec(`
  pragma journal_mode = wal;
  create table if not exists messages (
    id text primary key,              -- Message-ID header
    received_at text not null,
    sender text, subject text, snippet text,
    matched text,                     -- keywords that triggered the LLM ("" = skipped, "not-dormspam" = never read)
    is_free_food integer,             -- null = never analyzed
    result text,                      -- raw LLM JSON
    processed_at text not null default (datetime('now'))
  );
  create table if not exists events (
    id integer primary key,
    dedup_key text unique not null,
    message_id text,
    title text not null, food text,
    start_at text not null, end_at text,
    location text, host text, notes text,
    leftovers integer not null default 0,
    confidence real,
    cancelled integer not null default 0,
    sender text, subject text,
    updated_at text not null default (datetime('now'))
  );
  create index if not exists events_start on events(start_at);
  create table if not exists kv (k text primary key, v text);
`);
try { db.exec('alter table events add column thread_key text'); } catch { /* column exists */ }
try { db.exec('alter table events add column source text'); } catch { /* column exists */ }
try { db.exec('alter table messages add column thread_key text'); } catch { /* column exists */ }
db.exec(`create index if not exists messages_thread on messages(thread_key);
  create index if not exists events_thread on events(thread_key);
  create table if not exists event_threads (thread_key text, event_id integer, primary key(thread_key, event_id));
  create trigger if not exists clean_event_threads after delete on events begin
    delete from event_threads where event_id=old.id;
  end;
  delete from event_threads where event_id not in (select id from events);
  insert or ignore into event_threads select thread_key, id from events where thread_key is not null;`);
// events created before the source column existed: the message log knows which came from the free-foods list
db.exec(`update events set source = case when (select matched from messages where messages.id = events.message_id) = 'free-food-list' then 'list' else 'dormspam' end where source is null`);

const q = {
  seen: db.prepare('select 1 from messages where id = ?'),
  saveMsg: db.prepare(`insert or replace into messages (id, received_at, sender, subject, snippet, matched, is_free_food, result, thread_key)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  upsert: db.prepare(`insert into events (dedup_key, message_id, title, food, start_at, end_at, location, host, notes, leftovers, confidence, cancelled, sender, subject, thread_key, source)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(dedup_key) do update set
      message_id=excluded.message_id, title=excluded.title, food=excluded.food, start_at=excluded.start_at, end_at=excluded.end_at,
      location=excluded.location, host=excluded.host, notes=excluded.notes, leftovers=excluded.leftovers,
      confidence=excluded.confidence, cancelled=excluded.cancelled, sender=excluded.sender, subject=excluded.subject,
      thread_key=excluded.thread_key, source=excluded.source, updated_at=datetime('now')`),
  deleteEvent: db.prepare('delete from events where id = ?'),
  list: db.prepare('select * from events where start_at >= ? and start_at < ? order by start_at'),
  kvGet: db.prepare('select v from kv where k = ?'),
  kvSet: db.prepare('insert or replace into kv (k, v) values (?, ?)'),
  stats: db.prepare(`select count(*) as messages, sum(is_free_food) as food, (select count(*) from events) as events from messages`),
};

export const seenMessage = (id: string): boolean => !!q.seen.get(id);
export const saveMessage = (m: MessageRecord) => q.saveMsg.run(m.id, m.receivedAt, m.sender, m.subject, m.snippet, m.matched, m.isFreeFood, m.result, m.threadKey ?? null);
export const upsertEvent = (e: EventInput) => q.upsert.run(e.dedupKey, e.messageId, e.title, e.food, e.startAt, e.endAt, e.location, e.host, e.notes,
  e.leftovers ? 1 : 0, e.confidence, e.cancelled ? 1 : 0, e.sender, e.subject, e.threadKey ?? null, e.source ?? null);
export const deleteEvent = (id: number) => Number(q.deleteEvent.run(id).changes);
/** ISO UTC bounds, [from, to). */
export const listEvents = (from: string, to: string) => q.list.all(from, to) as unknown as EventRow[];
export const kvGet = (k: string): string | null => (q.kvGet.get(k) as { v: string } | undefined)?.v ?? null;
export const kvSet = (k: string, v: string | number | bigint) => q.kvSet.run(k, String(v));
export const stats = () => q.stats.get() as unknown as { messages: number; food: number | null; events: number };

/** Old messages predate thread metadata; their sender/subject still provide a fallback. */
export const messageContext = (id: string) => db.prepare('select thread_key, sender, subject from messages where id = ?').get(id) as
  { thread_key: string | null; sender: string | null; subject: string | null } | undefined;
export const threadEvents = (key: string) => db.prepare(`select e.* from events e join event_threads t on t.event_id=e.id
  where t.thread_key = ? order by e.start_at desc limit 40`).all(key) as unknown as EventRow[];
export const recentThreads = (date: Date) => db.prepare(`select distinct e.thread_key, e.subject from events e join messages m on m.id=e.message_id
  where m.received_at between ? and ? and e.thread_key is not null`).all(new Date(+date - 30 * 864e5).toISOString(), new Date(+date + 30 * 864e5).toISOString()) as
  { thread_key: string; subject: string }[];

/** Commit message and event changes together: a failed write must remain retryable. */
export function saveExtraction(message: MessageRecord, events: { event: EventInput; existingId?: number }[]): void {
  db.exec('begin immediate');
  try {
    for (const { event: e, existingId } of events) {
      const current = db.prepare(`select e.id, m.received_at from events e left join messages m on m.id = e.message_id
        where e.id = ? or e.dedup_key = ? order by e.id = ? desc limit 1`).get(existingId ?? -1, e.dedupKey, existingId ?? -1) as
        { id: number; received_at: string | null } | undefined;
      // Backfills can arrive in reverse order. Arrival time must not undo a newer announcement.
      if (current && e.threadKey) db.prepare('insert or ignore into event_threads values (?, ?)').run(e.threadKey, current.id);
      if (current?.received_at && current.received_at > message.receivedAt) continue;
      if (current) {
        // A correction can collide with a separately forwarded copy. Consolidate it while preserving all thread links.
        const duplicate = db.prepare('select id from events where dedup_key=? and id!=?').get(e.dedupKey, current.id) as { id: number } | undefined;
        if (duplicate) {
          db.prepare('insert or ignore into event_threads select thread_key, ? from event_threads where event_id=?').run(current.id, duplicate.id);
          q.deleteEvent.run(duplicate.id);
        }
        // Keep the calendar ID/UID even when its room or time changes.
        db.prepare(`update events set dedup_key=?, message_id=?, title=?, food=?, start_at=?, end_at=?, location=?, host=?, notes=?,
          leftovers=?, confidence=?, cancelled=?, sender=?, subject=?, thread_key=?, source=?, updated_at=datetime('now') where id=?`)
          .run(e.dedupKey, e.messageId, e.title, e.food, e.startAt, e.endAt, e.location, e.host, e.notes, Number(e.leftovers), e.confidence,
            Number(e.cancelled), e.sender, e.subject, e.threadKey ?? null, e.source ?? null, current.id);
      } else {
        const inserted = upsertEvent(e);
        if (e.threadKey) db.prepare('insert or ignore into event_threads values (?, ?)').run(e.threadKey, inserted.lastInsertRowid);
      }
    }
    saveMessage(message);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
}
