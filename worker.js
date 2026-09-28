// Cloudflare Worker — WiggenApp backend
// Handles: / (nutrition), /save-review, /delete-review, /calendar
// Secrets: GITHUB_TOKEN; CAL_KEY (calendar password), CAL_FEEDS (JSON list of {name,url,color})
// Deploy at: https://nutrition-reciever.margidowiggen.workers.dev

const REPO = 'snxz-y/WiggenApp';
const GH = 'https://api.github.com';

async function ghGet(path, token) {
  const r = await fetch(`${GH}/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'wt' }
  });
  return r.json();
}

// Decode a base64 blob as UTF-8 (plain atob() is Latin-1 and mangles non-ASCII
// like →, é, etc. — which both breaks matching and re-garbles titles on save).
function b64utf8(b64) {
  const bin = atob((b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function ghPut(path, content, sha, msg, token) {
  const r = await fetch(`${GH}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'wt' },
    body: JSON.stringify({ message: msg, content: btoa(unescape(encodeURIComponent(content))), sha })
  });
  return r.json();
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

async function handleCalendar(request, env, cors) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const body = await request.json().catch(() => ({}));
  if (!env.CAL_KEY || !body.key || !(await sameSecret(body.key, env.CAL_KEY))) return json({ error: 'unauthorized' }, 401);
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
    const url = new URL(request.url);
    const token = env.GITHUB_TOKEN;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ── POST / — save nutrition ────────────────────────────────────────────
    if (url.pathname === '/' && request.method === 'POST') {
      try {
        const body = await request.json();

        // Parse Health Auto Export format: { data: { metrics: [...] } }
        // Each metric has name + data array of { date: "2026-06-15 12:00:00 +0200", qty: N }
        let newEntries;
        if (body?.data?.metrics) {
          const nameMap = {
            'dietary_energy': 'calories',
            'protein': 'protein',
            'carbohydrates': 'carbs',
            'total_fat': 'fat',
            'dietary_sugar': 'sugar',
            'fiber': 'fiber',
            'saturated_fat': 'saturatedFat',
            'water': 'water',
          };
          const dayMap = {};
          for (const metric of body.data.metrics) {
            const field = nameMap[metric.name];
            if (!field) continue;
            // dietary_energy from Apple Health is in kJ — convert to kcal
            const isEnergy = metric.name === 'dietary_energy';
            for (const point of (metric.data || [])) {
              const date = point.date?.slice(0, 10);
              if (!date) continue;
              if (!dayMap[date]) dayMap[date] = { date };
              const qty = isEnergy ? (point.qty || 0) / 4.184 : (point.qty || 0);
              dayMap[date][field] = (dayMap[date][field] || 0) + qty;
            }
          }
          newEntries = Object.values(dayMap).map(entry => {
            const out = { date: entry.date };
            for (const [k, v] of Object.entries(entry)) {
              if (k !== 'date') out[k] = Math.round(v * 10) / 10;
            }
            return out;
          });
        } else {
          // Legacy format: array or single object with date field
          newEntries = Array.isArray(body) ? body : [body];
        }

        const existing = await ghGet('nutrition.json', token);
        const current = JSON.parse(atob(existing.content));
        const byDate = {};
        current.forEach(e => byDate[e.date] = e);
        newEntries.forEach(e => { if (e.date) byDate[e.date] = { ...byDate[e.date], ...e }; });
        const merged = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));

        const putResult = await ghPut('nutrition.json', JSON.stringify(merged, null, 2), existing.sha, 'Nutrition sync', token);
        if (putResult.content || putResult.commit) {
          return new Response(JSON.stringify({ ok: true, dates: newEntries.map(e => e.date) }), { headers: { ...cors, 'Content-Type': 'application/json' } });
        } else {
          return new Response(JSON.stringify({ error: 'GitHub write failed', detail: putResult.message || JSON.stringify(putResult) }), { status: 500, headers: cors });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /save-review ─────────────────────────────────────────────────
    if (url.pathname === '/save-review' && request.method === 'POST') {
      try {
        const body = await request.json();
        const existing = await ghGet('reviews.json', token);
        const current = JSON.parse(b64utf8(existing.content));
        current.unshift(body);
        await ghPut('reviews.json', JSON.stringify(current, null, 2), existing.sha, 'Save review', token);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /delete-review ───────────────────────────────────────────────
    if (url.pathname === '/delete-review' && request.method === 'POST') {
      try {
        const { date, period, content } = await request.json();
        const existing = await ghGet('reviews.json', token);
        const current = JSON.parse(b64utf8(existing.content));
        // Remove only the first entry that matches exactly (handles duplicates).
        const idx = current.findIndex(r => r.date === date && r.period === period && r.content === content);
        if (idx === -1) {
          return new Response(JSON.stringify({ ok: false, error: 'Review not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        current.splice(idx, 1);
        await ghPut('reviews.json', JSON.stringify(current, null, 2), existing.sha, 'Delete review', token);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /calendar — private calendar overview ─────────────────────────
    if (url.pathname === '/calendar' && request.method === 'POST') {
      return handleCalendar(request, env, cors);
    }

    return new Response('Not found', { status: 404, headers: cors });
  }
};
