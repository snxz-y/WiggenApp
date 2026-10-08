// Cloudflare Worker — WiggenApp backend
// Deployed at https://nutrition-reciever.margidowiggen.workers.dev
//
// All personal data lives in the PRIVATE repo DATA_REPO. The app's code repo
// (snxz-y/WiggenApp) is public and must never contain data.
//
// Endpoints (all POST, all require the app password):
//   /nutrition-shortcut  Kosthold: iOS Snarveier «Wiggen kosthold» → nutrition.json
//   /agenda         Dagen: Siri/snarvei «Wiggen dag» → påminnelser inn, «hva skal jeg i dag» ut
//   /mcp            MCP-server (Streamable HTTP) for Claude: les helse, trening, søvn, kosthold, kalender, påminnelser.
//                   Auth: OAuth (claude.ai custom connector; login page asks for the app password) or /mcp/<MCP_KEY>.
//   /.well-known/…, /register, /authorize, /token   the Worker's own stateless OAuth server (see below)
//   /data           App: read health/activities/nutrition/reviews        (password)
//   /save-review    Målsetninger: add a goal to reviews.json              (password)
//   /delete-review  Målsetninger: remove a goal from reviews.json         (password)
//   /calendar       Kalender: private overview of the iCal feeds in CAL_FEEDS (password)
//
// Secrets (Cloudflare → Settings → Variables and Secrets):
//   GITHUB_TOKEN  token with read/write access to DATA_REPO
//   CAL_KEY       the app password (one password for data, goals and calendar)
//   CAL_FEEDS     JSON list: [{"name":"Privat","url":"https://...ics","color":"#7c6dfa"}, ...]
//   MCP_KEY       long random string; the MCP endpoint is /mcp/<MCP_KEY> (falls back to CAL_KEY if unset)

const REPO = 'snxz-y/WiggenApp-data';        // DATA_REPO (private)
const DATA_FILES = ['health.json', 'activities.json', 'nutrition.json', 'reviews.json', 'profile.json', 'reminders.json'];
const GH = 'https://api.github.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ── GitHub JSON files ───────────────────────────────────────────────────────
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob((b64 || '').replace(/\s/g, '')), c => c.charCodeAt(0)));
const b64encode = str => { let bin = ''; for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b); return btoa(bin); };

async function gh(path, token, init = {}) {
  return fetch(`${GH}/repos/${REPO}/contents/${path}`, {
    ...init,
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'wiggenapp-worker' },
  });
}

// Read a JSON file from the repo, let `change` modify it, write it back.
// `change` returns { data, result } (or null to skip writing). Retries if the
// file changed on GitHub in between (HTTP 409/422 sha mismatch).
async function updateRepoJson(path, token, message, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 150 * attempt + Math.random() * 400));   // let a parallel writer finish
    const r = await gh(path, token);
    if (!r.ok && r.status !== 404) throw new Error(`GitHub read ${path}: HTTP ${r.status}`);
    const file = r.status === 404 ? { content: null, sha: undefined } : await r.json();   // 404 → create the file
    const out = change(file.content ? JSON.parse(b64decode(file.content)) : []);
    if (!out) return null;
    const w = await gh(path, token, {
      method: 'PUT',
      body: JSON.stringify({ message, sha: file.sha, content: b64encode(JSON.stringify(out.data, null, 2)) }),
    });
    if (w.ok) return out.result;
    if (w.status !== 409 && w.status !== 422) throw new Error(`GitHub write ${path}: HTTP ${w.status}`);
  }
  throw new Error(`GitHub write ${path}: kept conflicting`);
}

// ── Kosthold via iOS Snarveier (Shortcuts) ─────────────────────────────────
// The «Wiggen kosthold» shortcut reads Apple Health with "Find Health Samples,
// Group by Day" for the last 7 days and posts one flat dictionary:
//   {key, dates:"<dates>", calories:"<values>", calories_unit:"kcal",
//    protein:"…", carbs…, fat…, fiber…, saturatedFat…, sugar…}   (or <field>_dates per field)
// Values/dates arrive as lists, or as newline-joined text with Norwegian
// formatting ("1 025,9", "4. okt. 2026 kl. 00:00") – all are accepted. Each
// value is a FULL-DAY total, so it replaces that day's field; re-sending the
// last 7 days every time heals gaps. The last raw payload is kept in the
// private repo as nutrition_debug.json for troubleshooting.
const SHORTCUT_FIELDS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'saturatedFat', 'sugar', 'water'];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
const asList = v => Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(/\r?\n/).map(x => x.trim()).filter(Boolean));
function toNumber(v) {
  if (typeof v === 'number') return v;
  const m = String(v).replace(/[\s  ]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? +m[0] : null;
}
function toIsoDate(v) {
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z$/);
  if (m) return fmtNaive(utcToOslo(new Date(s)), true);                         // UTC → Oslo day
  if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`; // ISO (local)
  if ((m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/))) return `${m[3]}-${p2(+m[2])}-${p2(+m[1])}`;
  if ((m = s.match(/(\d{1,2})\.?\s+([a-zæøå]+)\.?,?\s+(\d{4})/i))) {           // 4. okt. 2026
    const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo) return `${m[3]}-${p2(mo)}-${p2(+m[1])}`;
  }
  if ((m = s.match(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i))) {                 // Oct 4, 2026
    const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; if (mo) return `${m[3]}-${p2(mo)}-${p2(+m[2])}`;
  }
  return null;
}
function shortcutEntries(body) {
  const days = {}, skipped = [];
  for (const f of SHORTCUT_FIELDS) {
    const vals = asList(body[f]), dates = asList(body[f + '_dates'] ?? body.dates);   // per-field dates, or one shared list
    // Energy may arrive in J (Shortcuts default), kJ or kcal → divisor to kcal
    const unitText = f === 'calories' ? String(body.calories_unit || '') + ' ' + vals.join(' ') : '';
    const div = !unitText ? 1 : /kj/i.test(unitText) ? 4.184 : /(^|[\s\d])j\b/i.test(unitText) ? 4184 : 1;
    vals.forEach((v, i) => {
      const date = toIsoDate(dates[i]), n = toNumber(v);
      if (!date || n == null) { skipped.push(`${f}[${i}]`); return; }
      if (n <= 0) return;                     // 0 = nothing logged (or Health locked): never overwrite real data
      const kcal = div === 1 && f === 'calories' && n > 100000 ? n / 4184 : n / div;   // unlabelled joules
      days[date] ||= { date };
      days[date][f] = Math.round(kcal * 10) / 10;
    });
  }
  return { entries: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)), skipped };
}
async function saveNutritionShortcut(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  const { key, ...raw } = body;
  const { entries, skipped } = shortcutEntries(raw);
  const sum = entries.map(e => `${e.date.slice(8)}/${e.date.slice(5, 7)}: ${e.calories != null ? Math.round(e.calories) + ' kcal' : '–'}`).join(', ');
  const reply = (ok, extra) => json({ ok, days: entries.length, skipped, ...extra });
  // The iOS "app closed" automation often fires several times within a minute.
  // Identical payloads inside 2 minutes are acknowledged without touching GitHub.
  const rawJson = JSON.stringify(raw);
  let duplicate = false;
  try {
    await updateRepoJson('nutrition_debug.json', env.GITHUB_TOKEN, 'Nutrition shortcut payload', prev => {
      const p = prev && !Array.isArray(prev) ? prev : {};
      if (p.rawJson === rawJson && Date.now() - Date.parse(p.receivedAt || 0) < 120e3) { duplicate = true; return null; }
      return { data: { receivedAt: new Date().toISOString(), parsed: entries, skipped, raw, rawJson } };
    });
  } catch (e) { /* diagnostics only */ }
  if (duplicate) return reply(true, { message: `Allerede lagret – ${sum}`, duplicate: true });
  if (!entries.length) return reply(true, { message: 'Fant ingen data å lagre' });
  try {
    await updateRepoJson('nutrition.json', env.GITHUB_TOKEN, 'Nutrition sync (Snarveier)', current => {
      const byDate = Object.fromEntries(current.map(e => [e.date, e]));
      for (const e of entries) byDate[e.date] = { ...byDate[e.date], ...e };
      return { data: Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)) };
    });
  } catch (e) {
    // Answer 200 anyway: a failed automation only produces an iOS error banner,
    // and the next run re-sends the same 7 days, so nothing is lost.
    return reply(false, { message: `Kunne ikke lagre nå (${e.message}) – neste kjøring prøver igjen` });
  }
  return reply(true, { message: `Lagret ${entries.length} dager – ${sum}` });
}

// ── Password check (shared by /data, goals and /calendar) ─────────────────
async function authorized(body, env) {
  return !!(env.CAL_KEY && body && body.key && await sameSecret(body.key, env.CAL_KEY));
}

// ── App data (private repo → app) ──────────────────────────────────────────
// POST /data {key} → {files: {"health.json": [...], ...}}
async function readRepoJson(path, env) {
  const r = await gh(path, env.GITHUB_TOKEN);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read ${path}: HTTP ${r.status}`);
  const meta = await r.json();
  // Files over 1 MB come back without inline content; fetch the blob instead.
  const content = meta.content || (await (await fetch(meta.git_url, { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, 'User-Agent': 'wiggenapp-worker' } })).json()).content;
  return JSON.parse(b64decode(content));
}
async function readData(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  const files = {};
  await Promise.all(DATA_FILES.map(async f => { files[f] = (await readRepoJson(f, env)) ?? []; }));
  return json({ files });
}

