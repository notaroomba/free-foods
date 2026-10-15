// Win98 desktop shell (window manager ported from badge-paint's win98.js/desktop.js) + the calendar.
// Compiled to public/app.js by `npm run build`.
declare const FullCalendar: any; // global build from the CDN

interface Ev {
  id: number; title: string; start_at: string; end_at: string | null; location: string | null; food: string | null;
  host: string | null; notes: string | null; sender: string | null; subject: string | null;
  leftovers: number; cancelled: number; confidence: number | null; source: 'dormspam' | 'list' | 'other' | null;
}
interface Me { email: string; name?: string; auth: boolean; ics: string; webcal: string; gcal: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// food filters: match on what the model wrote in title / food / notes
const FILTERS: Record<string, RegExp | null> = { all: null, pizza: /pizza|pizzas|slice/i, boba: /boba|bubble tea|milk tea|gong cha|kung fu tea|tiger sugar/i };
let filter = 'all';
try { if (localStorage.getItem('ff-food') && FILTERS[localStorage.getItem('ff-food')!] !== undefined) filter = localStorage.getItem('ff-food')!; } catch {}
const passes = (e: { title: string; food: string | null; notes: string | null }) => !FILTERS[filter] || FILTERS[filter]!.test(`${e.title} ${e.food || ''} ${e.notes || ''}`);
const syncFilterButtons = () => all('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
const all = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d).toLocaleString([], o);
const COLOR = { dormspam: '#008000', list: '#000080', other: '#008000', cancelled: '#808080' }; // colour says where it came from
const color = (e: Ev) => e.cancelled ? COLOR.cancelled : COLOR[e.source || 'dormspam'];
const classes = (e: Ev) => [e.leftovers ? 'now' : '', e.cancelled ? 'cancelled' : '', (e.confidence ?? 1) < 0.6 ? 'low' : '', `src-${e.source || 'dormspam'}`];
const mobile = () => innerWidth < 700;

// ---------- window manager ----------
let z = 500;
const bringFront = (w: HTMLElement) => { w.style.zIndex = String(++z); const bd = w.closest<HTMLElement>('.modal-backdrop'); if (bd) bd.style.zIndex = String(z); };
function makeFloating(w: HTMLElement) {
  if (w.dataset.floating) return;
  const r = w.getBoundingClientRect();
  Object.assign(w.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: '0', maxWidth: 'none', maxHeight: 'none' });
  w.dataset.floating = '1';
}
const track = (move: (ev: PointerEvent) => void) => {
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
};
document.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement;
  const win = t.closest<HTMLElement>('.window'); if (win) bringFront(win);
  const tb = t.closest<HTMLElement>('.titlebar'); if (!tb || t.closest('button')) return;
  const w = tb.closest<HTMLElement>('.window'); if (!w || w.classList.contains('maximized') || mobile()) return;
  makeFloating(w);
  const sx = e.clientX, sy = e.clientY, sl = parseFloat(w.style.left), st = parseFloat(w.style.top);
  track((ev) => {
    w.style.left = `${Math.min(innerWidth - 60, Math.max(60 - w.offsetWidth, sl + ev.clientX - sx))}px`;
    w.style.top = `${Math.min(innerHeight - 60, Math.max(0, st + ev.clientY - sy))}px`;
  });
  e.preventDefault();
});
function addGrip(w: HTMLElement) {
  const g = document.createElement('div'); g.className = 'resize-grip'; g.title = 'Resize'; w.appendChild(g);
  g.addEventListener('pointerdown', (e) => {
    if (w.classList.contains('maximized')) return;
    bringFront(w); makeFloating(w);
    const sx = e.clientX, sy = e.clientY, sw = w.offsetWidth, sh = w.offsetHeight;
    track((ev) => { w.style.width = `${Math.max(300, sw + ev.clientX - sx)}px`; w.style.height = `${Math.max(200, sh + ev.clientY - sy)}px`; cal?.updateSize(); });
    e.preventDefault(); e.stopPropagation();
  });
}

// ---------- apps + taskbar ----------
const APPS: Record<string, { title: string; icon: string }> = {
  calendar: { title: 'Free Foods @ MIT', icon: '/icons/calendar.svg' },
  now: { title: 'Right Now', icon: '/icons/pizza.svg' },
  about: { title: 'About', icon: '/icons/help.svg' },
  subscribe: { title: 'Subscribe', icon: '/icons/disk.svg' },
};
const opened: Record<string, { win: HTMLElement; btn: HTMLButtonElement; prev?: Record<string, string> }> = {};
const taskButtons = $('taskButtons');

