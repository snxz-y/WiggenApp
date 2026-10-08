// Cloudflare Worker — WiggenApp backend
// Deployed at https://nutrition-reciever.margidowiggen.workers.dev
//
// All personal data lives in the PRIVATE repo DATA_REPO. The app's code repo
// (snxz-y/WiggenApp) is public and must never contain data.
//
// Endpoints (all POST, all require the app password):
//   /nutrition-shortcut  Kosthold: iOS Snarveier «Wiggen kosthold» → nutrition.json
//   /agenda         Dagen: Siri/snarvei «Wiggen dag» → påminnelser inn, «hva skal jeg i dag» ut
//   /data           App: read health/activities/nutrition/reviews        (password)
//   /save-review    Målsetninger: add a goal to reviews.json              (password)
//   /delete-review  Målsetninger: remove a goal from reviews.json         (password)
//   /calendar       Kalender: private overview of the iCal feeds in CAL_FEEDS (password)
//
// Secrets (Cloudflare → Settings → Variables and Secrets):
//   GITHUB_TOKEN  token with read/write access to DATA_REPO
//   CAL_KEY       the app password (one password for data, goals and calendar)
//   CAL_FEEDS     JSON list: [{"name":"Privat","url":"https://...ics","color":"#7c6dfa"}, ...]

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
  const nowOslo = utcToOslo(new Date()), today = new Date(nowOslo); today.setUTCHours(0, 0, 0, 0);
  const todayS = fmtNaive(today, true);
  const sent = parseReminders(body);
  let stored = null;
  if (sent) {
    stored = { updatedAt: new Date().toISOString(), items: sent };
    await updateRepoJson('reminders.json', env.GITHUB_TOKEN, 'Reminders sync (Snarveier)', () => ({ data: stored })).catch(() => {});
  } else {
    stored = await readRepoJson('reminders.json', env).catch(() => null);
  }
  const reminders = (stored?.items || []).map(r => ({ ...r, overdue: !!r.due && r.due.slice(0, 10) < todayS }));
  const { from, days, label } = resolveDay(body.day, today);
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
  return json({ ok: true, day: { from: fmtNaive(from, true), to: fmtNaive(addDays(to, -1), true), label }, message, speech: spoken.join(' '),
    events: cal.events, calendars: cal.calendars, reminders, remindersUpdatedAt: stored?.updatedAt || null, stored: !!sent });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
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