// ── Målsetninger (reviews.json) ────────────────────────────────────────────
// Body: {key, goal:{...}} to save, {key, date, period, content} to delete.
async function saveGoal(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  const goal = body.goal;
  if (!goal || typeof goal !== 'object') return json({ error: 'goal mangler' }, 400);
  await updateRepoJson('reviews.json', env.GITHUB_TOKEN, 'Save review', current => ({ data: [goal, ...current] }));
  return json({ ok: true });
}

async function deleteGoal(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  const { date, period, content } = body;
  const found = await updateRepoJson('reviews.json', env.GITHUB_TOKEN, 'Delete review', current => {
    // Remove only the first exact match (handles duplicates).
    const i = current.findIndex(r => r.date === date && r.period === period && r.content === content);
    return i === -1 ? null : { data: current.filter((_, k) => k !== i), result: true };
  });
  return found ? json({ ok: true }) : json({ ok: false, error: 'Review not found' }, 404);
}

// ── Calendar overview (private) ────────────────────────────────────────────
// POST /calendar {key, from:'YYYY-MM-DD', to:'YYYY-MM-DD'} → events from every
// iCal feed in the CAL_FEEDS secret. CAL_KEY is the password the app sends.
// Nothing is stored anywhere; feeds are fetched on demand (10 min edge cache).
// Times are returned as Europe/Oslo wall-clock strings ('YYYY-MM-DDTHH:MM');
// all-day events as 'YYYY-MM-DD' with an exclusive end date.
const DAY = 864e5;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const p2 = n => String(n).padStart(2, '0');

// "Naive" Dates: the UTC fields hold Oslo wall-clock time.
function lastSunday(y, month1) { const d = new Date(Date.UTC(y, month1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d; }
function utcToOslo(d) {
  const y = d.getUTCFullYear();
  const s = lastSunday(y, 3), e = lastSunday(y, 10);
  s.setUTCHours(1); e.setUTCHours(1);
  return new Date(d.getTime() + (d >= s && d < e ? 2 : 1) * 36e5);
}
function parseIcsDate(prop, v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  if (!m[4] || /VALUE=DATE(?!-)/i.test(prop)) return { d: new Date(Date.UTC(+m[1], m[2] - 1, +m[3])), allDay: true };
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  return { d: m[7] ? utcToOslo(d) : d, allDay: false };   // TZID/floating treated as Oslo time
}
const icsText = v => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const fmtNaive = (d, allDay) => allDay
  ? `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
  : `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;

function parseIcs(text) {
  const lines = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  const events = []; let cur = null, depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: new Set() }; depth = 0; continue; }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) { depth++; continue; }          // skip VALARM etc.
    if (line.startsWith('END:') && depth) { depth--; continue; }
    if (line === 'END:VEVENT') {
      if (cur.start && (cur.status || '').toUpperCase() !== 'CANCELLED') events.push(cur);
      cur = null; continue;
    }
    if (depth) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const prop = line.slice(0, i), val = line.slice(i + 1), name = prop.split(';')[0].toUpperCase();
    if (name === 'DTSTART') { const r = parseIcsDate(prop, val); if (r) { cur.start = r.d; cur.allDay = r.allDay; } }
    else if (name === 'DTEND') { const r = parseIcsDate(prop, val); if (r) cur.end = r.d; }
    else if (name === 'RECURRENCE-ID') { const r = parseIcsDate(prop, val); if (r) cur.recurrenceId = r.d.getTime(); }
    else if (name === 'EXDATE') val.split(',').forEach(x => { const r = parseIcsDate(prop, x); if (r) cur.exdates.add(r.d.getTime()); });
    else if (name === 'SUMMARY') cur.title = icsText(val);
    else if (name === 'LOCATION') cur.location = icsText(val);
    else if (name === 'DESCRIPTION') cur.description = icsText(val);
    else if (name === 'UID') cur.uid = val;
    else if (name === 'RRULE') cur.rrule = val;
    else if (name === 'STATUS') cur.status = val;
  }
  return events;
}

