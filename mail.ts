import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';
import { ImapFlow } from 'imapflow';
import sharp from 'sharp';
import { seenMessage, saveMessage, saveExtraction, messageContext, threadEvents, recentThreads, kvGet, kvSet } from './db.ts';
import { prefilter, extract, type Mail, type Extraction, type ImageType } from './extract.ts';

const MAX_IMAGE = 20e6, MAX_PDF = 20e6, BUDGET = 22e6; // attachments up to 20 MB are accepted; images are shrunk below, PDFs go as-is (API: 32 MB/request)
const MAX_PX = 2000, SMALL = 3e6; // the API downsizes to ~1568 px anyway and rejects >8000 px or >10 MB base64, so shrink anything big first

/** Real image type from the first bytes; mail clients lie in Content-Type (a PNG labelled image/jpeg is rejected by the API). */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Image attachment -> API-ready block: small images pass through, big ones are resized to <= MAX_PX JPEG; undecodable ones are dropped. */
export async function prepImage(a: Pick<Attachment, 'content' | 'contentType' | 'size'>): Promise<{ media_type: ImageType; data: string; size: number } | null> {
  const type = sniffImage(a.content);
  if (!type && !a.contentType.startsWith('image/')) return null;
  try {
    const meta = await sharp(a.content).metadata();
    if (type && a.size <= SMALL && (meta.width ?? 0) <= MAX_PX && (meta.height ?? 0) <= MAX_PX) return { media_type: type, data: a.content.toString('base64'), size: a.size };
    const buf = await sharp(a.content).rotate().resize({ width: MAX_PX, height: MAX_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { media_type: 'image/jpeg', data: buf.toString('base64'), size: buf.length };
  } catch { return null; } // HEIC, corrupt data, SVG, etc.
}
const TEXT_TYPES = /^text\/(plain|calendar|markdown|csv)$/;
const LIST_HEADERS = new Set(['list-id', 'list-post', 'delivered-to', 'x-original-to', 'envelope-to']);

/** Parse raw RFC822 bytes into every message it carries: a forward-as-attachment wrapper (or a backfill email with
 *  dozens of attached .eml files) yields the inner messages; a plain email yields itself. */
export async function parseAll(buf: Buffer | string, depth = 0): Promise<Mail[]> {
  const m = await simpleParser(buf);
  const inner = m.attachments.filter(a => a.contentType === 'message/rfc822');
  if (inner.length && depth < 3) return (await Promise.all(inner.map(a => parseAll(a.content, depth + 1)))).flat();
  return [await toMail(m)];
}
export const parseRaw = async (buf: Buffer | string): Promise<Mail> => (await parseAll(buf))[0];

async function toMail(m: ParsedMail): Promise<Mail> {
  // mailparser derives text from HTML itself; this bounded fallback only covers bodies it refused to convert
  let text = m.text || (m.html && m.html.length < 2e5 ? m.html.replace(/<[^>]*>/g, ' ') : '');
  for (const a of m.attachments.filter(a => TEXT_TYPES.test(a.contentType) && a.size <= 50e3)) // .ics invites, .txt flyers: read them too
    text += `\n\n[Attachment ${a.filename || a.contentType}]\n${a.content.toString('utf8')}`;
  const recipients = [
    ...[m.to, m.cc, m.bcc].flat().flatMap(a => a?.value ?? []).map(x => x.address ?? ''),
    ...m.headerLines.filter(h => LIST_HEADERS.has(h.key)).map(h => h.line),
  ].join(' ').toLowerCase();
  let used = 0;
  const fits = (a: { size: number }) => (used + a.size <= BUDGET) && (used += a.size, true);
  const prepared = await Promise.all(m.attachments.filter(a => a.size <= MAX_IMAGE && a.contentType !== 'application/pdf').map(prepImage));
  const images = prepared.filter((p): p is NonNullable<typeof p> => !!p).slice(0, 8).filter(fits).map(({ media_type, data }) => ({ media_type, data }));
  return {
    id: m.messageId || `no-id-${Date.now()}-${Math.random()}`,
    from: m.from?.text ?? '',
    subject: m.subject ?? '',
    references: [...new Set([...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : []), ...(m.inReplyTo ? [m.inReplyTo] : [])])],
    date: m.date ?? new Date(),
    text, recipients, images,
    pdfs: m.attachments.filter(a => a.contentType === 'application/pdf' && a.size <= MAX_PDF).slice(0, 2).filter(fits)
      .map(a => ({ data: a.content.toString('base64') })),
  };
}

// Dorm lists + free-food lists (MIT Digital Comms WG report 2024, DormCon join-dormspam, DormSoup).
const FOOD_LISTS = ['free-foods', 'free-food', 'freefood', 'vultures'];
const DORM_LISTS = ['bc-talk', 'ec-discuss', 'frat-chat', 'mccormick-announce', 'next-forum', 'nh-forum', 'random-hall-talk',
  'random-hall-dormspam', 'macgregor', 'maseeh-talk', 'new-vassar-forum', 'sponge-talk', 'baker-forum', 'dormspam-catch-all'];
// Footer variants seen in the wild: "bcc'd to dorms", "bcc’ed to all dorms", "bcc-ed to all dorms..", "bcc to dormlists", "for bc-talk".
export const DORMSPAM_RE = /bcc\W{0,3}e?d?\s+(?:to\s+)?(?:all\s+)?dorm|for\s+bc[- ]talk/i;
// Inline forwards lose the real headers but quote them in the body ("To: ec-discuss"); look for list names on those lines too.
// Allows "> " reply quoting; the list name must be a whole token followed by @mit.edu, a separator, or end of line
// (so "To: Ian MacGregor <imac@mit.edu>" is not the macgregor list).
const quotedHeader = (lists: string[]) =>
  new RegExp(`^[\\s>]*(?:to|cc|bcc)\\s*:.*(?<![\\w-])(?:${lists.join('|')})(?:@mit\\.edu|\\s*(?:[,;]|\\r?$))`, 'im');
const QUOTED_FOOD = quotedHeader(FOOD_LISTS), QUOTED_DORM = quotedHeader(DORM_LISTS);
const onList = (mail: Pick<Mail, 'recipients'>, lists: string[]) =>
  lists.some(l => mail.recipients.includes(`${l}@mit.edu`) || mail.recipients.includes(`${l}.mit.edu`));

export type Source = 'list' | 'dormspam' | 'other';
/** 'list' = free-food list, 'dormspam' = sent to a dorm list or carrying the footer, 'other' = anything else.
 *  null = do not read it: the sender opted out (dormsoup-ignore / freefood-ignore), or it is personal mail and ANALYZE_ALL is off.
 *  Keep ANALYZE_ALL off when the whole mailbox is forwarded (mailto.mit.edu split); it is safe to turn on when a rule only forwards dormspam. */
export function source(mail: Pick<Mail, 'text' | 'recipients'>): Source | null {
  if (/dormsoup-ignore|freefood-ignore/i.test(mail.text)) return null;
  if (onList(mail, FOOD_LISTS) || QUOTED_FOOD.test(mail.text)) return 'list';
  if (onList(mail, DORM_LISTS) || QUOTED_DORM.test(mail.text) || DORMSPAM_RE.test(mail.text)) return 'dormspam';
  return process.env.ANALYZE_ALL === '1' ? 'other' : null;
}

const norm = (s: string | null | undefined) => (s || '').toLowerCase().replace(/\b(room|rm|building|bldg)\b\.?/g, '').replace(/[^a-z0-9]+/g, '');
// ponytail: dedup = same hour + same place. Two different events at the same spot/hour merge; good enough for dormspam.
export const dedupKey = (ev: { start: string; location?: string | null; title: string }) =>
  `${new Date(ev.start).toISOString().slice(0, 13)}|${norm(ev.location) || norm(ev.title).slice(0, 24)}`;
// Bumps/corrections ("Re: …", "BUMP: …", "LAST BUMP tonight!!") from the same sender replace that thread's earlier events.
// ponytail: whole-thread replace; a bump that mentions only tonight drops the series' other dates. Per-day replace if that bites.
const NOISE = '(?:re|fw|fwd|bump|last bump|final bump|reminder|update|updated|correction|tmrw|tomorrow|tday|today|tonight|now)';
const LEAD = new RegExp(`^(\\s*\\[?${NOISE}\\]?\\b[:!.\\s-]*)+`, 'i'), TAIL = new RegExp(`([:!.\\s-]*\\b${NOISE}\\b[!.\\s]*)+$`, 'i');
const normalizedSubject = (subject: string) => subject.toLowerCase().replace(LEAD, '').replace(TAIL, '').replace(/[^a-z0-9]+/g, ' ').trim();
export const threadKey = (mail: Pick<Mail, 'subject' | 'from'>) => {
  const subj = normalizedSubject(mail.subject || '');
  const addr = (mail.from.match(/<([^>]+)>/)?.[1] || mail.from).toLowerCase();
  return `${addr}|${subj}`;
};

function resolveThread(mail: Mail): string {
  for (const id of [...(mail.references ?? [])].reverse()) {
    const prior = messageContext(id);
    if (prior) return prior.thread_key || threadKey({ from: prior.sender || '', subject: prior.subject || '' });
  }
  // References also connect replies received before their parent (e.g. a newest-first backfill).
  const root = mail.references?.[0];
  if (root && threadEvents(`message:${root}`).length) return `message:${root}`;
  const fallback = threadKey(mail);
  if (threadEvents(fallback).length) return fallback;
  if (threadEvents(`message:${mail.id}`).length) return `message:${mail.id}`;
  // Some Outlook exports omit reply headers. Use an exact normalized subject only when it identifies one recent thread.
  if (/^\s*(?:re|fw|fwd)\s*:/i.test(mail.subject)) {
    const candidates = new Set(recentThreads(mail.date).filter(t => normalizedSubject(t.subject) === normalizedSubject(mail.subject)).map(t => t.thread_key));
    if (candidates.size === 1) return [...candidates][0];
  }
  return root ? `message:${root}` : fallback;
}

export interface Deps { extract: (mail: Mail) => Promise<Extraction> }
export type ProcessResult =
  | { skipped: 'seen' | 'not-read' }
  | { source: Source; isFreeFood: boolean; events: number };

/** Run one parsed email through gate -> prefilter -> LLM -> DB. `deps.extract` is injectable for tests. */
let chain: Promise<unknown> = Promise.resolve(); // one email at a time: a burst of /ingest calls must not fan out into parallel model calls
export function processEmail(mail: Mail, deps?: Deps): Promise<ProcessResult> {
  const p = chain.catch(() => {}).then(() => processOne(mail, deps));
  chain = p;
  return p;
}

async function processOne(mail: Mail, deps: Deps = { extract }): Promise<ProcessResult> {
  if (seenMessage(mail.id)) return { skipped: 'seen' };
  const receivedAt = new Date(mail.date).toISOString();
  const src = source(mail);
  if (!src) { // opted out, or personal mail with ANALYZE_ALL off: remember only the id, never store or read the content
    saveMessage({ id: mail.id, receivedAt, sender: null, subject: null, snippet: '', matched: 'not-read', isFreeFood: null, result: null });
    return { skipped: 'not-read' };
  }
  // No gate: every email that reaches the app goes to the model (~$0.0005 each on Haiku), text plus every readable attachment.
  // Matched keywords are only recorded for words.ts.
  const matched = src === 'list' ? ['free-food-list'] : prefilter(`${mail.subject}\n${mail.text}`);
  const base = { id: mail.id, receivedAt, sender: mail.from, subject: mail.subject, snippet: mail.text.slice(0, 300),
    matched: matched.join(','), isFreeFood: null, result: null, threadKey: resolveThread(mail) };
  const previous = threadEvents(base.threadKey);
  const out = await deps.extract({ ...mail, previousEvents: previous.map(e => ({ id: e.id, title: e.title, food: e.food,
    start: e.start_at, end: e.end_at, location: e.location, host: e.host, notes: e.notes,
    leftovers_now: !!e.leftovers, cancelled: !!e.cancelled, confidence: e.confidence ?? 0, quantity: 'unknown' })) });
  let events = (out.events || []).filter(ev => ev.start && !Number.isNaN(Date.parse(ev.start))).slice(0, 10); // one email cannot flood the calendar
  // free-foods list posts are spontaneous ("leftovers in 10-250, come now"): only worth a calendar entry when the event is still
  // ahead or there is a lot of food. Dormspam is never filtered this way.
  if (src === 'list') events = events.filter(ev => Date.parse(ev.start) > Date.now() || ev.quantity === 'large' || previous.some(p => p.id === ev.existing_event_id));
  const changes = events.map(ev => {
    // IDs supplied by the model are accepted only from this thread. A one-event reminder also has an unambiguous match
    // on its original date (including older extractors which did not return an ID).
    const existing = previous.find(p => p.id === ev.existing_event_id)
      ?? previous.find(p => p.dedup_key === dedupKey(ev))
      ?? (previous.length === 1 && events.length === 1 && previous[0].start_at.slice(0, 10) === new Date(ev.start).toISOString().slice(0, 10) ? previous[0] : undefined);
    return { existingId: existing?.id, event: {
      dedupKey: dedupKey(ev), messageId: mail.id, threadKey: base.threadKey, source: existing?.source || src, title: ev.title, food: ev.food || null,
      startAt: new Date(ev.start).toISOString(), endAt: ev.end && !Number.isNaN(Date.parse(ev.end)) ? new Date(ev.end).toISOString() : null,
      location: ev.location || null, host: ev.host || null, notes: ev.notes || null,
      leftovers: ev.leftovers_now, confidence: ev.confidence, cancelled: ev.cancelled,
      sender: out.poster || mail.from, subject: mail.subject, // a forwarded email is credited to the original poster
    } };
  });
  saveExtraction({ ...base, isFreeFood: out.is_free_food ? 1 : 0, result: JSON.stringify(out) }, changes);
  return { source: src, isFreeFood: out.is_free_food, events: events.length };
}

/** Poll an IMAP mailbox for new mail (alternative to the Cloudflare Email Worker -> POST /ingest path). */
export async function pollOnce(): Promise<number> {
  const box = process.env.IMAP_MAILBOX || 'INBOX';
  const client = new ImapFlow({
    host: process.env.IMAP_HOST!, port: Number(process.env.IMAP_PORT || 993), secure: true,
    auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASS }, logger: false,
  });
  client.on('error', (e: Error & { code?: string }) => console.error('[mail] imap error', e.code || e.message)); // without a listener a dropped socket kills the process
  let lock: { release: () => void } | undefined;
  try {
    await client.connect();
    lock = await client.getMailboxLock(box);
    if (!client.mailbox) throw new Error(`cannot open mailbox ${box}`);
    // UIDs are only meaningful per (host, user, mailbox, UIDVALIDITY); a cursor from another mailbox would hide all new mail
    const key = `imap_last_uid:${process.env.IMAP_HOST}/${process.env.IMAP_USER}/${box}/${client.mailbox.uidValidity}`;
    const lastUid = Number(kvGet(key) || 0);
    const found = await client.search(lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - 7 * 864e5) }, { uid: true });
    const uids = (found || []).filter(u => u > lastUid);
    // The cursor does not advance past a failed message, so it is retried on the next polls (seenMessage() skips the ones that
    // succeeded); after 3 failures it is given up on so one poison message cannot make every poll re-download everything after it.
    let maxUid = lastUid, stuck = false;
    if (uids.length) {
      for await (const msg of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
        try {
          console.log('[mail]', msg.uid, JSON.stringify(await processEmail(await parseRaw(msg.source!))));
          if (!stuck) maxUid = Math.max(maxUid, msg.uid);
        } catch (e) {
          const fails = Number(kvGet(`${key}:fail:${msg.uid}`) || 0) + 1;
          kvSet(`${key}:fail:${msg.uid}`, fails);
          if (fails < 3) stuck = true; else if (!stuck) maxUid = Math.max(maxUid, msg.uid);
          console.error('[mail] failed uid', msg.uid, `(attempt ${fails})`, (e as Error).message);
        }
      }
    }
    if (maxUid !== lastUid) kvSet(key, maxUid);
    return uids.length;
  } finally { lock?.release(); await client.logout().catch(() => {}); }
}

export function startPoller(): void {
  if (!process.env.IMAP_HOST) { console.log('[mail] IMAP not configured; only POST /ingest is active'); return; }
  const every = Number(process.env.POLL_MINUTES || 5) * 60e3;
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { console.log('[mail] polled, new:', await pollOnce()); } catch (e) { console.error('[mail] poll error', (e as Error).message); }
    busy = false;
  };
  tick(); setInterval(tick, every);
}
