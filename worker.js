// Cloudflare Worker — WiggenApp backend
// Deployed at https://nutrition-reciever.margidowiggen.workers.dev
//
// All personal data lives in the PRIVATE repo DATA_REPO. The app's code repo
// (snxz-y/WiggenApp) is public and must never contain data.
//
// Endpoints (all POST):
//   /               Kosthold: Health Auto Export → nutrition.json (write-only, no password)
//   /nutrition-shortcut  Kosthold: iOS Snarveier → nutrition.json (password)
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
const DATA_FILES = ['health.json', 'activities.json', 'nutrition.json', 'reviews.json'];
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
  for (let attempt = 0; attempt < 3; attempt++) {
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

// ── Kosthold (Health Auto Export) ──────────────────────────────────────────
// HAE sends { data: { metrics: [{ name, data: [{ date: "2026-06-15 12:00:00 +0200", qty }] }] } }.
// Values are summed per day. Older senders posted plain {date, ...} objects.
const NUTRITION_FIELDS = {
  dietary_energy: 'calories', protein: 'protein', carbohydrates: 'carbs', total_fat: 'fat',
  dietary_sugar: 'sugar', fiber: 'fiber', saturated_fat: 'saturatedFat', water: 'water',
};

function nutritionEntries(body) {
  if (!body?.data?.metrics) return (Array.isArray(body) ? body : [body]).filter(e => e && e.date);
  const days = {};
  for (const metric of body.data.metrics) {
    const field = NUTRITION_FIELDS[metric.name];
    if (!field) continue;
    const kJ = metric.name === 'dietary_energy';            // Apple Health energy is kJ → kcal
    for (const point of metric.data || []) {
      const date = point.date?.slice(0, 10);
      if (!date) continue;
      days[date] ||= { date };
      days[date][field] = (days[date][field] || 0) + (kJ ? (point.qty || 0) / 4.184 : (point.qty || 0));
    }
  }
  return Object.values(days).map(({ date, ...v }) =>
    ({ date, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Math.round(x * 10) / 10])) }));
}

async function saveNutrition(request, env) {
  const entries = nutritionEntries(await request.json());
  if (!entries.length) return json({ ok: true, dates: [] });
  await updateRepoJson('nutrition.json', env.GITHUB_TOKEN, 'Nutrition sync', current => {
    const byDate = Object.fromEntries(current.map(e => [e.date, e]));
    for (const e of entries) byDate[e.date] = { ...byDate[e.date], ...e };
    return { data: Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)) };
  });
  return json({ ok: true, dates: entries.map(e => e.date) });
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
  await updateRepoJson('nutrition_debug.json', env.GITHUB_TOKEN, 'Nutrition shortcut payload', () =>
    ({ data: { receivedAt: new Date().toISOString(), parsed: entries, skipped, raw } })).catch(() => {});
  if (entries.length) {
    await updateRepoJson('nutrition.json', env.GITHUB_TOKEN, 'Nutrition sync (Snarveier)', current => {
      const byDate = Object.fromEntries(current.map(e => [e.date, e]));
      for (const e of entries) byDate[e.date] = { ...byDate[e.date], ...e };
      return { data: Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)) };
    });
  }
  const sum = entries.map(e => `${e.date.slice(8)}/${e.date.slice(5, 7)}: ${e.calories != null ? Math.round(e.calories) + ' kcal' : '–'}`).join(', ');
  return json({ ok: true, days: entries.length, message: entries.length ? `Lagret ${entries.length} dager – ${sum}` : 'Fant ingen data å lagre', skipped });
}

// ── Password check (shared by /data, goals and /calendar) ─────────────────
async function authorized(body, env) {
  return !!(env.CAL_KEY && body && body.key && await sameSecret(body.key, env.CAL_KEY));
}

// ── App data (private repo → app) ──────────────────────────────────────────
// POST /data {key} → {files: {"health.json": [...], ...}}
async function readData(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  const files = {};
  await Promise.all(DATA_FILES.map(async f => {
    const r = await gh(f, env.GITHUB_TOKEN);
    if (r.status === 404) { files[f] = []; return; }
    if (!r.ok) throw new Error(`GitHub read ${f}: HTTP ${r.status}`);
    const meta = await r.json();
    // Files over 1 MB come back without inline content; fetch the blob instead.
    const content = meta.content || (await (await fetch(meta.git_url, { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, 'User-Agent': 'wiggenapp-worker' } })).json()).content;
    files[f] = JSON.parse(b64decode(content));
  }));
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

async function handleCalendar(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!(await authorized(body, env))) return json({ error: 'unauthorized' }, 401);
  let feeds;
  try { feeds = JSON.parse(env.CAL_FEEDS || '[]'); } catch (e) { return json({ error: 'CAL_FEEDS er ikke gyldig JSON' }, 500); }
  const isoDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(s + 'T00:00:00Z') : null;
  const now = utcToOslo(new Date()); now.setUTCHours(0, 0, 0, 0);
  const from = isoDay(body.from) || new Date(now.getTime() - 7 * DAY);
  let to = isoDay(body.to) || new Date(now.getTime() + 60 * DAY);
  if (to - from > 400 * DAY) to = new Date(from.getTime() + 400 * DAY);
  const cals = await Promise.all(feeds.map(async f => {
    try {
      const r = await fetch(String(f.url).replace(/^webcal:/i, 'https:'), { cf: { cacheTtl: 600, cacheEverything: true } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { name: f.name, color: f.color || null, events: eventsInRange(await r.text(), from, to) };
    } catch (e) {
      return { name: f.name, color: f.color || null, error: e.message, events: [] };
    }
  }));
  return json({
    from: fmtNaive(from, true), to: fmtNaive(to, true),
    calendars: cals.map(c => ({ name: c.name, color: c.color, error: c.error || null })),
    events: cals.flatMap((c, i) => c.events.map(e => ({ ...e, cal: i }))),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    const routes = { '/': saveNutrition, '/nutrition-shortcut': saveNutritionShortcut, '/data': readData, '/save-review': saveGoal, '/delete-review': deleteGoal, '/calendar': handleCalendar };
    const handler = routes[new URL(request.url).pathname];
    if (!handler) return json({ error: 'Not found' }, 404);
    try {
      return await handler(request, env);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