// Occurrence start times of one event that overlap [from, to).
function occurrences(ev, from, to) {
  const dur = ev.end && ev.end > ev.start ? ev.end - ev.start : (ev.allDay ? DAY : 36e5);
  const s = ev.start;
  const hit = t => t < to && t.getTime() + dur > from && !ev.exdates.has(t.getTime());
  if (!ev.rrule) return hit(s) ? [s] : [];
  const r = Object.fromEntries(ev.rrule.split(';').map(x => x.split('=')));
  const freq = r.FREQ, interval = Math.max(1, +(r.INTERVAL || 1));
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? parseIcsDate('', r.UNTIL)?.d : null;
  const byday = r.BYDAY ? r.BYDAY.split(',') : null;
  const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
  const hh = s.getUTCHours(), mi = s.getUTCMinutes();
  const mk = (y, mo, d) => new Date(Date.UTC(y, mo, d, hh, mi));
  // Without COUNT we can jump close to the window instead of walking from DTSTART.
  const step = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[freq];
  if (!step) return hit(s) ? [s] : [];
  let i = count === Infinity ? Math.max(0, Math.floor((from - s - dur) / (interval * step * DAY)) - 1) : 0;
  const out = []; let n = 0;
  for (let guard = 0; guard < 3000; guard++, i++) {
    let c = [];
    if (freq === 'DAILY') c = [new Date(s.getTime() + i * interval * DAY)];
    else if (freq === 'WEEKLY') {
      const monday = s.getTime() - ((s.getUTCDay() + 6) % 7) * DAY + i * interval * 7 * DAY;
      const days = byday ? byday.map(x => WD.indexOf(x.slice(-2))).filter(x => x >= 0) : [s.getUTCDay()];
      c = days.map(dw => new Date(monday + ((dw + 6) % 7) * DAY)).sort((a, b) => a - b);
    } else if (freq === 'MONTHLY') {
      const y = s.getUTCFullYear(), mo = s.getUTCMonth() + i * interval, want = ((mo % 12) + 12) % 12;
      if (byday) {
        for (const x of byday) {
          const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/); if (!m) continue;
          const dw = WD.indexOf(m[2]), nth = m[1] ? +m[1] : 0, all = [];
          for (let d = 1; d <= 31; d++) { const t = mk(y, mo, d); if (t.getUTCMonth() !== want) break; if (t.getUTCDay() === dw) all.push(t); }
          if (nth > 0 && all[nth - 1]) c.push(all[nth - 1]);
          else if (nth < 0 && all[all.length + nth]) c.push(all[all.length + nth]);
          else if (!nth) c.push(...all);
        }
      } else for (const d of (bymd || [s.getUTCDate()])) { const t = mk(y, mo, d); if (d > 0 && t.getUTCMonth() === want) c.push(t); }
      c.sort((a, b) => a - b);
    } else {
      const t = mk(s.getUTCFullYear() + i * interval, s.getUTCMonth(), s.getUTCDate());
      if (t.getUTCDate() === s.getUTCDate()) c = [t];
    }
    let done = false;
    for (const t of c) {
      if (t < s) continue;
      if ((until && t > until) || n >= count || t >= to) { done = true; break; }
      n++;
      if (hit(t)) out.push(t);
    }
    if (done) break;
  }
  return out;
}

function eventsInRange(text, from, to) {
  const evs = parseIcs(text);
  const moved = new Map();   // uid → Set of original start times replaced by a RECURRENCE-ID override
  for (const e of evs) if (e.recurrenceId != null && e.uid) {
    if (!moved.has(e.uid)) moved.set(e.uid, new Set());
    moved.get(e.uid).add(e.recurrenceId);
  }
  const out = [];
  for (const e of evs) {
    const skip = e.recurrenceId == null && moved.get(e.uid);
    const dur = e.end && e.end > e.start ? e.end - e.start : (e.allDay ? DAY : 36e5);
    for (const t of occurrences(e, from, to)) {
      if (skip && skip.has(t.getTime())) continue;
      out.push({ title: e.title || '(uten tittel)', location: e.location || null, allDay: !!e.allDay,
                 description: e.description ? e.description.slice(0, 5000) : null,
                 start: fmtNaive(t, e.allDay), end: fmtNaive(new Date(t.getTime() + dur), e.allDay) });
    }
  }
  return out;
}

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', enc.encode(String(v)))));
  const u = new Uint8Array(x), w = new Uint8Array(y); let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ w[i];
  return diff === 0;
}

