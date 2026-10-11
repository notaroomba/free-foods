// One runnable check per piece of non-trivial logic. No LLM calls: the extractor is injected.
process.env.DB_PATH = ':memory:';
process.env.INGEST_TOKEN = 'test-token';
process.env.PUBLIC_URL = 'http://localhost';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Extraction } from '../extract.ts';

const { prefilter, SCHEMA, promptText } = await import('../extract.ts');
const { parseRaw, parseAll, processEmail, dedupKey, source, DORMSPAM_RE, sniffImage, prepImage } = await import('../mail.ts');
const sharp = (await import('sharp')).default;
const { handle, toICS } = await import('../server.ts');
const { listEvents } = await import('../db.ts');

const dormspam = (subject: string, body: string, id = `<${Math.random()}@mit.edu>`) =>
  `Message-ID: ${id}\r\nFrom: Jane Doe <jdoe@mit.edu>\r\nTo: jdoe@mit.edu\r\nDate: Thu, 08 Oct 2026 14:00:00 -0400\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n\r\nbcc'd to all dorms, for bc-talk\r\n`;
const event = (over: Partial<Extraction['events'][number]> = {}): Extraction['events'][number] => ({
  title: 'Free pizza — Hack Night', food: 'Pizza', start: '2026-10-09T18:00:00-04:00', end: null, location: '32-G449', host: 'HackMIT',
  notes: null, leftovers_now: false, cancelled: false, confidence: 0.9, quantity: 'medium', ...over,
});
const listPost = (subject: string, body: string, id: string) =>
  `Message-ID: ${id}\r\nFrom: Eugenie Cha <eugeniec@mit.edu>\r\nTo: free-foods@mit.edu\r\nDate: Thu, 08 Oct 2026 20:59:00 -0400\r\nSubject: ${subject}\r\n\r\n${body}\r\n`;

test('prefilter: food words hit, noise does not', () => {
  assert.deepEqual(prefilter('Come to HACK NIGHT tonight, free pizza and boba in 32-G449!'), ['pizza', 'boba']);
  assert.deepEqual(prefilter('UROP opening in the Media Lab, apply by Friday'), []);
  assert.deepEqual(prefilter('Freedom of information talk'), []); // "free" inside "freedom" must not match
});

test('source label: every real-world dormspam footer variant, list recipients, other mail still analysed', () => {
  for (const f of ["bcc'd to dorms, purple!", "bcc'ed to all dorms, brass-rat-gold for bc-talk", 'bcc’ed to dorms, orange for bc-talk',
    'bcc-ed to all dorms..white for bc-talk', 'bcc to dormlists', "bcc'ed to dorms\nfinals season black for bc-talk :(", 'BCCed to all dorms']) {
    assert.match(f, DORMSPAM_RE, f);
  }
  assert.doesNotMatch('please bcc me on the thread about the dorm', DORMSPAM_RE);
  const base = { text: 'hi', recipients: '' };
  assert.equal(source({ ...base, recipients: 'jdoe@mit.edu free-foods@mit.edu' }), 'list');
  assert.equal(source({ ...base, recipients: 'list-id: <free-foods.mit.edu>' }), 'list');
  assert.equal(source({ ...base, recipients: 'cc: bc-talk@mit.edu, next-forum@mit.edu' }), 'dormspam');
  assert.equal(source({ ...base, text: "see you there!\nbcc'd to dorms, red for bc-talk" }), 'dormspam');
  // real dorm-list post with no footer at all, addressed to the list (Outlook shows "To: ec-discuss")
  assert.equal(source({ text: 'Hi gang i have placed a tray of newly acquired rice in the right talbot fridge', recipients: 'ec-discuss@mit.edu' }), 'dormspam');
  // same post forwarded inline: the list only survives in the quoted header block
  assert.equal(source({ ...base, text: 'From: Marvin Mao\nSent: Thursday\nTo: ec-discuss\nSubject: Rice in talbot\n\nHi gang i have placed a tray of rice' }), 'dormspam');
  assert.equal(source({ ...base, text: 'From: x\nTo: free-foods@mit.edu\nSubject: pizza in 10-250' }), 'list');
  assert.equal(source({ ...base, text: '> From: x\r\n> To: ec-discuss\r\n> hi' }), 'dormspam'); // reply-quoted forward, CRLF
  assert.equal(source({ ...base, text: 'To: Ian MacGregor <imac@mit.edu>\nhi' }), 'other'); // a surname, not the macgregor list
  assert.equal(source({ ...base, text: "bcc'd to dorms. dormsoup-ignore" }), null);
  assert.equal(source({ text: 'Hi Nathan, your pset grade is posted', recipients: 'nathan@mit.edu' }), 'other');
  assert.equal(source({ text: 'I live in MacGregor and ec-discuss is noisy', recipients: 'nathan@mit.edu' }), 'other'); // list names in prose are not dormspam
});

