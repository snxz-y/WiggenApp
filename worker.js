// Cloudflare Worker — WiggenApp backend
// Handles: / (nutrition), /save-review, /generate-review
// Deploy at: https://nutrition-reciever.margidowiggen.workers.dev

const REPO = 'snxz-y/WiggenApp';
const GH = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com/snxz-y/WiggenApp/main';

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

async function fetchJSON(url) {
  const r = await fetch(url + '?nc=' + Date.now());
  if (!r.ok) return null;
  return r.json();
}

// ── Classify shift type ────────────────────────────────────────────────────
function classifyShift(shift) {
  if (!shift) return 'off';
  return shift.shiftType || 'off';
}

// ── Build a shift-aware weekly review prompt ───────────────────────────────
function buildReviewPrompt(weekStart, weekEnd, health, activities, nutrition, shifts) {
  // weekStart / weekEnd are ISO dates (YYYY-MM-DD). Fall back to a 7-day window.
  let endStr = weekEnd;
  if (!endStr) { const e = new Date(weekStart); e.setDate(e.getDate() + 6); endStr = e.toISOString().slice(0, 10); }

  // Filter data to this period
  const inWeek = d => d >= weekStart && d <= endStr;

  const weekHealth = health.filter(h => inWeek(h.date)).sort((a, b) => a.date.localeCompare(b.date));
  const weekActs = activities.filter(a => inWeek(a.date));
  const weekNutr = nutrition.filter(n => inWeek(n.date));
  const weekShifts = shifts.filter(s => inWeek(s.date));

  // ── formatting helpers ──
  const v = x => (x === null || x === undefined || x === '') ? 'na' : x;
  const r1 = x => (x === null || x === undefined) ? 'na' : Math.round(x * 10) / 10;
  const hm = sec => (sec == null) ? 'na' : `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`;
  const mmss = sec => { if (sec == null) return 'na'; const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; };
  const pace = a => (a.distanceM && a.durationSec) ? mmss(a.durationSec / (a.distanceM / 1000)) + '/km' : 'na';
  const raceFmt = s => { if (s == null) return 'na'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.round(s % 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
  // avg | min–max | first→last delta, with optional transform (e.g. seconds→hours)
  const stat = (key, tf = x => x) => {
    const xs = weekHealth.filter(h => h[key] != null).map(h => tf(h[key]));
    if (!xs.length) return 'na';
    const a = xs.reduce((s, x) => s + x, 0) / xs.length;
    const first = xs[0], last = xs[xs.length - 1], d = last - first;
    const rd = n => Math.round(n * 10) / 10;
    return `avg ${rd(a)} | ${rd(Math.min(...xs))}–${rd(Math.max(...xs))} | ${rd(first)}→${rd(last)} (${d >= 0 ? '+' : ''}${rd(d)})`;
  };
  const nAvg = key => { const xs = weekNutr.filter(n => n[key] != null).map(n => n[key]); return xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 'na'; };
  const daysHit = (key, target, dir = '>=') => { const xs = weekNutr.filter(n => n[key] != null); const hit = xs.filter(n => dir === '>=' ? n[key] >= target : n[key] <= target).length; return `${hit}/${xs.length}`; };
  const latest = key => { const e = [...weekHealth].reverse().find(h => h[key] != null); return e ? e[key] : null; };

  const runs = weekActs.filter(a => a.type === 'running');
  const totalKm = runs.reduce((s, r) => s + (r.distanceM || 0) / 1000, 0).toFixed(1);
  const intervalRuns = runs.filter(r => /interval|tempo|fartlek/i.test(r.name || ''));
  const totalDur = weekActs.reduce((s, a) => s + (a.durationSec || 0), 0);
  const totalLoad = Math.round(weekActs.reduce((s, a) => s + (a.load || 0), 0));
  const totalActCal = Math.round(weekActs.reduce((s, a) => s + (a.calories || 0), 0));
  const typeCounts = {}; weekActs.forEach(a => { typeCounts[a.type] = (typeCounts[a.type] || 0) + 1; });
  const typeBreak = Object.entries(typeCounts).map(([t, c]) => `${t} ${c}`).join(', ') || 'none';
  const zSum = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  weekActs.forEach(a => ['z1', 'z2', 'z3', 'z4', 'z5'].forEach(z => zSum[z] += (a[z] || 0)));
  const zTot = zSum.z1 + zSum.z2 + zSum.z3 + zSum.z4 + zSum.z5;
  const zLine = zTot ? ['z1', 'z2', 'z3', 'z4', 'z5'].map(z => `${z.toUpperCase()} ${hm(zSum[z])} (${Math.round(zSum[z] / zTot * 100)}%)`).join(' | ') : 'na';
  const raceLine = `5k ${raceFmt(latest('race5kSec'))} | 10k ${raceFmt(latest('race10kSec'))} | HM ${raceFmt(latest('raceHalfSec'))} | M ${raceFmt(latest('raceMarathonSec'))}`;
  const firstW = weekHealth.find(h => h.weight)?.weight;
  const lastW = [...weekHealth].reverse().find(h => h.weight)?.weight;
  const firstBF = weekHealth.find(h => h.bodyFat != null)?.bodyFat;
  const lastBF = [...weekHealth].reverse().find(h => h.bodyFat != null)?.bodyFat;

  // Shift summary
  const dayShifts = weekShifts.filter(s => s.shiftType === 'day');
  const eveShifts = weekShifts.filter(s => s.shiftType === 'evening');
  const offDays = weekShifts.filter(s => s.shiftType === 'off');
  const shiftSummary = `Day shifts: ${dayShifts.length} (${dayShifts.map(s => s.date.slice(5)).join(', ') || 'none'})
Evening shifts: ${eveShifts.length} (${eveShifts.map(s => s.date.slice(5)).join(', ') || 'none'})
Days off: ${offDays.length}`;

  // Per-day full-metric log (one wide row per day)
  const dayRows = weekHealth.map(h => {
    const shift = weekShifts.find(s => s.date === h.date);
    const act = weekActs.filter(a => a.date === h.date);
    const nutr = weekNutr.find(n => n.date === h.date);
    const stages = `D${hm(h.deepSec)}/L${hm(h.lightSec)}/R${hm(h.remSec)}/A${hm(h.awakeSec)}`;
    return [
      h.date,
      shift ? `${shift.shiftType} ${shift.start || ''}${shift.end ? '-' + shift.end : ''}`.trim() : 'na',
      `sleep ${v(h.sleepScore)} (${hm(h.sleepSec)}; ${stages}; bed ${v(h.bedTime)}→wake ${v(h.wakeTime)})`,
      `HRV ${v(h.hrvAvg)} (${v(h.hrvStatus)}/5minHigh ${v(h.hrv5minHigh)})`,
      `RHR ${v(h.rhr)} (min ${v(h.minHR)})`,
      `stress ${v(h.avgStress)} (max ${v(h.maxStress)})`,
      `BB ${v(h.bbLow)}→${v(h.bbHigh)} (+${v(h.bbCharged)}/-${v(h.bbDrained)} end ${v(h.bbEnd)})`,
      `steps ${v(h.steps)}/${v(h.stepsGoal)}`,
      `resp ${v(h.avgResp)}`,
      `readiness ${v(h.trainingReadiness)} (${v(h.trainingReadinessLevel)})`,
      `recov ${v(h.recoveryTimeHrs)}h`,
      `load A${v(h.acuteLoad)}/C${v(h.chronicLoad)} acwr ${v(h.acwr)}`,
      `intens mod${v(h.modIntensityMin)}/vig${v(h.vigIntensityMin)}min`,
      `kcal ${v(h.totalKcal)} (act ${v(h.activeKcal)}/bmr ${v(h.bmrKcal)})`,
      act.length ? act.map(a => `${a.type} ${a.distanceM ? (a.distanceM / 1000).toFixed(1) + 'km' : ''} ${pace(a)} HR${v(a.avgHR)} TE:${v(a.label)}`).join(' + ') : 'rest',
      nutr ? `food ${v(nutr.calories)}kcal P${v(nutr.protein)}/C${v(nutr.carbs)}/F${v(nutr.fat)} (fib${v(nutr.fiber)} sug${v(nutr.sugar)} satf${v(nutr.saturatedFat)})` : 'no food log',
    ].join(' | ');
  }).join('\n');

  // Detailed per-activity blocks
  const actDetail = weekActs.map(a => {
    const zt = (a.z1 || 0) + (a.z2 || 0) + (a.z3 || 0) + (a.z4 || 0) + (a.z5 || 0);
    const zpct = zt ? ['z1', 'z2', 'z3', 'z4', 'z5'].map(z => `${z.toUpperCase()} ${Math.round((a[z] || 0) / zt * 100)}%`).join('/') : 'na';
    return `${a.date} "${v(a.name)}" [${a.type}]
  dist ${a.distanceM ? (a.distanceM / 1000).toFixed(2) + 'km' : 'na'} | dur ${hm(a.durationSec)} | pace ${pace(a)} | cal ${v(a.calories)} | elev +${v(a.elevGain)}/-${v(a.elevLoss)}m
  HR avg ${v(a.avgHR)}/max ${v(a.maxHR)} | zones ${zpct}
  power avg ${v(a.avgPower)}/norm ${v(a.normPower)}/max ${v(a.maxPower)}W | cadence ${v(a.cadence)}(max ${v(a.maxCadence)}) spm | stride ${v(a.strideLen)}cm | GCT ${v(a.gct)}ms | vertRatio ${v(a.vertRatio)}%
  training effect ${v(a.label)} | load ${v(a.load)} | vo2max ${v(a.vo2max)} | fastest1k ${mmss(a.fastest1k)} / 5k ${mmss(a.fastest5k)} | BBdrain ${v(a.bodyBatDrain)}`;
  }).join('\n') || 'No activities this week';

  const lastWeight = [...health].filter(h => h.weight).sort((a, b) => b.date.localeCompare(a.date))[0];

  return `ROLE: You are a data compiler preparing a weekly dataset that will be handed to an AI performance coach for analysis. Your ONLY job is to output the dataset below — complete, organized, information-dense, and faithful to the numbers. Do NOT analyze, interpret, advise, conclude, or motivate; the downstream coach does all of that. Keep every data point; lose nothing. Output ONLY the dataset (no preamble, no sign-off).

ATHLETE: Jørgen, 28, shift nurse, Trondheim NO. 171cm, ${r1(lastWeight?.weight) }kg, goal 65kg. Quit Zyn 2026-06-05. Dairy allergy. Garmin Epix Pro Gen 2.
HR ZONES: Z1 104-124 | Z2 125-145 | Z3 146-165 | Z4 166-186 | Z5 187+
TARGETS: 1600 kcal | 150g protein | 145g carbs | 51g fat | steps 10k

WEEK: ${weekStart} to ${endStr}
SHIFTS: ${shiftSummary}

== DAILY LOG (one row per day, all metrics) ==
${dayRows || 'No data available'}

== ACTIVITY DETAIL (per session) ==
${actDetail}

== WEEKLY RECOVERY (avg | min–max | first→last Δ) ==
Sleep score:   ${stat('sleepScore')}
Sleep hours:   ${stat('sleepSec', x => x / 3600)}
Deep sleep h:  ${stat('deepSec', x => x / 3600)}
REM sleep h:   ${stat('remSec', x => x / 3600)}
HRV (avg):     ${stat('hrvAvg')}
RHR:           ${stat('rhr')}
Stress (avg):  ${stat('avgStress')}
Body batt peak:${stat('bbHigh')}
Respiration:   ${stat('avgResp')}
Readiness:     ${stat('trainingReadiness')}
Recovery hrs:  ${stat('recoveryTimeHrs')}
Steps:         ${stat('steps')}

== TRAINING SUMMARY ==
Sessions: ${weekActs.length} (${typeBreak}) | Runs ${runs.length} | Run volume ${totalKm} km | Moving time ${hm(totalDur)} | Active kcal ${totalActCal} | Total load ${totalLoad}
Time in HR zones (all activities): ${zLine}
Interval/tempo: ${intervalRuns.length ? intervalRuns.map(r => `${r.name || 'interval'} ${r.distanceM ? (r.distanceM / 1000).toFixed(1) + 'km' : ''} ${pace(r)}`).join('; ') : 'none'}

== FITNESS & LOAD (latest in week) ==
VO2max ${v(latest('vo2max'))} | Endurance score ${v(latest('enduranceScore'))} | Acute load ${v(latest('acuteLoad'))} | Chronic load ${v(latest('chronicLoad'))} | ACWR ${v(latest('acwr'))} | HRV status ${v(latest('hrvStatus'))} (weekly avg ${v(latest('hrvWeeklyAvg'))})
Race predictions: ${raceLine}

== NUTRITION (avg/day | days target met) ==
Calories: ${nAvg('calories')} kcal (target 1600, ≤target ${daysHit('calories', 1600, '<=')})
Protein:  ${nAvg('protein')} g (target 150, ≥target ${daysHit('protein', 150)})
Carbs:    ${nAvg('carbs')} g (target 145)
Fat:      ${nAvg('fat')} g (target 51)
Fiber:    ${nAvg('fiber')} g | Sugar: ${nAvg('sugar')} g | Sat fat: ${nAvg('saturatedFat')} g | Water: ${nAvg('water')}

== BODY COMP ==
Weight: ${v(firstW)}→${v(lastW)} kg (Δ ${firstW != null && lastW != null ? r1(lastW - firstW) : 'na'}) | gap to goal ${lastW != null ? r1(lastW - 65) : 'na'} kg
Body fat: ${v(firstBF)}→${v(lastBF)}% | Muscle ${v(latest('muscleMass'))} kg | Body water ${v(latest('bodyWater'))}% | BMI ${v(latest('bmi'))}

OUTPUT RULES: Render the dataset above faithfully and in full. Where a value is "na" it means no data — keep it as "na", never estimate. Preserve every metric and every daily row. Align columns where practical for readability. No commentary, no analysis, no headings beyond those given.`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.GITHUB_TOKEN;
    const anthropicKey = env.ANTHROPIC_KEY;

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

    // ── POST /generate-review ─────────────────────────────────────────────
    if (url.pathname === '/generate-review' && request.method === 'POST') {
      try {
        const reqBody = await request.json();
        const start = reqBody.start || reqBody.week; // ISO start date
        const end = reqBody.end;                     // ISO end date (optional)
        if (!start) {
          return new Response(JSON.stringify({ error: 'Missing start date' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // Fetch all data in parallel
        const [health, activities, nutrition, shifts] = await Promise.all([
          fetchJSON(`${RAW}/health.json`),
          fetchJSON(`${RAW}/activities.json`),
          fetchJSON(`${RAW}/nutrition.json`),
          fetchJSON(`${RAW}/shifts.json`),
        ]);

        const prompt = buildReviewPrompt(
          start,
          end,
          health || [],
          activities || [],
          nutrition || [],
          shifts || []
        );

        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 3000,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData = await aiResp.json();
        const reviewText = aiData.content?.[0]?.text || 'Failed to generate review.';

        return new Response(JSON.stringify({ review: reviewText, week: start }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /sync-garmin — trigger GitHub Actions workflow ───────────────────
    if (url.pathname === '/sync-garmin' && request.method === 'POST') {
      try {
        const r = await fetch(`${GH}/repos/${REPO}/actions/workflows/garmin-sync.yml/dispatches`, {
          method: 'POST',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'wt'
          },
          body: JSON.stringify({ ref: 'main' })
        });
        if (r.status === 204) {
          return new Response(JSON.stringify({ ok: true, message: 'Sync triggered — data updates in ~60s' }), {
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        const err = await r.text();
        return new Response(JSON.stringify({ error: err }), { status: r.status, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /debug — echo back the raw request body ─────────────────────
    if (url.pathname === '/debug' && request.method === 'POST') {
      const raw = await request.text();
      return new Response(JSON.stringify({ received: raw }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('Not found', { status: 404, headers: cors });
  }
};