async function fetchCalendars(env, from, to) {
  let feeds;
  try { feeds = JSON.parse(env.CAL_FEEDS || '[]'); } catch (e) { throw new Error('CAL_FEEDS er ikke gyldig JSON'); }
  const cals = await Promise.all(feeds.map(async f => {
    try {
      const r = await fetch(String(f.url).replace(/^webcal:/i, 'https:'), { cf: { cacheTtl: 600, cacheEverything: true } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { name: f.name, color: f.color || null, events: eventsInRange(await r.text(), from, to) };
    } catch (e) {
      return { name: f.name, color: f.color || null, error: e.message, events: [] };
    }
  }));
  return {
    calendars: cals.map(c => ({ name: c.name, color: c.color, error: c.error || null })),
    events: cals.flatMap((c, i) => c.events.map(e => ({ ...e, cal: i }))),
  };
}

async function handleCalendar(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  const isoDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(s + 'T00:00:00Z') : null;
  const now = utcToOslo(new Date()); now.setUTCHours(0, 0, 0, 0);
  const from = isoDay(body.from) || new Date(now.getTime() - 7 * DAY);
  let to = isoDay(body.to) || new Date(now.getTime() + 60 * DAY);
  if (to - from > 400 * DAY) to = new Date(from.getTime() + 400 * DAY);
  let cal;
  try { cal = await fetchCalendars(env, from, to); } catch (e) { return json({ error: e.message }, 500); }
  return json({ from: fmtNaive(from, true), to: fmtNaive(to, true), ...cal });
}

// ── Dagen («Hva skal jeg i dag?») ──────────────────────────────────────────
// POST /agenda {key, day, titles, dues, lists, titles_overdue, dues_overdue, lists_overdue}
// The iOS shortcut «Wiggen dag» sends the open reminders it finds (titles,
// due dates and list names as aligned lists or newline text). When reminders
// are included they replace reminders.json; when they are left out the stored
// ones are used (the app and Siri can then ask without re-reading Reminders).
// `day` is spoken language: «i dag», «i morgen», «denne uka», «helga»,
// a weekday («fredag») or a date. The answer has `message` (for the screen)
// and `speech` (shorter, for Siri), plus the raw events/reminders/health.
const WDAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];
const MNAMES = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const dayLabel = d => `${WDAYS[d.getUTCDay()]} ${d.getUTCDate()}. ${MNAMES[d.getUTCMonth()]}`;
function toIsoDateTime(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/.test(s)) return fmtNaive(utcToOslo(new Date(s)), false);
  const d = toIsoDate(s); if (!d) return null;
  const m = s.match(/(\d{1,2}):(\d{2})/);                       // «9. okt. 2026, 12:00»
  return m && !(+m[1] === 0 && m[2] === '00') ? `${d}T${p2(+m[1])}:${m[2]}` : d;   // 00:00 = no time set
}
function parseReminders(body) {
  const seen = new Set(), out = []; let any = false;
  for (const suf of ['', '_overdue']) {
    if (body['titles' + suf] == null) continue;
    any = true;
    const t = asList(body['titles' + suf]), d = asList(body['dues' + suf]), l = asList(body['lists' + suf]);
    t.forEach((title, i) => {
      const due = d[i] ? toIsoDateTime(d[i]) : null, k = title + '|' + (due || '');
      if (!title || seen.has(k)) return;
      seen.add(k); out.push({ title, due, list: l[i] || null });
    });
  }
  return any ? out.sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9'))) : null;
}
function resolveDay(v, today) {
  const s = String(v ?? '').trim().toLowerCase().replace(/^(på|for)\s+/, '');
  if (!s || /^(i ?dag|today|0)$/.test(s)) return { from: today, days: 1, label: 'I dag' };
  if (/^(i ?morgen|tomorrow|1)$/.test(s)) return { from: addDays(today, 1), days: 1, label: 'I morgen' };
  if (/^(i ?overmorgen|2)$/.test(s)) return { from: addDays(today, 2), days: 1, label: 'I overmorgen' };
  if (/uk[ae]|week/.test(s)) return { from: today, days: 7, label: 'Denne uka' };
  if (/helg|weekend/.test(s)) { const n = (6 - today.getUTCDay() + 7) % 7; return { from: addDays(today, n), days: 2, label: 'Helga' }; }
  const wd = WDAYS.indexOf(s);
  if (wd >= 0) { let n = (wd - today.getUTCDay() + 7) % 7; if (!n) n = 7; return { from: addDays(today, n), days: 1, label: null }; }
  const iso = toIsoDate(s);
  if (iso) return { from: new Date(iso + 'T00:00:00Z'), days: 1, label: null };
  return { from: today, days: 1, label: 'I dag' };
}
const evTime = (e, ds) => e.allDay ? 'Hele dagen'
  : e.start.slice(0, 10) === ds && e.end.slice(0, 10) === ds ? `${e.start.slice(11)}–${e.end.slice(11)}`
  : e.start.slice(0, 10) === ds ? `${e.start.slice(11)} →` : e.end.slice(0, 10) === ds ? `→ ${e.end.slice(11)}` : 'Hele dagen';
const say = t => String(t).replace(/–/g, ' til ').replace(/\s+/g, ' ').trim();
const fmtN = n => Math.round(n).toLocaleString('nb-NO').replace(/\u00a0/g, ' ');

function healthLine(h, nutr, targets) {
  if (!h && !nutr) return null;
  const parts = [], spoken = [];
  if (h?.trainingReadiness != null) { const lvl = h.trainingReadinessLevel ? ` (${garminTitle(h.trainingReadinessLevel)})` : ''; parts.push(`Readiness ${h.trainingReadiness}${lvl}`); spoken.push(`Readiness ${h.trainingReadiness}`); }
  if (h?.sleepScore != null) { parts.push(`Sleep Score ${h.sleepScore}`); spoken.push(`Sleep Score ${h.sleepScore}`); }
  if (h?.recoveryTimeHrs != null) { const t = h.recoveryTimeHrs ? `${Math.round(h.recoveryTimeHrs)} t` : '0 t'; parts.push(`Recovery Time ${t}`); if (h.recoveryTimeHrs >= 12) spoken.push(`${Math.round(h.recoveryTimeHrs)} timer Recovery Time igjen`); }
  if (h?.trainingStatus) parts.push(`Training Status ${garminTitle(h.trainingStatus)}`);
  if (targets?.calories) { const left = targets.calories - (nutr?.calories || 0); parts.push(`${fmtN(left)} kcal igjen`); spoken.push(`${fmtN(left)} kalorier igjen`); }
  return parts.length ? { text: parts.join(' · '), speech: spoken.join(', ') } : null;
}
const garminTitle = v => String(v).toLowerCase().replace(/_/g, ' ').replace(/(^|\s)\S/g, c => c.toUpperCase());

function freeSlots(timed, ds) {
  // Gaps of 90 min or more between 08:00 and 21:00 on one day.
  const toMin = t => +t.slice(11, 13) * 60 + +t.slice(14, 16);
  const busy = timed.map(e => [e.start.slice(0, 10) < ds ? 0 : toMin(e.start), e.end.slice(0, 10) > ds ? 1440 : toMin(e.end)]).sort((a, b) => a[0] - b[0]);
  const out = []; let cur = 8 * 60;
  const fm = m => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
  for (const [s, e] of busy) { if (s - cur >= 90) out.push(`${fm(cur)}–${fm(Math.min(s, 21 * 60))}`); cur = Math.max(cur, e); if (cur >= 21 * 60) break; }
  if (21 * 60 - cur >= 90) out.push(`${fm(cur)}–21:00`);
  return out;
}

