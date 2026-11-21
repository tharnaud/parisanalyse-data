// Sonde : vérifie l'accès aux API publiques depuis GitHub et enregistre des échantillons.
import fs from 'node:fs';
const H = { headers: { 'User-Agent': 'ParisAnalyse/1.0 (lecture seule)', Accept: 'application/json' } };
const out = { at: new Date().toISOString(), probes: {} };
const DROP = /description|image|icon|resolutionSource|clobTokenIds|rules|series_image|featuredImage|umaBond|umaReward|creator|commentCount|tags|markets_preview/i;
const slim = (o) => JSON.parse(JSON.stringify(o, (k, v) => (DROP.test(k) ? undefined : v)));
async function probe(name, url, pick) {
  try {
    const r = await fetch(url, H); const t = await r.text();
    if (!r.ok) { out.probes[name] = { ok: false, status: r.status, body: t.slice(0, 300) }; return null; }
    const d = JSON.parse(t); out.probes[name] = { ok: true, sample: slim(pick ? pick(d) : d) }; return d;
  } catch (e) { out.probes[name] = { ok: false, error: String(e && e.message || e) }; return null; }
}
const first = (a, n) => (Array.isArray(a) ? a.slice(0, n) : a);
const sports = await probe('pm_sports', 'https://gamma-api.polymarket.com/sports', (d) => d);
const pick = (re) => sports && Array.isArray(sports) ? sports.find((s) => re.test(s.sport)) : null;
for (const [name, re] of [['epl', /^epl$/i], ['nba', /^nba$/i], ['nfl', /^nfl$/i], ['atp', /atp/i]]) {
  const s = pick(re);
  if (s) await probe('pm_events_' + name, 'https://gamma-api.polymarket.com/events?series_id=' + String(s.series).split(',')[0] + '&active=true&closed=false&limit=3&order=startDate&ascending=true', (d) => first(d, 2));
}
await probe('pm_events_tag', 'https://gamma-api.polymarket.com/events?tag_slug=soccer&active=true&closed=false&limit=2', (d) => first(d, 1));
const ser = await probe('k_series', 'https://api.elections.kalshi.com/trade-api/v2/series?category=Sports', (d) => ({ n: (d.series || []).length, list: (d.series || []).map((s) => s.ticker + ' | ' + s.title).filter((x) => /GAME|SPREAD|TOTAL|MATCH/i.test(x)) }));
for (const t of ['KXEPLGAME', 'KXEPLSPREAD', 'KXEPLTOTAL', 'KXNBAGAME', 'KXNFLSPREAD', 'KXATPMATCH']) {
  await probe('k_' + t, 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=' + t + '&status=open&limit=3', (d) => first(d.markets, 3));
}
fs.mkdirSync('samples', { recursive: true });
fs.writeFileSync('samples/probe.json', JSON.stringify(out, null, 1));
console.log(Object.entries(out.probes).map(([k, v]) => k + ': ' + (v.ok ? 'OK' : 'ERREUR ' + (v.status || v.error))).join('\n'));