test('schema: every object closes additionalProperties and requires all fields', () => {
  const walk = (s: any) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual(Object.keys(s.properties).sort(), [...s.required].sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.items) walk(s.items);
  };
  walk(SCHEMA);
});

test('dedupKey: same hour + place collapses, different hour does not', () => {
  const a = dedupKey({ start: '2026-10-09T18:00:00-04:00', location: '32-G449', title: 'Pizza' });
  const b = dedupKey({ start: '2026-10-09T18:30:00-04:00', location: 'Room 32-G449', title: 'Free pizza!!' });
  const c = dedupKey({ start: '2026-10-09T19:30:00-04:00', location: '32-G449', title: 'Pizza' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('parseRaw + promptText: subject line and text attachments reach the model', async () => {
  const raw = `Message-ID: <ics@mit.edu>\r\nFrom: a@mit.edu\r\nSubject: invite\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--B\r\nContent-Type: text/calendar; name="invite.ics"\r\nContent-Disposition: attachment; filename="invite.ics"\r\n\r\nBEGIN:VCALENDAR\r\nSUMMARY:Free tacos\r\nEND:VCALENDAR\r\n--B--\r\n`;
  const m = await parseRaw(Buffer.from(raw));
  assert.match(m.text, /see attached/);
  assert.match(m.text, /\[Attachment invite\.ics\][\s\S]*SUMMARY:Free tacos/);
  // real free-foods post: everything is in the subject, body is "title!", footer arrives as ATT00001.txt
  const post = `Message-ID: <ej@mit.edu>\r\nFrom: Eugenie Cha <eugeniec@mit.edu>\r\nTo: free-foods@mit.edu\r\nDate: Thu, 08 Oct 2026 20:59:00 -0400\r\nSubject: free el jefes leftover stud4 dormcon/ua office\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="C"\r\n\r\n--C\r\nContent-Type: text/plain\r\n\r\ntitle!\r\n--C\r\nContent-Type: text/plain; name="ATT00001.txt"\r\nContent-Disposition: attachment; filename="ATT00001.txt"\r\n\r\n_______________________________________________\r\nFree-foods mailing list\r\n--C--\r\n`;
  const p = await parseRaw(Buffer.from(post));
  const text = promptText(p);
  assert.match(text, /^Received: .*2026/);
  assert.match(text, /Subject: free el jefes leftover stud4 dormcon\/ua office/);
  assert.match(text, /title!/);
  assert.match(text, /\[Attachment ATT00001\.txt\][\s\S]*Free-foods mailing list/);
  assert.equal(source(p), 'list');
});

test('parseRaw: unwraps a forward-as-attachment wrapper to the original dormspam', async () => {
  const inner = dormspam('Free dumplings in 10-250', 'Leftover dumplings from our event, come grab! Room 10-250.', '<inner@mit.edu>');
  const wrapper = `Message-ID: <outer@mit.edu>\r\nFrom: Me <me@mit.edu>\r\nSubject: FW: Free dumplings in 10-250\r\nDate: Thu, 08 Oct 2026 14:05:00 -0400\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nfwd\r\n--B\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="orig.eml"\r\n\r\n${inner}\r\n--B--\r\n`;
  const m = await parseRaw(Buffer.from(wrapper));
  assert.equal(m.id, '<inner@mit.edu>');
  assert.equal(m.subject, 'Free dumplings in 10-250');
  assert.match(m.from, /jdoe@mit\.edu/);
  assert.equal(m.date.toISOString(), '2026-10-08T18:00:00.000Z');
  // backfill: one email carrying several forwarded .eml files yields each inner message
  const a = dormspam('A', 'pizza', '<a@mit.edu>'), b = dormspam('B', 'boba', '<b@mit.edu>');
  const batch = `Message-ID: <batch@mit.edu>\r\nFrom: Me <me@mit.edu>\r\nSubject: FW: 2 messages\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nbackfill\r\n--B\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="a.eml"\r\n\r\n${a}\r\n--B\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="b.eml"\r\n\r\n${b}\r\n--B--\r\n`;
  assert.deepEqual((await parseAll(Buffer.from(batch))).map(x => x.subject), ['A', 'B']);
});

test('processEmail: every email reaches the model (only opt-outs skip), dedupe + idempotency', async () => {
  let calls = 0;
  const fake = {
    extract: async (mail: { text: string }): Promise<Extraction> => (calls++, /pizza/.test(mail.text)
      ? { is_free_food: true, reason: 'pizza', events: [event(), event({ title: 'bad date', food: null, start: 'tomorrowish', location: null, host: null, confidence: 0.5 })] }
      : { is_free_food: false, reason: 'no food', events: [] }),
  };
  const optOut = `Message-ID: <opt@mit.edu>\r\nFrom: Prof <prof@mit.edu>\r\nTo: nathan@mit.edu\r\nDate: Thu, 08 Oct 2026 14:00:00 -0400\r\nSubject: lunch tomorrow?\r\n\r\nWant to grab lunch? dormsoup-ignore\r\n`;
  assert.deepEqual(await processEmail(await parseRaw(Buffer.from(optOut)), fake), { skipped: 'opted-out' });
  assert.equal(calls, 0);
  const personal = `Message-ID: <priv@mit.edu>\r\nFrom: Prof <prof@mit.edu>\r\nTo: nathan@mit.edu\r\nDate: Thu, 08 Oct 2026 14:00:00 -0400\r\nSubject: pset\r\n\r\nGrades are posted.\r\n`;
  assert.deepEqual(await processEmail(await parseRaw(Buffer.from(personal)), fake), { source: 'other', isFreeFood: false, events: 0 }); // no gate: analysed anyway
  assert.deepEqual(await processEmail(await parseRaw(Buffer.from(dormspam('UROP', 'apply now', '<u@mit.edu>'))), fake), { source: 'dormspam', isFreeFood: false, events: 0 });
  assert.equal(calls, 2); // no food keyword, still analysed
  const r1 = await processEmail(await parseRaw(Buffer.from(dormspam('Hack Night', 'free pizza in 32-G449 at 6pm', '<p1@mit.edu>'))), fake);
  assert.deepEqual(r1, { source: 'dormspam', isFreeFood: true, events: 1 }); // invalid-date event dropped
  await processEmail(await parseRaw(Buffer.from(dormspam('Hack Night reminder', 'free pizza in 32-G449 at 6pm', '<p2@mit.edu>'))), fake);
  assert.deepEqual(await processEmail(await parseRaw(Buffer.from(dormspam('Hack Night', 'free pizza', '<p1@mit.edu>'))), fake), { skipped: 'seen' });
  let rows = listEvents('2026-10-09T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, '<p2@mit.edu>'); // latest email wins
  assert.equal(rows[0].start_at, '2026-10-09T22:00:00.000Z');
  // a correction in the same thread (same sender, "Re:" subject) replaces the earlier time instead of adding a second event
  const corrected = { extract: async (): Promise<Extraction> => ({ is_free_food: true, reason: 'moved', events: [event({ start: '2026-10-09T19:00:00-04:00' })] }) };
  await processEmail(await parseRaw(Buffer.from(dormspam('Re: Hack Night', 'CORRECTION: pizza at 7pm not 6pm, 32-G449', '<p3@mit.edu>'))), corrected);
  rows = listEvents('2026-10-09T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].start_at, '2026-10-09T23:00:00.000Z');
  // an old dormspam event stays in the DB (history) but must not be in the subscription feed
  const old = { extract: async (): Promise<Extraction> => ({ is_free_food: true, reason: 'old', poster: null, events: [event({ title: 'old pizza', start: '2026-09-01T18:00:00-04:00', location: '26-100' })] }) };
  await processEmail(await parseRaw(Buffer.from(dormspam('Old pizza', 'free pizza', '<old@mit.edu>'))), old);
});

test('free-foods list posts: only future events or a lot of food make the calendar; dormspam is never filtered', async () => {
  const past = new Date(Date.now() - 36e5).toISOString(), future = new Date(Date.now() + 864e5).toISOString();
  const fake = (over: Partial<Extraction['events'][number]>) => ({ extract: async (): Promise<Extraction> => ({ is_free_food: true, reason: 'x', poster: null, events: [event({ title: 'list-filter case', ...over })] }) });
  const run = (raw: string, over: Partial<Extraction['events'][number]>) => parseRaw(Buffer.from(raw)).then(m => processEmail(m, fake(over)));
  assert.deepEqual(await run(listPost('leftover cookies 4-231', 'a few cookies', '<l1@mit.edu>'), { start: past, leftovers_now: true, quantity: 'small', location: '4-231' }), { source: 'list', isFreeFood: true, events: 0 });
  assert.deepEqual(await run(listPost('leftover cookies 4-231', 'no amount said', '<l2@mit.edu>'), { start: past, leftovers_now: true, quantity: 'unknown', location: '4-232' }), { source: 'list', isFreeFood: true, events: 0 });
  assert.deepEqual(await run(listPost('5 trays of catering 32-123', 'tons', '<l3@mit.edu>'), { start: past, leftovers_now: true, quantity: 'large', location: '32-123' }), { source: 'list', isFreeFood: true, events: 1 });
  assert.deepEqual(await run(listPost('free lunch talk tomorrow', 'noon 10-250', '<l4@mit.edu>'), { start: future, quantity: 'small', location: '10-250' }), { source: 'list', isFreeFood: true, events: 1 });
  assert.deepEqual(await run(dormspam('leftover cookies', 'a few left in 4-231', '<d1@mit.edu>'), { start: past, leftovers_now: true, quantity: 'small', location: '4-233' }), { source: 'dormspam', isFreeFood: true, events: 1 });
});

test('images: real type sniffed, oversized ones shrunk to <=2000px JPEG, junk dropped', async () => {
  const png = await sharp({ create: { width: 9000, height: 120, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal(sniffImage(png), 'image/png');
  const big = await prepImage({ content: png, contentType: 'image/jpeg', size: png.length }); // mislabelled AND wider than the 8000px cap
  assert.ok(big);
  assert.equal(big.media_type, 'image/jpeg');
  const meta = await sharp(Buffer.from(big.data, 'base64')).metadata();
  assert.ok((meta.width ?? 0) <= 2000 && (meta.height ?? 0) <= 2000, `got ${meta.width}x${meta.height}`);
  const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#f00' } }).png().toBuffer();
  const kept = await prepImage({ content: small, contentType: 'image/png', size: small.length });
  assert.equal(kept?.media_type, 'image/png');
  assert.equal(kept?.size, small.length); // passed through untouched
  assert.equal(await prepImage({ content: Buffer.from('not an image'), contentType: 'image/heic', size: 12 }), null);
});

test('replies: headers connect organizers, corrections preserve UID and series, older backfills cannot revert them', async () => {
  const make = async (id: string, day: number, body: string, references = '', from = 'organizer@mit.edu') => parseRaw(
    `Message-ID: <${id}@mit.edu>\r\nFrom: ${from}\r\nTo: free-foods@mit.edu\r\nSubject: Re: Series dinner\r\nDate: ${day} Oct 2026 12:00:00 -0400\r\n${references ? `References: <series-original@mit.edu>\r\nIn-Reply-To: <${references}@mit.edu>\r\n` : ''}\r\n${body}`);
  const a = event({ title: 'Series dinner', start: '2027-01-02T18:00:00-05:00', location: 'W20-901' });
  const b = event({ ...a, start: '2027-01-03T18:00:00-05:00' });
  const fake = (events: Extraction['events']) => ({ extract: async (): Promise<Extraction> => ({ is_free_food: true, reason: 'test', events }) });
  await processEmail(await make('series-original', 4, 'Free dinner Jan 2 and 3'), fake([a, b]));
  const range = () => listEvents('2027-01-01', '2027-01-05');
  const original = range();
  const firstId = original[0].id, secondId = original[1].id;
  const reply = await make('series-update', 7, 'First dinner moved to 7pm in W20-902.', 'series-original', 'cohost@mit.edu');
  assert.deepEqual(reply.references, ['<series-original@mit.edu>']);
  await processEmail(reply, { extract: async mail => {
    assert.equal(mail.previousEvents?.length, 2);
    assert.match(promptText(mail), /Previous events[\s\S]*W20-901/);
    return { is_free_food: true, reason: 'correction', events: [{ ...a, existing_event_id: firstId, start: '2027-01-02T19:00:00-05:00', location: 'W20-902' }] };
  } });
  assert.equal(range().length, 2);
  assert.equal(range()[0].id, firstId);
  assert.equal(range()[0].location, 'W20-902');
  assert.equal(range()[1].id, secondId);
  // An older unseen reminder is processed after the update, not allowed to overwrite it.
  await processEmail(await make('series-old-reminder', 5, 'Dinner at six', 'series-original'), fake([{ ...a, existing_event_id: firstId }]));
  assert.equal(range()[0].start_at, '2027-01-03T00:00:00.000Z');
  assert.equal(range()[0].location, 'W20-902');
  assert.deepEqual(await processEmail(reply, { extract: async () => { throw new Error('duplicate reached model'); } }), { skipped: 'seen' });
  // Another mailing-list copy with a different subject/thread merges, keeping both thread links.
  const copy = { ...await make('series-copy', 8, 'dinner'), subject: 'Dinner announcement copy' };
  await processEmail(copy, fake([{ ...a, start: '2027-01-02T19:00:00-05:00', location: 'W20-902' }]));
  assert.equal(range().length, 2);
  await processEmail(await make('series-cancel', 9, 'First dinner cancelled', 'series-update'), { extract: async mail => {
    assert.ok(mail.previousEvents?.some(e => e.id === firstId));
    return { is_free_food: true, reason: 'cancelled', events: [{ ...a, existing_event_id: firstId, start: '2027-01-02T19:00:00-05:00', location: 'W20-902', cancelled: true }] };
  } });
  assert.equal(range()[0].cancelled, 1);
  assert.equal(range()[1].cancelled, 0);
  const exportedReply = { ...await make('series-no-headers', 10, 'Second dinner moved to W20-903', '', 'third-organizer@mit.edu') };
  await processEmail(exportedReply, { extract: async mail => {
    assert.ok(mail.previousEvents?.some(e => e.id === secondId));
    return { is_free_food: true, reason: 'exported correction', events: [{ ...b, existing_event_id: secondId, location: 'W20-903' }] };
  } });
  assert.equal(range()[1].id, secondId);
  assert.equal(range()[1].location, 'W20-903');
});

test('failed event writes roll back message receipt so delivery can retry', async () => {
  const { db, seenMessage } = await import('../db.ts');
  const m = await parseRaw(dormspam('Atomic dinner', 'pizza', '<atomic@mit.edu>'));
  db.exec(`create trigger fail_test before insert on events when new.message_id='<atomic@mit.edu>' begin select raise(abort, 'test write failure'); end`);
  const fake = { extract: async (): Promise<Extraction> => ({ is_free_food: true, reason: 'test', events: [event({ title: 'Atomic dinner', location: 'atomic-test-room' })] }) };
  await assert.rejects(processEmail(m, fake), /test write failure/);
  assert.equal(seenMessage(m.id), false);
  db.exec('drop trigger fail_test');
  assert.equal((await processEmail(m, fake) as { events: number }).events, 1);
});

test('toICS: valid skeleton, UTC stamps, escaped commas', () => {
  const ics = toICS([{ id: 7, title: 'Pizza, boba', start_at: '2026-10-09T22:00:00.000Z', end_at: null, location: 'W20-306', updated_at: '2026-10-08 18:00:00',
    sender: 'a@mit.edu', cancelled: 0, food: null, host: null, notes: null, leftovers: 0, confidence: 1, subject: 's', source: 'dormspam' }], 'example.test');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:ff-7@example\.test/);
  assert.match(ics, /DTSTART:20261009T220000Z/);
  assert.match(ics, /DTEND:20261009T230000Z/); // default 1h
  assert.match(ics, /SUMMARY:Pizza\\, boba/);
  const long = toICS([{ id: 8, title: 'x'.repeat(200), start_at: '2026-10-09T22:00:00.000Z', end_at: null, location: null, updated_at: '2026-10-08 18:00:00', sender: null, cancelled: 0, food: null, host: null, notes: 'é'.repeat(100), leftovers: 0, confidence: 1, subject: 's', source: 'list' }]);
  assert.ok(long.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'folded');
  assert.match(long.replace(/\r\n /g, ''), new RegExp('SUMMARY:' + 'x'.repeat(200))); // unfolding restores the line
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('http: healthz open, ingest needs token, events served as JSON', async () => {
  const srv = http.createServer((q, s) => handle(q, s).catch(e => { s.statusCode = 500; s.end(String(e)); }));
  await new Promise<void>(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal(((await (await fetch(`${base}/healthz`)).json()) as { ok: boolean }).ok, true);
    assert.equal((await fetch(`${base}/ingest`, { method: 'POST', body: 'x' })).status, 401);
    const pre = await fetch(`${base}/ingest`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://outlook.office.com'); // browser-side backfill from Outlook on the web
    const optOut = `Message-ID: <h@mit.edu>\r\nFrom: Housing <housing@mit.edu>\r\nTo: nathan@mit.edu\r\nSubject: Housing lottery\r\n\r\nlottery results posted. dormsoup-ignore\r\n`;
    const r = await fetch(`${base}/ingest`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: optOut });
    assert.deepEqual(await r.json(), { skipped: 'opted-out' });
    // envelope sender outside mit.edu (set by the Cloudflare worker) is ignored before parsing
    const r2 = await fetch(`${base}/ingest`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'x-envelope-from': 'spammer@example.com' }, body: dormspam('Free pizza', "free pizza now in 10-250\nbcc'd to dorms", '<spam@example.com>') });
    assert.equal(r2.status, 202);
    const all = (await (await fetch(`${base}/api/events?start=2026-10-09T00:00:00Z&end=2026-10-10T00:00:00Z`)).json()) as Record<string, unknown>[];
    const ev = all.filter(e => e.title === 'Free pizza — Hack Night'); // other tests add relative-dated events
    assert.equal(ev.length, 1);
    assert.equal(ev[0].sender, 'Jane Doe'); // public site: display name only, no address or internal ids
    assert.equal(ev[0].message_id, undefined);
    const ics = await (await fetch(`${base}/calendar.ics`)).text();
    assert.match(ics, /BEGIN:VEVENT/);
    assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT1H/); // subscription feed, refreshed hourly by clients
    assert.doesNotMatch(ics, /old pizza/); // past events are not in the feed
    const me = (await (await fetch(`${base}/api/me`)).json()) as { webcal: string; gcal: string; ics: string };
    assert.equal(me.webcal, 'webcal://localhost/calendar.ics');
    assert.match(me.gcal, /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2F/);
    assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'lines folded to 75 octets');
    const home = await fetch(`${base}/`);
    const html = await home.text();
    assert.match(html, /Free Foods @ MIT/);
    assert.match(html, /app\.js\?v=[0-9a-f]+/); // versioned so Cloudflare's edge cache never serves a stale build
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'none'/);
    assert.equal((await fetch(`${base}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(`${base}/icons/pizza.svg`)).status, 200);
    assert.equal((await fetch(`${base}/icons/../server.ts`)).status, 404);
    // moderation endpoint: token-protected delete
    const id = (all.find(e => e.title === 'Free pizza — Hack Night') as { id: number }).id;
    assert.equal((await fetch(`${base}/api/events/${id}`, { method: 'DELETE' })).status, 401);
    assert.deepEqual(await (await fetch(`${base}/api/events/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer test-token' } })).json(), { deleted: 1 });
    assert.equal(((await (await fetch(`${base}/api/events?start=2026-10-09T00:00:00Z&end=2026-10-10T00:00:00Z`)).json()) as { title: string }[]).filter(e => e.title === 'Free pizza — Hack Night').length, 0);
  } finally { srv.close(); }
});