async function handleAgenda(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  return json(await buildAgenda(env, body.day, parseReminders(body)));
}
// Core of /agenda, also used by the MCP tool get_agenda.
async function buildAgenda(env, dayText, sent) {
  const nowOslo = utcToOslo(new Date()), today = new Date(nowOslo); today.setUTCHours(0, 0, 0, 0);
  const todayS = fmtNaive(today, true);
  let stored = null;
  if (sent) {
    stored = { updatedAt: new Date().toISOString(), items: sent };
    await updateRepoJson('reminders.json', env.GITHUB_TOKEN, 'Reminders sync (Snarveier)', () => ({ data: stored })).catch(() => {});
  } else {
    stored = await readRepoJson('reminders.json', env).catch(() => null);
  }
  const reminders = (stored?.items || []).map(r => ({ ...r, overdue: !!r.due && r.due.slice(0, 10) < todayS }));
  const { from, days, label } = resolveDay(dayText, today);
  const to = addDays(from, days);
  const [cal, health, nutrition, profile] = await Promise.all([
    fetchCalendars(env, from, to).catch(e => ({ calendars: [], events: [], error: e.message })),
    days === 1 && fmtNaive(from, true) === todayS ? readRepoJson('health.json', env).catch(() => null) : null,
    days === 1 && fmtNaive(from, true) === todayS ? readRepoJson('nutrition.json', env).catch(() => null) : null,
    readRepoJson('profile.json', env).catch(() => null),
  ]);
  const lines = [], spoken = [];
  const remOn = ds => reminders.filter(r => r.due && r.due.slice(0, 10) === ds);
  const fmtRem = r => `${r.title}${r.due && r.due.length > 10 ? ` (${r.due.slice(11)})` : ''}${r.list && !/^(påminnelser|reminders)$/i.test(r.list) ? ` · ${r.list}` : ''}`;
  const overdue = reminders.filter(r => r.overdue);
  for (let k = 0; k < days; k++) {
    const d = addDays(from, k), ds = fmtNaive(d, true), ns = fmtNaive(addDays(d, 1), true);
    const evs = cal.events.filter(e => e.allDay ? (e.start <= ds && e.end > ds) : (e.start < ns + 'T00:00' && e.end > ds + 'T00:00'))
      .sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start));
    const rems = remOn(ds);
    const head = (k === 0 && label ? label + ' · ' : '') + dayLabel(d);
    if (days > 1 && !evs.length && !rems.length) continue;
    lines.push(k ? '' : null, head.charAt(0).toUpperCase() + head.slice(1));
    spoken.push(head.charAt(0).toUpperCase() + head.slice(1) + '.');
    if (!evs.length && !rems.length) { lines.push('Ingen avtaler og ingen påminnelser.'); spoken.push('Ingen avtaler og ingen påminnelser.'); }
    for (const e of evs) {
      const cn = cal.calendars[e.cal]?.name;
      lines.push(`🗓 ${evTime(e, ds)} ${e.title}${e.location ? ' · ' + e.location : ''}${cn && days === 1 ? ` (${cn})` : ''}`);
      spoken.push(e.allDay ? `${e.title} hele dagen.` : `${say(evTime(e, ds))}: ${e.title}${e.location ? ', ' + e.location : ''}.`);
    }
    if (rems.length) { for (const r of rems) lines.push(`✅ ${fmtRem(r)}`); spoken.push((rems.length === 1 ? 'Påminnelse: ' : 'Påminnelser: ') + rems.map(r => r.title + (r.due.length > 10 ? ` klokka ${r.due.slice(11)}` : '')).join(', ') + '.'); }
    if (k === 0 && overdue.length) { for (const r of overdue) lines.push(`⚠️ Forfalt: ${r.title} (${r.due.slice(8, 10)}/${r.due.slice(5, 7)})`); spoken.push(`${overdue.length === 1 ? 'Én forfalt påminnelse' : overdue.length + ' forfalte påminnelser'}: ${overdue.map(r => r.title).join(', ')}.`); }
    if (days === 1) {
      const hl = healthLine(Array.isArray(health) ? health.find(x => x.date === ds) : null, Array.isArray(nutrition) ? nutrition.find(x => x.date === ds) : null, profile?.targets);
      if (hl) { lines.push(`💪 ${hl.text}`); spoken.push(hl.speech + '.'); }
      const timed = evs.filter(e => !e.allDay);
      if (timed.length) { const fs = freeSlots(timed, ds); if (fs.length) { lines.push(`⏱ Ledig ${fs.join(', ')}`); spoken.push('Ledig ' + fs.map(say).join(' og ') + '.'); } }
    }
  }
  if (days > 1 && lines.length === 0) { lines.push(`${label}: ingen avtaler og ingen påminnelser.`); spoken.push(`${label}: ingen avtaler og ingen påminnelser.`); }
  if (cal.error) lines.push(`⚠️ Kalenderen kunne ikke hentes (${cal.error})`);
  const message = lines.filter(l => l !== null).join('\n');
  return { ok: true, day: { from: fmtNaive(from, true), to: fmtNaive(addDays(to, -1), true), label }, message, speech: spoken.join(' '),
    events: cal.events, calendars: cal.calendars, reminders, remindersUpdatedAt: stored?.updatedAt || null, stored: !!sent };
}


// ── MCP-server («Spør dataene dine») ───────────────────────────────────────
// Streamable-HTTP MCP endpoint at /mcp/<MCP_KEY>. The secret lives in the URL
// because claude.ai custom connectors and Claude Code can connect to a server
// without OAuth; set MCP_KEY (Cloudflare secret) to a long random string.
// Stateless JSON-RPC: initialize, ping, tools/list, tools/call. GET → 405.
const MCP_PROTOCOL = '2025-06-18';
const todayOslo = () => { const d = utcToOslo(new Date()); d.setUTCHours(0, 0, 0, 0); return d; };
const isoDate = d => fmtNaive(d, true);
const clampRange = (from, to, maxDays, defDays) => {
  const t = todayOslo();
  let b = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? new Date(to + 'T00:00:00Z') : t;
  let a = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? new Date(from + 'T00:00:00Z') : addDays(b, -(defDays - 1));
  if (a > b) [a, b] = [b, a];
  if ((b - a) / DAY > maxDays) a = addDays(b, -maxDays);
  return { from: isoDate(a), to: isoDate(b) };
};
const inRange = (rows, r) => (rows || []).filter(x => x.date >= r.from && x.date <= r.to).sort((a, b) => a.date.localeCompare(b.date));
const avg = (rows, k, dec = 1) => { const v = rows.map(x => x[k]).filter(x => typeof x === 'number'); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(dec) : null; };
const SERIES_KEYS = ['bodyBatterySeries', 'trainingReadinessSeries'];
const slim = (h, keep) => { const o = {}; for (const k of Object.keys(h)) if (!SERIES_KEYS.includes(k) && (!keep || keep.includes(k) || k === 'date')) o[k] = h[k]; return o; };
const SLEEP_KEYS = ['date', 'sleepScore', 'sleepSec', 'bedTime', 'wakeTime', 'deepSec', 'lightSec', 'remSec', 'awakeSec', 'hrvAvg', 'hrvStatus', 'rhr', 'avgResp', 'bbWake'];

