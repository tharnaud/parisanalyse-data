// Sonde (backtest) : échantillons de matchs déjà joués, pour mesurer après coup la justesse des sources.
// Lecture seule de données publiques. Résultat : data/probe/probe2.json
import fs from 'node:fs';

const H = { headers: { 'User-Agent': 'Probalis/1.0 (lecture seule)', Accept: 'application/json' } };
const out = { at: new Date().toISOString(), probes: {} };
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10).replace(/-/g, '');
const KEEP = /^(id|slug|title|question|groupItemTitle|outcomes|outcomePrices|clobTokenIds|closed|active|umaResolutionStatus|gameStartTime|startTime|startDate|endDate|closedTime|volumeNum|sportsMarketType|line|teams|name|ordering|alias|markets|events|ticker|event_ticker|yes_sub_title|no_sub_title|result|status|settlement_value|settlement_value_dollars|close_time|expected_expiration_time|occurrence_datetime|expiration_time|latest_expiration_time|last_price_dollars|previous_price_dollars|volume_fp|floor_strike|candlesticks|end_period_ts|price|yes_bid|yes_ask|open|close|high|low|mean|mean_dollars|close_dollars|open_dollars|history|t|p|competitions|competitors|homeAway|score|team|displayName|shortDisplayName|odds|details|overUnder|spread|moneyline|current|open|close|home|away|draw|total|over|under|odds|provider|pickcenter|header|type|completed|state|date|[0-9]+)$/;
function slim(o, depth = 0) {
  if (depth > 9) return '…';
  if (Array.isArray(o)) return o.slice(0, 4).map((x) => slim(x, depth + 1));
  if (o && typeof o === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(o)) if (KEEP.test(k)) r[k] = slim(v, depth + 1);
    return r;
  }
  return typeof o === 'string' && o.length > 300 ? o.slice(0, 300) + '…' : o;
}
async function get(name, url) {
  try {
    const r = await fetch(url, H);
    const t = await r.text();
    if (!r.ok) { out.probes[name] = { ok: false, status: r.status, url, body: t.slice(0, 200) }; return null; }
    const d = JSON.parse(t);
    out.probes[name] = { ok: true, url };
    return d;
  } catch (e) { out.probes[name] = { ok: false, url, error: String(e && e.message || e) }; return null; }
}
const note = (name, obj) => { out.probes[name] = Object.assign(out.probes[name] || {}, obj); };

// ---------- Polymarket : événements fermés + historique de prix avant le coup d'envoi
const sports = await get('pm_sports', 'https://gamma-api.polymarket.com/sports');
const seriesOf = (code) => { const s = (sports || []).find((x) => x.sport === code); return s ? String(s.series).split(',')[0] : null; };
for (const code of ['epl', 'nba']) {
  const sid = seriesOf(code);
  if (!sid) continue;
  const evs = await get('pm_closed_' + code, 'https://gamma-api.polymarket.com/events?series_id=' + sid + '&closed=true&limit=100' +
    '&end_date_min=' + encodeURIComponent(iso(NOW - 10 * 864e5)) + '&end_date_max=' + encodeURIComponent(iso(NOW - 864e5)));
  if (!evs || !evs.length) continue;
  const full = evs.filter((e) => (e.markets || []).some((m) => m.sportsMarketType === 'moneyline'));
  note('pm_closed_' + code, { n: evs.length, nWithMoneyline: full.length, sample: slim(full[0] || evs[0]) });
  const ev = full[0];
  if (!ev) continue;
  const m = ev.markets.find((x) => x.sportsMarketType === 'moneyline');
  let tokens = [];
  try { tokens = JSON.parse(m.clobTokenIds || '[]'); } catch { /* */ }
  const start = Date.parse(m.gameStartTime || ev.startTime || '');
  note('pm_closed_' + code, { firstMoneyline: slim(m), start: iso(start) });
  if (tokens[0] && start) {
    const s = Math.floor(start / 1000);
    const ph = await get('pm_hist_' + code, 'https://clob.polymarket.com/prices-history?market=' + tokens[0] + '&startTs=' + (s - 12 * 3600) + '&endTs=' + (s + 4 * 3600) + '&fidelity=60');
    if (ph) note('pm_hist_' + code, { start: iso(start), sample: slim(ph), n: (ph.history || []).length });
    const ph2 = await get('pm_hist2_' + code, 'https://clob.polymarket.com/prices-history?market=' + tokens[0] + '&interval=1w&fidelity=60');
    if (ph2) note('pm_hist2_' + code, { n: (ph2.history || []).length, first: (ph2.history || [])[0], last: (ph2.history || []).slice(-1)[0] });
  }
}

