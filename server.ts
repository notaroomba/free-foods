import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { listEvents, stats, deleteEvent, type EventRow } from './db.ts';
import { parseAll, processEmail, startPoller } from './mail.ts';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
const OIDC = process.env.OIDC_CLIENT_ID ? {
  issuer: (process.env.OIDC_ISSUER || 'https://petrock.mit.edu').replace(/\/$/, ''),
  id: process.env.OIDC_CLIENT_ID, secret: process.env.OIDC_CLIENT_SECRET ?? '',
  domain: process.env.ALLOWED_EMAIL_DOMAIN || 'mit.edu',
} : null;
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
if (OIDC && !process.env.SESSION_SECRET) console.warn('SESSION_SECRET unset: sessions reset on every deploy');
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const STATIC = /^\/(index\.html|app\.js|style\.css|icons\/[\w-]+\.svg)$/; // app.js is built by `npm run build` (tsc)
const VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12); // cache-buster for ?v= in index.html
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// --- tiny signed-cookie sessions (stdlib only) ---
interface Session { email: string; name?: string; affiliation?: string | null; exp: number }
const sign = (s: string) => createHmac('sha256', SECRET).update(s).digest('base64url');
const seal = (obj: Session) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${sign(b)}`; };
function unseal(tok: string | undefined): Session | null {
  const [b, sig] = (tok || '').split('.');
  if (!b || !sig) return null;
  const want = Buffer.from(sign(b)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()) as Session; return o.exp > Date.now() ? o : null; } catch { return null; }
}
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } }; // another app's malformed cookie must not 500 every page
const cookies = (req: IncomingMessage): Record<string, string> =>
  Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(dec)).filter(c => c[0]).map(c => [c[0], c.slice(1).join('=')]));
const setCookie = (name: string, val: string, maxAge: number) =>
  `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; ${PUBLIC_URL.startsWith('https') ? 'Secure; ' : ''}Max-Age=${maxAge}`;
const user = (req: IncomingMessage): Session | null => OIDC ? unseal(cookies(req).ff_session) : { email: 'anonymous', exp: Infinity };

// Public site (no login): attribute events by display name only; never publish addresses or internal ids.
export type PublicEvent = Omit<EventRow, 'message_id' | 'dedup_key' | 'thread_key'>;
const pub = (e: EventRow): PublicEvent => {
  if (OIDC) return e;
  const { message_id: _m, dedup_key: _d, thread_key: _t, ...rest } = e;
  return { ...rest, sender: (e.sender || '').replace(/\s*<[^>]*>/g, '').replace(/[^\s@,]+@\S+/g, '').replace(/"/g, '').replace(/\s*,\s*$/, '').trim() || null };
};
// Browser-side backfill: a script running inside Outlook on the web posts raw messages here, so allow that origin.
const INGEST_CORS = { 'access-control-allow-origin': process.env.INGEST_CORS_ORIGIN || 'https://outlook.office.com', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-envelope-from', 'access-control-max-age': '86400' };
const FROM_DOMAINS = (process.env.INGEST_FROM_DOMAINS ?? 'mit.edu').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

// --- OIDC (Petrock -> MIT Touchstone) authorization-code flow ---
interface Disco { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }
let disco: Disco | undefined;
const discover = async (): Promise<Disco> => disco ??= (await (await fetch(`${OIDC!.issuer}/.well-known/openid-configuration`)).json()) as Disco;
async function login(res: ServerResponse) {
  const d = await discover(), state = randomBytes(16).toString('hex');
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({ response_type: 'code', client_id: OIDC!.id, redirect_uri: `${PUBLIC_URL}/auth/callback`, scope: 'openid email profile', state }).toString();
  res.writeHead(302, { Location: u.href, 'Set-Cookie': setCookie('ff_state', state, 600) }); res.end();
}
async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
  const d = await discover(), code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== cookies(req).ff_state) return send(res, 400, 'bad state');
  const tok = (await (await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${OIDC!.id}:${OIDC!.secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${PUBLIC_URL}/auth/callback` }),
  })).json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tok.access_token) return send(res, 401, `login failed: ${tok.error_description || tok.error || 'no token'}`);
  const info = (await (await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}` } })).json()) as
    { sub?: string; email?: string; name?: string; affiliation?: string; gender?: string };
  const email = String(info.email || info.sub || '').toLowerCase(); // Petrock: sub is also kerb@mit.edu
  if (!email.endsWith(`@${OIDC!.domain}`)) return send(res, 403, `Only @${OIDC!.domain} accounts may sign in.`);
  const session: Session = { email, name: info.name, affiliation: info.affiliation ?? info.gender ?? null, exp: Date.now() + 30 * 864e5 }; // Petrock maps affiliation onto the "gender" claim
  res.writeHead(302, { Location: '/', 'Set-Cookie': [setCookie('ff_session', seal(session), 30 * 86400), setCookie('ff_state', '', 0)] });
  res.end();
}

// --- helpers ---
const HTTPS = PUBLIC_URL.startsWith('https');
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  ...(HTTPS ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
};
const send = (res: ServerResponse, code: number, body: string, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, ...SECURITY_HEADERS }); res.end(body); };
const json = (res: ServerResponse, obj: unknown) => send(res, 200, JSON.stringify(obj), 'application/json');
function serveStatic(res: ServerResponse, p: string) {
  const rel = p.slice(1), type = TYPES[extname(rel)];
  try {
    let data: Buffer | string = readFileSync(new URL(rel, PUBLIC_DIR));
    if (rel === 'index.html') data = data.toString().replaceAll('__V__', VERSION);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...SECURITY_HEADERS }); // tiny files; a stale app.js/style.css after a deploy is worse than a revalidation
    res.end(data);
  } catch { send(res, 404, rel === 'app.js' ? 'run `npm run build`' : 'not found'); }
}
const body = (req: IncomingMessage, limit = 64e6) => new Promise<Buffer>((ok, no) => { // several 20 MB attachments in one message
  const c: Buffer[] = []; let n = 0;
  req.on('data', (d: Buffer) => { if ((n += d.length) > limit) { req.destroy(); no(new Error('too large')); } c.push(d); });
  req.on('end', () => ok(Buffer.concat(c))); req.on('error', no);
});
const digest = (s: string) => createHmac('sha256', 'cmp').update(s).digest();
const bearerOk = (req: IncomingMessage, token: string | undefined) =>
  !!token && timingSafeEqual(digest(String(req.headers.authorization || '')), digest(`Bearer ${token}`));

// --- abuse limits (in-memory, per instance; resets on deploy) ---
const buckets = new Map<string, { n: number; reset: number }>();
function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 20000) buckets.clear(); // ponytail: crude memory cap instead of LRU
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n <= max;
}
const clientIp = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

/** RFC 5545 line folding: at most 75 octets per line, continuation lines start with a space (split on character boundaries). */
function fold(line: string): string {
  const out: string[] = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, '');
const icsEsc = (s: string | null | undefined) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|[\r\n]/g, '\\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
export function toICS(events: PublicEvent[], host = 'free-foods'): string {
  // A subscription feed: clients re-fetch it (REFRESH-INTERVAL / X-PUBLISHED-TTL are the hints they honour), so it only carries what is ahead.
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//free-foods//EN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Free Foods @ MIT',
    'X-WR-CALDESC:Free food at MIT from dormspam and the free-foods list', 'X-WR-TIMEZONE:America/New_York',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:ff-${e.id}@${host}`, `DTSTAMP:${icsDate(e.updated_at.replace(' ', 'T') + 'Z')}`, `DTSTART:${icsDate(e.start_at)}`,
      `DTEND:${icsDate(e.end_at || new Date(Date.parse(e.start_at) + 36e5).toISOString())}`,
      `SUMMARY:${icsEsc((e.cancelled ? '[CANCELLED] ' : '') + e.title)}`, `LOCATION:${icsEsc(e.location)}`,
      `DESCRIPTION:${icsEsc([e.food, e.host && `Host: ${e.host}`, e.notes, e.sender && `From: ${e.sender}`].filter(Boolean).join('\n'))}`,
      e.cancelled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// --- routes ---
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', PUBLIC_URL);
  const p = url.pathname;
  if (!allow(`ip:${clientIp(req)}`, 300, 60e3)) return send(res, 429, 'slow down');
  if (p === '/healthz') return json(res, { ok: true, ...stats() });
  if (p === '/ingest' && req.method === 'OPTIONS') { res.writeHead(204, { ...SECURITY_HEADERS, ...INGEST_CORS }); res.end(); return; }
  if (p === '/ingest' && req.method === 'POST') {
    const reply = (code: number, body: string, type?: string) => { res.writeHead(code, { 'content-type': type || 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...INGEST_CORS }); res.end(body); };
    if (!bearerOk(req, process.env.INGEST_TOKEN)) return reply(401, 'bad token');
    // The Cloudflare worker passes the SMTP envelope sender, which Cloudflare has already SPF/DKIM-checked. The inbox address is
    // public, so without this anyone could mail the inbox and spend model tokens. Absent header (curl) = trusted token holder.
    const envFrom = req.headers['x-envelope-from']; // present but empty = null sender (bounces): also ignored
    if (envFrom !== undefined && FROM_DOMAINS.length && !FROM_DOMAINS.includes(String(envFrom).toLowerCase().split('@').pop()!)) return reply(202, 'ignored: sender domain');
    // Spend caps: one mail sender cannot flood the model (token-only callers are trusted), and the inbox has a daily ceiling. 429 makes the worker bounce the mail.
    if (envFrom !== undefined && !allow(`ingest:${String(envFrom).toLowerCase()}`, Number(process.env.MAX_INGEST_PER_SENDER_HOUR || 30), 36e5)) return reply(429, 'sender rate limit');
    if (!allow('ingest:all', Number(process.env.MAX_INGEST_PER_DAY || 1500), 864e5)) return reply(429, 'daily ingest limit');
    const mails = (await parseAll(await body(req))).slice(0, 200).sort((a, b) => +a.date - +b.date);
    if (mails.length === 1 && url.searchParams.get('async') !== '1') {
      const result = await processEmail(mails[0]);
      console.log('[ingest]', JSON.stringify(result)); // delivery outcome, without email contents
      return reply(200, JSON.stringify(result), 'application/json');
    }
    // Backfill (many attached .eml files, or ?async=1): answer now so nothing bounces or times out; process in order.
    reply(200, JSON.stringify({ queued: mails.length }), 'application/json');
    for (const m of mails) processEmail(m).then(r => console.log('[backfill]', m.subject, JSON.stringify(r)), e => console.error('[backfill]', m.subject, (e as Error).message));
    return;
  }
  if (req.method === 'DELETE' && /^\/api\/events\/\d+$/.test(p)) { // moderation: curl -X DELETE -H "Authorization: Bearer $INGEST_TOKEN" .../api/events/ID
    if (!bearerOk(req, process.env.INGEST_TOKEN)) return send(res, 401, 'bad token');
    return json(res, { deleted: deleteEvent(Number(p.split('/').pop())) });
  }
  if (OIDC && p === '/auth/login') return login(res);
  if (OIDC && p === '/auth/callback') return callback(req, res, url);
  if (p === '/auth/logout') { res.writeHead(302, { Location: '/', 'Set-Cookie': setCookie('ff_session', '', 0) }); res.end(); return; }

  const u = user(req);
  if (p === '/calendar.ics') {
    if (OIDC && !u && !(process.env.ICS_TOKEN && url.searchParams.get('token') === process.env.ICS_TOKEN)) return send(res, 401, 'login or ?token= required');
    const now = Date.now(); // upcoming only: from 3 h ago (still-running leftovers) to a year out
    return send(res, 200, toICS(listEvents(new Date(now - 3 * 36e5).toISOString(), new Date(now + 365 * 864e5).toISOString()).map(pub), url.host), 'text/calendar; charset=utf-8');
  }
  if (!u) { res.writeHead(302, { Location: '/auth/login' }); res.end(); return; }
  if (p === '/') return serveStatic(res, '/index.html');
  if (STATIC.test(p)) return serveStatic(res, p);
  if (p === '/api/events') {
    const from = url.searchParams.get('start') || new Date(Date.now() - 7 * 864e5).toISOString();
    const to = url.searchParams.get('end') || new Date(Date.now() + 60 * 864e5).toISOString();
    return json(res, listEvents(new Date(from).toISOString(), new Date(to).toISOString()).map(pub));
  }
  if (p === '/api/me') {
    const ics = `${PUBLIC_URL}/calendar.ics${OIDC && process.env.ICS_TOKEN ? `?token=${process.env.ICS_TOKEN}` : ''}`;
    const webcal = ics.replace(/^https?:/, 'webcal:'); // Apple Calendar / Outlook subscribe (auto-refreshing) instead of a one-off import
    // Google's add-by-URL deep link is undocumented; the webcal:// form is the one that works most reliably
    return json(res, { email: u.email, name: u.name, auth: !!OIDC, ics, webcal, gcal: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` });
  }
  send(res, 404, 'not found');
}

if (process.argv[1] && import.meta.url.endsWith('/' + process.argv[1].split('/').pop())) {
  http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, 'error'); })).listen(PORT, () => {
    console.log(`free-food listening on :${PORT} (${PUBLIC_URL}) auth=${OIDC ? OIDC.issuer : 'off'}`);
    startPoller();
  });
}