const MCP_TOOLS = [
  { name: 'get_agenda', description: 'Hva som skjer en gitt dag: kalenderavtaler, påminnelser med frist, forfalte påminnelser, ledige luker og (for i dag) readiness, søvn, recovery og kalorier igjen. Samme svar som Siri-snarveien «Hva skal jeg i dag».',
    inputSchema: { type: 'object', properties: { day: { type: 'string', description: '«i dag», «i morgen», «denne uka», «helga», en ukedag («fredag») eller en dato (YYYY-MM-DD). Standard: i dag.' } } } },
  { name: 'get_calendar', description: 'Kalenderavtaler (alle abonnerte kalendere: privat, timeplan, helligdager) i et datointervall. Tider er norsk lokaltid.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD (standard: i dag)' }, to: { type: 'string', description: 'YYYY-MM-DD (standard: from + 7 dager, maks 120 dager)' } } } },
  { name: 'get_reminders', description: 'Åpne påminnelser fra iOS Påminnelser (slik de sist ble sendt av snarveien «Wiggen dag»), med frist og liste. Forfalte er merket.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_health', description: 'Daglige Garmin-målinger (Training Readiness, Sleep Score, HRV, hvilepuls, Body Battery, stress, skritt, Training Status, Acute/Chronic Load, VO2 Max, vekt m.m.) for et datointervall. Standard: siste 14 dager, maks 90.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, fields: { type: 'array', items: { type: 'string' }, description: 'Valgfritt: bare disse feltene (date kommer alltid med)' } } } },
  { name: 'get_sleep', description: 'Søvn per natt: Sleep Score, varighet, leggetid, våknetid, faser, HRV og hvilepuls. Standard: siste 14 netter, maks 90.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'get_activities', description: 'Treningsøkter (løping, sykling, gåturer) med distanse, tid, puls, belastning, soner og dynamikk. Standard: siste 30 dager, maks 365. Runder (splits) hentes med get_activity.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string', enum: ['running', 'cycling', 'walking'] } } } },
  { name: 'get_activity', description: 'Én økt i detalj, inkludert runder (splits).', inputSchema: { type: 'object', properties: { activityId: { type: 'number' } }, required: ['activityId'] } },
  { name: 'get_nutrition', description: 'Kosthold per dag (kcal, protein, karbohydrater, fett, fiber, sukker) fra MacroFactor, pluss målene. Standard: siste 14 dager, maks 120.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
  { name: 'get_summary', description: 'Oppsummering av en periode mot perioden før: trening (økter, km, belastning), søvn, readiness, hvilepuls, HRV, skritt, kosthold mot mål og vekt. Bruk denne først for «hvordan gikk uka».',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Antall dager (standard 7, maks 90)' } } } },
  { name: 'get_profile', description: 'Profil: alder, målvekt, kroppsfettmål, kostholdsmål, pulssoner og terskel fra Garmin.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_goals', description: 'Lagrede målsetninger fra appen.', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_goal', description: 'Lagre en ny målsetning i appen (vises under Målsetninger).', inputSchema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
];

async function mcpCall(name, a, env) {
  a = a || {};
  switch (name) {
    case 'get_agenda': { const r = await buildAgenda(env, a.day, null); return { day: r.day, message: r.message, events: r.events, reminders: r.reminders, remindersUpdatedAt: r.remindersUpdatedAt }; }
    case 'get_calendar': {
      const t = todayOslo(), from = /^\d{4}-\d{2}-\d{2}$/.test(a.from || '') ? new Date(a.from + 'T00:00:00Z') : t;
      let to = /^\d{4}-\d{2}-\d{2}$/.test(a.to || '') ? addDays(new Date(a.to + 'T00:00:00Z'), 1) : addDays(from, 7);
      if ((to - from) / DAY > 120) to = addDays(from, 120);
      const cal = await fetchCalendars(env, from, to);
      return { from: isoDate(from), to: isoDate(addDays(to, -1)), calendars: cal.calendars, events: cal.events.map(e => ({ ...e, calendar: cal.calendars[e.cal]?.name, cal: undefined, description: e.description ? e.description.slice(0, 500) : null })) };
    }
    case 'get_reminders': { const r = await readRepoJson('reminders.json', env); const todayS = isoDate(todayOslo());
      return { updatedAt: r?.updatedAt || null, items: (r?.items || []).map(x => ({ ...x, overdue: !!x.due && x.due.slice(0, 10) < todayS })) }; }
    case 'get_health': { const r = clampRange(a.from, a.to, 90, 14); const rows = inRange(await readRepoJson('health.json', env), r); return { ...r, days: rows.map(h => slim(h, Array.isArray(a.fields) && a.fields.length ? a.fields : null)) }; }
    case 'get_sleep': { const r = clampRange(a.from, a.to, 90, 14); const rows = inRange(await readRepoJson('health.json', env), r).filter(h => h.sleepSec); return { ...r, nights: rows.map(h => slim(h, SLEEP_KEYS)) }; }
    case 'get_activities': { const r = clampRange(a.from, a.to, 365, 30); let rows = inRange(await readRepoJson('activities.json', env), r); if (a.type) rows = rows.filter(x => x.type === a.type);
      return { ...r, count: rows.length, activities: rows.map(({ splits, ...x }) => ({ ...x, laps: Array.isArray(splits) ? splits.length : 0 })) }; }
    case 'get_activity': { const x = (await readRepoJson('activities.json', env) || []).find(y => y.activityId === +a.activityId); if (!x) throw new Error('Fant ingen økt med activityId ' + a.activityId); return x; }
    case 'get_nutrition': { const r = clampRange(a.from, a.to, 120, 14); const [n, p] = await Promise.all([readRepoJson('nutrition.json', env), readRepoJson('profile.json', env)]); const rows = inRange(n, r);
      return { ...r, targets: p?.targets || null, days: rows }; }
    case 'get_summary': return summarize(env, Math.min(90, Math.max(1, +a.days || 7)));
    case 'get_profile': { const [p, h] = await Promise.all([readRepoJson('profile.json', env), readRepoJson('health.json', env)]); const latest = [...(h || [])].sort((x, y) => y.date.localeCompare(x.date));
      const pick = k => latest.find(x => x[k] != null)?.[k] ?? null; let age = null;
      if (p?.birthDate) { const b = new Date(p.birthDate), t = new Date(); age = t.getFullYear() - b.getFullYear() - ((t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) ? 1 : 0); }
      return { age, goalWeight: p?.goalWeight ?? null, bodyFatGoal: p?.bodyFatGoal ?? null, sleepTargetH: p?.sleepTargetH ?? 7.5, targets: p?.targets || null, hrZones: pick('hrZones'), lactateHR: pick('lactateHR'), lactatePaceSec: pick('lactatePaceSec'), vo2max: pick('vo2max'), fitnessAge: pick('fitnessAge'), weight: pick('weight') }; }
    case 'get_goals': return { goals: (await readRepoJson('reviews.json', env)) || [] };
    case 'add_goal': { if (!a.text) throw new Error('text mangler'); const today = isoDate(todayOslo()); const goal = { date: today, period: a.title || today, content: String(a.text), kind: 'coach' };
      await updateRepoJson('reviews.json', env.GITHUB_TOKEN, 'Save review (MCP)', cur => ({ data: [goal, ...cur] })); return { ok: true, goal }; }
    default: throw new Error('Ukjent verktøy: ' + name);
  }
}

async function summarize(env, days) {
  const [h, acts, n, p] = await Promise.all(['health.json', 'activities.json', 'nutrition.json', 'profile.json'].map(f => readRepoJson(f, env)));
  const t = todayOslo(), cur = { from: isoDate(addDays(t, -(days - 1))), to: isoDate(t) }, prev = { from: isoDate(addDays(t, -(2 * days - 1))), to: isoDate(addDays(t, -days)) };
  const period = r => {
    const H = inRange(h, r), A = inRange(acts, r), N = inRange(n, r).filter(x => x.calories > 0);
    const km = ty => +(A.filter(x => x.type === ty && x.distanceM > 1).reduce((s, x) => s + x.distanceM, 0) / 1000).toFixed(1);
    const w = H.filter(x => x.weight != null);
    return { ...r, days: H.length,
      training: { sessions: A.length, runKm: km('running'), bikeKm: km('cycling'), walkKm: km('walking'), hours: +(A.reduce((s, x) => s + (x.durationSec || 0), 0) / 3600).toFixed(1), load: +A.reduce((s, x) => s + (x.load || 0), 0).toFixed(0), acuteLoad: H.length ? H[H.length - 1].acuteLoad ?? null : null, trainingStatus: H.length ? H[H.length - 1].trainingStatus ?? null : null },
      sleep: { score: avg(H, 'sleepScore', 0), hours: H.filter(x => x.sleepSec).length ? +(avg(H.filter(x => x.sleepSec), 'sleepSec', 0) / 3600).toFixed(2) : null, nights: H.filter(x => x.sleepSec).length },
      readiness: avg(H, 'trainingReadiness', 0), rhr: avg(H, 'rhr', 0), hrv: avg(H, 'hrvAvg', 0), stress: avg(H, 'avgStress', 0), steps: avg(H, 'steps', 0),
      nutrition: { daysLogged: N.length, kcal: avg(N, 'calories', 0), protein: avg(N, 'protein', 0), carbs: avg(N, 'carbs', 0), fat: avg(N, 'fat', 0) },
      weight: w.length ? { first: w[0].weight, last: w[w.length - 1].weight, change: +(w[w.length - 1].weight - w[0].weight).toFixed(1), weighIns: w.length } : null };
  };
  return { period: period(cur), previous: period(prev), targets: p?.targets || null, goalWeight: p?.goalWeight ?? null };
}


// ── OAuth 2.1 for the MCP server (claude.ai custom connectors) ─────────────
// claude.ai always runs the OAuth flow for custom connectors, so the Worker is
// its own tiny authorization server. Everything is stateless: client ids,
// codes and tokens are HMAC-signed blobs (key = MCP_KEY), so no storage is
// needed and changing MCP_KEY revokes everything. The login page asks for the
// app password (CAL_KEY). Flow: /.well-known metadata → POST /register →
// GET /authorize (login page) → POST /authorize (302 with code) → POST /token
// → Bearer token on POST /mcp. PKCE S256 is required.
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = str => b64u(new TextEncoder().encode(str));
const unb64u = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}
const signSecret = env => env.MCP_KEY || env.CAL_KEY;
async function sign(env, obj) { const p = b64uStr(JSON.stringify(obj)); return p + '.' + await hmac(signSecret(env), p); }
async function verify(env, tok) {
  const [p, sig] = String(tok || '').split('.'); if (!p || !sig) return null;
  if (!(await sameSecret(sig, await hmac(signSecret(env), p)))) return null;
  try { const o = JSON.parse(unb64u(p)); return o.exp && o.exp < Date.now() / 1000 ? null : o; } catch (e) { return null; }
}
const now = () => Math.floor(Date.now() / 1000);
const ACCESS_TTL = 30 * 86400, REFRESH_TTL = 180 * 86400;
async function issueTokens(env, cid) {
  const n = crypto.randomUUID().slice(0, 8);   // makes every token unique
  return { access_token: await sign(env, { t: 'a', cid, n, exp: now() + ACCESS_TTL }), token_type: 'Bearer', expires_in: ACCESS_TTL,
    refresh_token: await sign(env, { t: 'r', cid, n, exp: now() + REFRESH_TTL }), scope: 'wiggen' };
}
const oauthErr = (error, description, status = 400) => json({ error, error_description: description }, status);

function oauthMetadata(origin) {
  return json({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], scopes_supported: ['wiggen'] });
}
const resourceMetadata = origin => json({ resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['wiggen'], bearer_methods_supported: ['header'] });

async function oauthRegister(request, env) {
  const b = await request.json().catch(() => ({}));
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter(u => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)/.test(u)).slice(0, 10) : [];
  if (!uris.length) return oauthErr('invalid_redirect_uri', 'redirect_uris mangler');
  const client_id = await sign(env, { c: 1, ru: uris, n: String(b.client_name || '').slice(0, 60) });
  return json({ client_id, client_name: b.client_name || null, redirect_uris: uris, token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: now() }, 201);
}

function loginPage(q, msg) {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'].map(k => `<input type="hidden" name="${k}" value="${esc(q.get(k))}">`).join('');
  return new Response(`<!doctype html><html lang="nb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wiggen – koble til</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1ebe0;color:#2c261f;font:15px/1.5 -apple-system,system-ui,sans-serif}
.c{background:#fbf8f1;border:1px solid #e0d6c6;border-radius:16px;padding:28px 26px;width:min(92vw,360px);box-shadow:0 10px 30px rgba(0,0,0,.08)}
h1{font:600 22px Georgia,serif;margin:0 0 6px}p{margin:0 0 16px;color:#6f6354;font-size:13.5px}input[type=password]{width:100%;box-sizing:border-box;font-size:17px;padding:11px 12px;border:1px solid #e0d6c6;border-radius:10px;background:#fff;margin-bottom:12px}
button{width:100%;font-size:15px;font-weight:600;padding:12px;border:0;border-radius:24px;background:#b56a45;color:#fff}.e{color:#b5544a;font-size:13px;margin:-6px 0 12px}
@media(prefers-color-scheme:dark){body{background:#1a1611;color:#ece3d8}.c{background:#221d17;border-color:rgba(255,255,255,.09)}p{color:#b3a596}input[type=password]{background:#2c261e;color:#ece3d8;border-color:rgba(255,255,255,.12)}}</style></head>
<body><form class="c" method="post"><h1>Wiggen</h1><p>Claude ber om tilgang til helse-, trenings- og kalenderdataene dine. Skriv inn app-passordet for å godkjenne.</p>
${msg ? `<div class="e">${esc(msg)}</div>` : ''}${hidden}<input type="password" name="password" placeholder="App-passord" autocomplete="current-password" autofocus required><button type="submit">Gi tilgang</button></form></body></html>`,
    { status: msg ? 401 : 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function oauthAuthorize(request, env) {
  const url = new URL(request.url);
  const q = request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;
  const client = await verify(env, q.get('client_id'));
  const ru = q.get('redirect_uri');
  if (!client || !client.c || !client.ru.includes(ru)) return oauthErr('invalid_client', 'Ukjent client_id eller redirect_uri');
  if (q.get('response_type') !== 'code') return oauthErr('unsupported_response_type', 'response_type må være code');
  if (!q.get('code_challenge') || (q.get('code_challenge_method') || 'S256') !== 'S256') return oauthErr('invalid_request', 'PKCE (S256) kreves');
  if (request.method === 'GET') return loginPage(q, '');
  if (!(await authorized({ key: q.get('password') }, env))) return loginPage(q, 'Feil passord.');
  const code = await sign(env, { t: 'c', cid: q.get('client_id').slice(-24), ru, cc: q.get('code_challenge'), exp: now() + 300 });
  const to = new URL(ru); to.searchParams.set('code', code); if (q.get('state')) to.searchParams.set('state', q.get('state'));
  return new Response(null, { status: 302, headers: { Location: to.toString(), 'Cache-Control': 'no-store' } });
}

async function oauthToken(request, env) {
  const ct = request.headers.get('Content-Type') || '';
  const b = ct.includes('json') ? await request.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await request.text()));
  if (b.grant_type === 'authorization_code') {
    const c = await verify(env, b.code);
    if (!c || c.t !== 'c') return oauthErr('invalid_grant', 'Koden er ugyldig eller utløpt');
    if (b.redirect_uri && b.redirect_uri !== c.ru) return oauthErr('invalid_grant', 'redirect_uri stemmer ikke');
    if (b.client_id && b.client_id.slice(-24) !== c.cid) return oauthErr('invalid_grant', 'client_id stemmer ikke');
    const ver = b.code_verifier || '';
    const want = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ver)));
    if (!ver || !(await sameSecret(want, c.cc))) return oauthErr('invalid_grant', 'PKCE-verifisering feilet');
    return json(await issueTokens(env, c.cid));
  }
  if (b.grant_type === 'refresh_token') {
    const r = await verify(env, b.refresh_token);
    if (!r || r.t !== 'r') return oauthErr('invalid_grant', 'refresh_token er ugyldig eller utløpt');
    return json(await issueTokens(env, r.cid));
  }
  return oauthErr('unsupported_grant_type', 'grant_type må være authorization_code eller refresh_token');
}

