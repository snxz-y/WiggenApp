// Cloudflare Worker — WiggenApp backend
// Handles: / (nutrition), /save-review, /delete-review
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

    return new Response('Not found', { status: 404, headers: cors });
  }
};
