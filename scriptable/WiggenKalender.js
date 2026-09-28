// WiggenApp – Kalender-widget for Scriptable (iPhone/iPad)
//
// Viser de neste avtalene i listevisning, i samme stil som Kalender-fanen i
// WiggenApp. Tilpasser seg størrelsen: liten, middels og stor.
// Trykk på widgeten åpner WiggenApp på Kalender-fanen.
//
// Oppsett:
//  1. Installer «Scriptable» fra App Store.
//  2. Opprett et nytt script, lim inn hele denne fila, kall det «WiggenKalender».
//  3. Trykk ▶ én gang og skriv inn kalenderpassordet (CAL_KEY).
//     Passordet lagres i iPhonens nøkkelring, ikke i scriptet.
//  4. Legg til en Scriptable-widget på hjemskjermen, hold inne → Rediger widget
//     → Script: WiggenKalender.
// Kjør scriptet igjen i Scriptable for å bytte passord eller se forhåndsvisning.

// ── Innstillinger ───────────────────────────────────────────────────────────
const WORKER_URL = 'https://nutrition-reciever.margidowiggen.workers.dev/calendar';
const APP_URL = 'https://snxz-y.github.io/WiggenApp/#kalender';
const HIDE_CALENDARS = [];        // f.eks. ['Helligdager'] for å skjule en kalender i widgeten
const DAYS_AHEAD = 8;
const KEY_NAME = 'wiggenapp_cal_key';

// App-fargene (lys / mørk)
const C = {
  bg:     Color.dynamic(new Color('#f1ebe0'), new Color('#1a1611')),
  card:   Color.dynamic(new Color('#fbf8f1'), new Color('#221d17')),
  text:   Color.dynamic(new Color('#2c261f'), new Color('#ece3d8')),
  muted:  Color.dynamic(new Color('#8a7d6d'), new Color('#9b8d7d')),
  muted2: Color.dynamic(new Color('#6f6354'), new Color('#b3a596')),
  accent: Color.dynamic(new Color('#b56a45'), new Color('#d49a76')),
};
const PALETTE = ['#b56a45', '#7c6dfa', '#5f8c6a', '#a9802a', '#4a9fb0', '#b5544a', '#9c7b50'];

// ── Hjelpere ────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const nowLocal = () => { const d = new Date(); return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const calColor = (data, i) => {
  const c = data.calendars[i] && data.calendars[i].color;
  return new Color(c && /^#[0-9a-f]{6}$/i.test(c) ? c : PALETTE[i % PALETTE.length]);
};