function openApp(app: string) {
  const def = APPS[app], win = $(app + 'Win');
  if (!def || !win) return;
  if (opened[app]) { win.hidden = false; opened[app].btn.classList.add('active'); bringFront(win); cal?.updateSize(); return; }
  const n = Object.keys(opened).length;
  win.hidden = false;
  if (!win.dataset.floating) {
    // clear the desktop icons when there is room, otherwise just keep the window on screen
    win.style.left = `${Math.min(Math.max(120, (innerWidth - win.offsetWidth) / 2 + n * 26), Math.max(8, innerWidth - win.offsetWidth - 8))}px`;
    win.style.top = `${Math.min(Math.max(8, (innerHeight - 40 - win.offsetHeight) / 2 + n * 22), Math.max(8, innerHeight - 40 - win.offsetHeight))}px`;
    win.dataset.floating = '1';
    addGrip(win);
  }
  bringFront(win);
  const btn = document.createElement('button');
  btn.className = 'task-btn active';
  btn.innerHTML = `<img src="${def.icon}" alt=""> ${esc(def.title)}`;
  btn.addEventListener('click', () => {
    if (win.hidden) { win.hidden = false; btn.classList.add('active'); bringFront(win); cal?.updateSize(); }
    else { win.hidden = true; btn.classList.remove('active'); }
  });
  taskButtons.appendChild(btn);
  opened[app] = { win, btn };
  if (app === 'calendar') setTimeout(() => cal?.updateSize(), 0);
}
function closeApp(app: string) { const o = opened[app]; if (!o) return; o.win.hidden = true; o.btn.remove(); delete opened[app]; }
for (const app of Object.keys(APPS)) { // title-bar buttons, wired once
  const win = $(app + 'Win');
  win.querySelector('[data-win="min"]')?.addEventListener('click', () => { win.hidden = true; opened[app]?.btn.classList.remove('active'); });
  win.querySelector('[data-win="max"]')?.addEventListener('click', () => {
    const o = opened[app]; if (!o) return;
    if (win.classList.toggle('maximized')) o.prev = { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height };
    else Object.assign(win.style, o.prev || {});
    bringFront(win); cal?.updateSize();
  });
  win.querySelector('[data-win="close"]')?.addEventListener('click', () => closeApp(app));
}

// ---------- menus + start menu ----------
const closeMenus = () => all('.menu.open').forEach(m => m.classList.remove('open'));
all('[data-menu]').forEach(m => {
  m.addEventListener('click', (e) => { e.stopPropagation(); const was = m.classList.contains('open'); closeMenus(); if (!was) m.classList.add('open'); });
  m.addEventListener('pointerenter', () => { if (all('.menu.open').length) { closeMenus(); m.classList.add('open'); } });
});
const startBtn = $('startBtn'), startMenu = $('startMenu');
const toggleStart = (on: boolean = !!startMenu.hidden) => { startMenu.hidden = !on; startBtn.classList.toggle('active', on); };
startBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleStart(); });
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('#startMenu')) toggleStart(false);
  if (!t.closest('.menu')) closeMenus();
});
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-app-open],[data-win-close],[data-action],[data-view],[data-filter]');
  if (!t) return;
  closeMenus(); toggleStart(false);
  if (t.dataset.filter) { filter = t.dataset.filter; try { localStorage.setItem('ff-food', filter); } catch {} syncFilterButtons(); cal.refetchEvents(); loadNow(); }
  if (t.dataset.appOpen) openApp(t.dataset.appOpen);
  if (t.dataset.winClose) closeApp(t.dataset.winClose);
  if (t.dataset.view) cal.changeView(t.dataset.view);
  if (t.dataset.action === 'prev') cal.prev();
  if (t.dataset.action === 'next') cal.next();
  if (t.dataset.action === 'today') cal.today();
  if (t.dataset.action === 'refresh') { cal.refetchEvents(); loadNow(); }
});