// ---------- Kalshi : marchés réglés + chandeliers horaires
for (const t of ['KXEPLGAME', 'KXNBAGAME', 'KXEPLTOTAL', 'KXEPLSPREAD']) {
  const d = await get('k_settled_' + t, 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=' + t + '&status=settled&limit=50&min_close_ts=' + Math.floor((NOW - 10 * 864e5) / 1000));
  if (!d) continue;
  const ms = d.markets || [];
  note('k_settled_' + t, { n: ms.length, cursor: !!d.cursor, sample: ms.slice(0, 2).map((x) => slim(x)) });
  const m = ms[0];
  if (!m) continue;
  const occ = Date.parse(m.occurrence_datetime || m.expected_expiration_time || m.close_time || '');
  const s = Math.floor(occ / 1000);
  const c = await get('k_candles_' + t, 'https://api.elections.kalshi.com/trade-api/v2/series/' + t + '/markets/' + m.ticker + '/candlesticks?start_ts=' + (s - 18 * 3600) + '&end_ts=' + (s + 3 * 3600) + '&period_interval=60');
  if (c) note('k_candles_' + t, { occ: iso(occ), n: (c.candlesticks || []).length, sample: (c.candlesticks || []).slice(0, 2), last: (c.candlesticks || []).slice(-2) });
  const b = await get('k_batch_' + t, 'https://api.elections.kalshi.com/trade-api/v2/markets/candlesticks?market_tickers=' + m.ticker + '&start_ts=' + (s - 18 * 3600) + '&end_ts=' + (s + 3 * 3600) + '&period_interval=60');
  if (b) note('k_batch_' + t, { keys: Object.keys(b), sample: JSON.stringify(b).slice(0, 600) });
}

// ---------- ESPN : tableaux des jours passés (scores finaux, cotes de clôture ?)
for (const [k, back] of [['soccer/eng.1', 2], ['soccer/esp.1', 2], ['basketball/nba', 1], ['hockey/nhl', 1], ['football/nfl', 5]]) {
  let d = null, used = null;
  for (let i = back; i < back + 5 && !(d && d.events && d.events.length); i++) { used = ymd(NOW - i * 864e5); d = await get('espn_' + k, 'https://site.api.espn.com/apis/site/v2/sports/' + k + '/scoreboard?dates=' + used); }
  if (!d || !d.events || !d.events.length) continue;
  const ev = d.events.find((e) => e.status && e.status.type && e.status.type.completed) || d.events[0];
  const comp = ev.competitions[0];
  note('espn_' + k, { date: used, n: d.events.length, completed: ev.status.type.completed, statusName: ev.status.type.name,
    scores: comp.competitors.map((c) => c.homeAway + ':' + (c.team && c.team.displayName) + '=' + c.score), oddsPresent: !!(comp.odds && comp.odds.length), odds: slim(comp.odds) });
  const sm = await get('espn_summary_' + k, 'https://site.api.espn.com/apis/site/v2/sports/' + k + '/summary?event=' + ev.id);
  if (sm) note('espn_summary_' + k, { pickcenter: slim(sm.pickcenter), odds: slim(sm.odds) });
}

fs.mkdirSync('data/probe', { recursive: true });
fs.writeFileSync('data/probe/probe2.json', JSON.stringify(out, null, 1));
console.log(Object.entries(out.probes).map(([k, v]) => k + ': ' + (v.ok ? 'OK' : 'ERREUR ' + (v.status || v.error))).join('\n'));