async function bearerOk(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  const t = m && await verify(env, m[1]);
  return !!(t && t.t === 'a');
}

async function handleMcp(request, env, key) {
  // Either the secret in the URL (/mcp/<MCP_KEY>) or an OAuth bearer token (/mcp).
  const secret = env.MCP_KEY || env.CAL_KEY;
  const keyOk = !!(secret && key && await sameSecret(key, secret));
  if (!keyOk && !(await bearerOk(request, env))) {
    const origin = new URL(request.url).origin;
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="wiggen", resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
  }
  if (request.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  if (request.method === 'DELETE') return new Response(null, { status: 200 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  let body; try { body = await request.json(); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const one = async m => {
    if (!m || m.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    if (m.id === undefined) return null;                                   // notification: no reply
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
    try {
      switch (m.method) {
        case 'initialize': return ok({ protocolVersion: m.params?.protocolVersion || MCP_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'wiggenapp', version: '1.0' },
          instructions: 'Personlige helse-, trenings-, søvn-, kosthold- og kalenderdata for eieren av WiggenApp. Datoer er YYYY-MM-DD, tider norsk lokaltid. Garmin-begreper (Training Readiness, Sleep Score, Body Battery …) brukes på engelsk; svar ellers på norsk. Start gjerne med get_summary eller get_agenda.' });
        case 'ping': return ok({});
        case 'tools/list': return ok({ tools: MCP_TOOLS });
        case 'tools/call': {
          const name = m.params?.name, args = m.params?.arguments || {};
          if (!MCP_TOOLS.some(t => t.name === name)) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool: ' + name } };
          try { const data = await mcpCall(name, args, env); return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data }); }
          catch (e) { return ok({ content: [{ type: 'text', text: 'Feil: ' + e.message }], isError: true }); }
        }
        case 'resources/list': return ok({ resources: [] });
        case 'prompts/list': return ok({ prompts: [] });
        default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } };
      }
    } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }; }
  };
  const out = Array.isArray(body) ? (await Promise.all(body.map(one))).filter(Boolean) : await one(body);
  if (out === null || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202 });
  return json(out);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url), path = url.pathname;
    try {
      if (path === '/mcp' || path.startsWith('/mcp/')) return await handleMcp(request, env, path === '/mcp' ? '' : decodeURIComponent(path.slice(5).replace(/\/+$/, '')));
      if (path === '/.well-known/oauth-authorization-server' || path.startsWith('/.well-known/oauth-authorization-server/')) return oauthMetadata(url.origin);
      if (path.startsWith('/.well-known/oauth-protected-resource')) return resourceMetadata(url.origin);
      if (path === '/register' && request.method === 'POST') return await oauthRegister(request, env);
      if (path === '/authorize' && (request.method === 'GET' || request.method === 'POST')) return await oauthAuthorize(request, env);
      if (path === '/token' && request.method === 'POST') return await oauthToken(request, env);
    } catch (e) { return json({ error: e.message }, 500); }
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    const routes = { '/nutrition-shortcut': saveNutritionShortcut, '/data': readData, '/save-review': saveGoal, '/delete-review': deleteGoal, '/calendar': handleCalendar, '/agenda': handleAgenda };
    const handler = routes[new URL(request.url).pathname];
    if (!handler) return json({ error: 'Not found' }, 404);
    try {
      return await handler(request, env);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