// "I dag · mandag 28. september" / "I morgen · …" / "Onsdag 30. september".
// short=true (liten widget): "I dag" / "I morgen" / "Onsdag".
function dayHeader(ds, todayS, short) {
  const df = new DateFormatter();
  df.locale = 'nb_NO';
  df.dateFormat = short ? 'EEEE' : 'EEEE d. MMMM';
  const s = df.string(new Date(ds + 'T12:00:00'));
  const tomorrowS = iso(addDays(new Date(todayS + 'T12:00:00'), 1));
  const prefix = ds === todayS ? 'I dag' : ds === tomorrowS ? 'I morgen' : null;
  if (prefix) return short ? prefix : `${prefix} · ${s}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function timeLabel(e, ds) {
  if (e.allDay) return 'Hele dagen';
  const sOn = e.start.slice(0, 10) === ds, eOn = e.end.slice(0, 10) === ds;
  if (sOn && eOn) return `${e.start.slice(11)}–${e.end.slice(11)}`;
  if (sOn) return `${e.start.slice(11)} →`;
  if (eOn) return `→ ${e.end.slice(11)}`;
  return 'Hele dagen';
}

// Days → events, like the app's list view. Today hides events that already ended.
function buildDays(data) {
  const hidden = new Set(data.calendars.map((c, i) => HIDE_CALENDARS.includes(c.name) ? i : -1));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayS = iso(today), now = nowLocal(), days = [];
  for (let k = 0; k < DAYS_AHEAD; k++) {
    const ds = iso(addDays(today, k)), ns = iso(addDays(today, k + 1));
    const list = data.events
      .filter(e => !hidden.has(e.cal))
      .filter(e => e.allDay ? (e.start <= ds && e.end > ds) : (e.start < ns + 'T00:00' && e.end > ds + 'T00:00'))
      .filter(e => ds !== todayS || e.allDay || e.end > now)
      .sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    days.push({ ds, list });
  }
  return { days, todayS };
}

// ── Data (med lokal kopi når nettet er borte) ───────────────────────────────
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), 'wiggen_kalender_cache.json');

async function fetchCalendar(key) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const req = new Request(WORKER_URL);
  req.method = 'POST';
  req.timeoutInterval = 20;
  req.headers = { 'Content-Type': 'application/json' };
  req.body = JSON.stringify({ key, from: iso(today), to: iso(addDays(today, DAYS_AHEAD)) });
  const data = await req.loadJSON();
  const status = req.response && req.response.statusCode;
  if (status === 401) throw new Error('Feil passord');
  if (status && status >= 400) throw new Error('HTTP ' + status);
  data.fetchedAt = Date.now();
  fm.writeString(cachePath, JSON.stringify(data));
  return data;
}
function cached() {
  try { return fm.fileExists(cachePath) ? JSON.parse(fm.readString(cachePath)) : null; } catch (e) { return null; }
}

// ── Widget ──────────────────────────────────────────────────────────────────
const SIZES = {                      // lines = hvor mange linjer (overskrifter + avtaler) som får plass
  small:      { lines: 5,  pad: 12, title: 12, row: 11, sub: false, time: 44 },
  medium:     { lines: 6,  pad: 14, title: 13, row: 12, sub: false, time: 78 },
  large:      { lines: 15, pad: 16, title: 13, row: 12, sub: true,  time: 78 },
  extraLarge: { lines: 13, pad: 18, title: 14, row: 13, sub: true,  time: 84 },
};

function message(w, s, text) {
  w.addSpacer();
  const t = w.addText(text);
  t.font = Font.mediumSystemFont(s.row);
  t.textColor = C.muted;
  t.centerAlignText();
  w.addSpacer();
}

function header(w, s, family) {
  const h = w.addStack();
  h.layoutHorizontally();
  h.centerAlignContent();
  const t = h.addText(family === 'small' ? 'Kalender' : 'Wiggen / Kalender');
  t.font = new Font('Georgia-Bold', s.title + 2);
  t.textColor = C.text;
  h.addSpacer();
  const d = h.addText(new Date().getDate().toString());
  d.font = Font.boldRoundedSystemFont(s.title);
  d.textColor = C.accent;
  w.addSpacer(family === 'small' ? 6 : 8);
}

function eventRow(w, s, data, e, ds, family) {
  const r = w.addStack();
  r.layoutHorizontally();
  r.centerAlignContent();
  r.spacing = 6;
  const bar = r.addStack();
  bar.size = new Size(3, s.sub ? 26 : 16);
  bar.cornerRadius = 1.5;
  bar.backgroundColor = calColor(data, e.cal);

  if (family === 'small') {
    const col = r.addStack();
    col.layoutVertically();
    const tm = col.addText(e.allDay ? 'Hele dagen' : timeLabel(e, ds).split('–')[0]);
    tm.font = Font.mediumSystemFont(s.row - 2);
    tm.textColor = C.muted2;
    const ti = col.addText(e.title);
    ti.font = Font.semiboldSystemFont(s.row);
    ti.textColor = C.text;
    ti.lineLimit = 1;
    return;
  }
  const tb = r.addStack();
  tb.size = new Size(s.time, 0);
  const tm = tb.addText(timeLabel(e, ds));
  tm.font = Font.mediumSystemFont(s.row - 1);
  tm.textColor = C.muted2;
  tm.lineLimit = 1;
  tm.minimumScaleFactor = 0.8;
  tb.addSpacer();

  const col = r.addStack();
  col.layoutVertically();
  const ti = col.addText(e.title);
  ti.font = Font.semiboldSystemFont(s.row);
  ti.textColor = C.text;
  ti.lineLimit = 1;
  if (s.sub) {
    const cal = data.calendars[e.cal] || {};
    const st = col.addText([cal.name, e.location].filter(Boolean).join(' · '));
    st.font = Font.systemFont(s.row - 2);
    st.textColor = C.muted;
    st.lineLimit = 1;
  }
}

function dayTitle(w, s, text, isToday) {
  const t = w.addText(text);
  t.font = Font.semiboldSystemFont(s.row - 1);
  t.textColor = isToday ? C.accent : C.muted2;
  t.lineLimit = 1;
  w.addSpacer(3);
}

function build(data, family, note) {
  const s = SIZES[family] || SIZES.large;
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(s.pad, s.pad, s.pad, s.pad);
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  header(w, s, family);

  if (!data) { message(w, s, note || 'Ingen data'); return w; }

  const { days, todayS } = buildDays(data);
  const small = family === 'small', rowCost = s.sub ? 1.4 : 1;
  let lines = s.lines, shown = 0;
  for (const { ds, list } of days) {
    const isToday = ds === todayS;
    if (!list.length && !isToday) continue;        // skip empty future days
    if (lines < 1 + (list.length ? rowCost : 1)) break;
    dayTitle(w, s, dayHeader(ds, todayS, small), isToday);
    lines -= 1;
    if (!list.length) {
      const t = w.addText('Ingen flere avtaler');
      t.font = Font.systemFont(s.row - 1);
      t.textColor = C.muted;
      w.addSpacer(6);
      lines -= 1;
      continue;
    }
    for (const e of list) {
      if (lines < rowCost) break;
      eventRow(w, s, data, e, ds, family);
      w.addSpacer(s.sub ? 5 : 4);
      lines -= rowCost;
      shown++;
    }
    w.addSpacer(4);
  }
  if (!shown) message(w, s, 'Ingen avtaler de neste dagene');
  w.addSpacer();
  if (note) {
    const n = w.addText(note);
    n.font = Font.systemFont(9);
    n.textColor = C.muted;
    n.lineLimit = 1;
  }
  return w;
}

// ── Kjøring ─────────────────────────────────────────────────────────────────
async function askForKey() {
  const a = new Alert();
  a.title = 'Kalenderpassord';
  a.message = 'Skriv inn passordet du la inn som CAL_KEY i Cloudflare.';
  a.addSecureTextField('Passord', '');
  a.addAction('Lagre');
  a.addCancelAction('Avbryt');
  if (await a.present() === -1) return null;
  const v = a.textFieldValue(0).trim();
  if (v) Keychain.set(KEY_NAME, v);
  return v || null;
}

async function main() {
  const family = config.widgetFamily || 'large';
  let key = Keychain.contains(KEY_NAME) ? Keychain.get(KEY_NAME) : null;

  if (config.runsInApp) {
    const menu = new Alert();
    menu.title = 'WiggenKalender';
    menu.addAction('Forhåndsvis stor');
    menu.addAction('Forhåndsvis middels');
    menu.addAction('Forhåndsvis liten');
    menu.addAction(key ? 'Bytt passord' : 'Legg inn passord');
    menu.addCancelAction('Lukk');
    const choice = await menu.present();
    if (choice === -1) return;
    if (choice === 3 || !key) { key = await askForKey(); if (!key) return; }
    const fam = ['large', 'medium', 'small', 'large'][choice];
    const w = await widgetFor(key, fam);
    if (fam === 'small') await w.presentSmall();
    else if (fam === 'medium') await w.presentMedium();
    else await w.presentLarge();
    return;
  }
  Script.setWidget(await widgetFor(key, family));
}

async function widgetFor(key, family) {
  if (!key) return build(null, family, 'Åpne Scriptable og kjør WiggenKalender for å legge inn passordet');
  try {
    return build(await fetchCalendar(key), family);
  } catch (e) {
    const old = cached();
    if (e.message === 'Feil passord') return build(null, family, 'Feil passord – kjør WiggenKalender i Scriptable');
    if (old) {
      const t = new Date(old.fetchedAt);
      return build(old, family, `Frakoblet · sist oppdatert ${pad(t.getHours())}:${pad(t.getMinutes())}`);
    }
    return build(null, family, 'Kunne ikke hente kalenderen');
  }
}

await main();
Script.complete();