// ---------- event dialog ----------
const backdrop = $('backdrop');
function show(e: Ev) {
  $('dlgTitle').textContent = e.title;
  $('dlgBody').innerHTML = `<h2>${esc(e.title)}${e.leftovers ? '<span class="badge">now</span>' : ''}${e.cancelled ? '<span class="badge gray">cancelled</span>' : ''}</h2>
    <dl>
      <dt>When</dt><dd>${fmt(e.start_at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${e.end_at ? ' – ' + fmt(e.end_at, { hour: 'numeric', minute: '2-digit' }) : ''}</dd>
      ${e.location ? `<dt>Where</dt><dd>${esc(e.location)}</dd>` : ''}
      ${e.food ? `<dt>Food</dt><dd>${esc(e.food)}</dd>` : ''}
      ${e.host ? `<dt>Host</dt><dd>${esc(e.host)}</dd>` : ''}
      ${e.notes ? `<dt>Notes</dt><dd>${esc(e.notes)}</dd>` : ''}
      <dt>Source</dt><dd>${e.source === 'list' ? 'free-foods list' : 'dormspam'}: ${esc(e.subject)}${e.sender ? `<br>${esc(e.sender)}` : ''}</dd>
      <dt>Confidence</dt><dd>${Math.round((e.confidence ?? 0) * 100)}%</dd>
    </dl>`;
  backdrop.hidden = false;
  bringFront(backdrop.querySelector<HTMLElement>('.window')!);
}
all('[data-dlg-close]').forEach(b => b.addEventListener('click', () => { backdrop.hidden = true; }));
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { backdrop.hidden = true; closeMenus(); toggleStart(false); } });

// ---------- calendar ----------
let cal: any;
function initCalendar() {
  cal = new FullCalendar.Calendar($('cal'), {
    headerToolbar: false, initialView: mobile() ? 'listWeek' : 'dayGridMonth', height: '100%', nowIndicator: true, dayMaxEvents: 3, fixedWeekCount: false,
    eventDisplay: 'block', // solid colour blocks (default month view draws timed events as a dot + text)
    events: (info: { startStr: string; endStr: string }, ok: (evs: unknown[]) => void, fail: (e: unknown) => void) =>
      fetch(`/api/events?start=${encodeURIComponent(info.startStr)}&end=${encodeURIComponent(info.endStr)}`).then(r => r.json())
        .then((rows: Ev[]) => ok(rows.filter(passes))).catch(fail),
    eventDataTransform: (r: Ev) => ({ id: r.id, title: r.title, start: r.start_at, end: r.end_at || undefined,
      backgroundColor: color(r), borderColor: color(r), classNames: classes(r), extendedProps: r }), // list view's dot takes borderColor
    eventClick: (i: { jsEvent: Event; event: { extendedProps: Ev } }) => { i.jsEvent.preventDefault(); show(i.event.extendedProps); },
    datesSet: () => {
      $('viewTitle').textContent = cal.view.title;
      all('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === cal.view.type));
    },
    eventsSet: (evs: unknown[]) => { $('status').textContent = `${evs.length} event${evs.length === 1 ? '' : 's'} in view`; },
  });
  cal.render();
}

// ---------- right now ----------
let nowShown = false;
async function loadNow() {
  const t = Date.now();
  const rows = (await (await fetch(`/api/events?start=${new Date(t - 3 * 36e5).toISOString()}&end=${new Date(t + 36e5).toISOString()}`)).json()) as Ev[];
  if (!Array.isArray(rows)) return; // a 502 during a deploy hands back an error object
  const endMs = (e: Ev) => e.end_at ? Date.parse(e.end_at) : Date.parse(e.start_at) + 72e5;
  const live = rows.filter(e => passes(e) && !e.cancelled && (e.leftovers || Date.parse(e.start_at) <= t + 36e5) && endMs(e) > t);
  const ul = $('nowList');
  ul.innerHTML = live.length
    ? live.map((e, i) => `<li data-i="${i}"><img src="/icons/pizza.svg" alt=""><b>${esc(e.title)}</b><span>${esc(e.location || '')} · ${e.leftovers ? 'now' : fmt(e.start_at, { hour: 'numeric', minute: '2-digit' })}</span></li>`).join('')
    : '<li class="empty">Nothing right now. Check the calendar for what is coming up.</li>';
  all<HTMLElement>('li[data-i]', ul).forEach(li => li.addEventListener('click', () => show(live[Number(li.dataset.i)])));
  $('nowStatus').textContent = `Right now: ${live.length}`;
  if (live.length && !nowShown && !mobile()) { nowShown = true; openApp('now'); } // on phones the popup would cover the calendar
}

// ---------- clock, identity, boot ----------
const tick = () => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
tick(); setInterval(tick, 15000);

openApp('calendar');
initCalendar();
syncFilterButtons();
loadNow(); setInterval(loadNow, 5 * 60e3);

fetch('/api/me').then(r => r.json() as Promise<Me>).then(me => {
  $<HTMLAnchorElement>('subWebcal').href = me.webcal;
  $<HTMLAnchorElement>('subGcal').href = me.gcal;
  $('icsUrl').textContent = me.ics;
  if (me.auth) { $('who').textContent = me.email; all('[data-logout]').forEach(a => { a.hidden = false; }); }
}).catch(() => {});
