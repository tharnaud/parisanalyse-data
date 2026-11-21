// Probalis — backtest, collecte brute : pour les matchs déjà joués, enregistre ce que chaque source
// affichait avant le coup d'envoi (heure par heure) et le résultat. L'analyse se fait hors de GitHub.
// Lecture seule de données publiques. Sortie : data/backtest/<ligue>.json + summary.json
import fs from 'node:fs';

const DAYS = Number(process.env.BT_DAYS) || 35;
const END = Date.now() - 5 * 3600e3;
const START = END - DAYS * 864e5;
const H = { headers: { 'User-Agent': 'Probalis/1.0 (lecture seule)', Accept: 'application/json' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10).replace(/-/g, '');
const num = (x) => { const n = typeof x === 'string' ? parseFloat(x) : x; return Number.isFinite(n) ? n : null; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const stats = { requests: {}, errors: {}, t0: Date.now() };

function limiter(n, gapMs) {
  let active = 0, last = 0; const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    const wait = Math.max(0, last + gapMs - Date.now()); last = Date.now() + wait;
    setTimeout(() => fn().then(res, rej).finally(() => { active--; next(); }), wait);
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const LIM = { espn: limiter(6, 40), gamma: limiter(3, 120), clob: limiter(6, 60), kalshi: limiter(4, 80) };
async function getJSON(site, url, tries = 4) {
  return LIM[site](async () => {
    for (let i = 0; i < tries; i++) {
      stats.requests[site] = (stats.requests[site] || 0) + 1;
      try {
        const r = await fetch(url, H);
        if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
        if (!r.ok) { stats.errors[site + ' ' + r.status] = (stats.errors[site + ' ' + r.status] || 0) + 1; return null; }
        return await r.json();
      } catch (e) { await sleep(800 * (i + 1)); }
    }
    stats.errors[site + ' échec'] = (stats.errors[site + ' échec'] || 0) + 1;
    return null;
  });
}

const LEAGUES = [
  ['soccer', 'eng.1', 'epl', 'KXEPL'], ['soccer', 'esp.1', 'lal', 'KXLALIGA'], ['soccer', 'ita.1', 'sea', 'KXSERIEA'],
  ['soccer', 'ger.1', 'bun', 'KXBUNDESLIGA'], ['soccer', 'fra.1', 'fl1', 'KXLIGUE1'], ['soccer', 'uefa.champions', 'ucl', 'KXUCL'],
  ['soccer', 'uefa.europa', 'uel', 'KXUEL'], ['basketball', 'nba', 'nba', 'KXNBA'], ['hockey', 'nhl', 'nhl', 'KXNHL'], ['football', 'nfl', 'nfl', 'KXNFL']
];

// ---------- ESPN : matchs terminés, score final, cotes DraftKings d'ouverture et de clôture
async function espnEvents(sport, lg) {
  const found = new Map();
  const days = [];
  for (let t = START - 864e5; t <= END + 864e5; t += 864e5) days.push(ymd(t));
  await Promise.all(days.map(async (d) => {
    const sb = await getJSON('espn', 'https://site.api.espn.com/apis/site/v2/sports/' + sport + '/' + lg + '/scoreboard?dates=' + d);
    for (const ev of (sb && sb.events) || []) {
      const st = ev.status && ev.status.type, t = Date.parse(ev.date);
      if (st && st.completed && st.state === 'post' && t >= START && t <= END) found.set(String(ev.id), ev);
    }
  }));
  const out = [];
  await Promise.all([...found.values()].map(async (ev) => {
    const sm = await getJSON('espn', 'https://site.api.espn.com/apis/site/v2/sports/' + sport + '/' + lg + '/summary?event=' + ev.id);
    const pc = (sm && sm.pickcenter) || [];
    const dk = pc.find((p) => p.provider && /draftkings/i.test(p.provider.name || '')) || null;
    const c = ev.competitions[0];
    out.push({ id: String(ev.id), date: ev.date, status: { type: ev.status.type }, competitions: [{
      competitors: c.competitors.map((x) => ({ homeAway: x.homeAway, score: x.score,
        team: { id: x.team.id, displayName: x.team.displayName, shortDisplayName: x.team.shortDisplayName, abbreviation: x.team.abbreviation } })),
      odds: dk ? [{ provider: { name: 'DraftKings' }, moneyline: dk.moneyline, pointSpread: dk.pointSpread, total: dk.total }] : [] }] });
  }));
  return out;
}

// ---------- Polymarket : matchs fermés, prix horaires sur les 12 h avant le coup d'envoi
const pmTime = (s) => Date.parse(String(s || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
const FULL = new Set(['moneyline', 'spreads', 'totals', 'both_teams_to_score']);
async function pmGames(sports, code) {
  const s = sports.find((x) => x.sport === code);
  if (!s) return [];
  const sid = String(s.series).split(',')[0];
  const evs = [];
  for (let off = 0; off < 3000; off += 500) {
    const d = await getJSON('gamma', 'https://gamma-api.polymarket.com/events?series_id=' + sid + '&closed=true&limit=500&offset=' + off +
      '&end_date_min=' + encodeURIComponent(iso(START - 864e5)) + '&end_date_max=' + encodeURIComponent(iso(END + 3 * 864e5)));
    if (!d || !d.length) break;
    evs.push(...d);
    if (d.length < 500) break;
  }
  const games = new Map();
  for (const ev of evs) {
    const ms = (ev.markets || []).filter((m) => FULL.has(m.sportsMarketType));
    const ml = ms.filter((m) => m.sportsMarketType === 'moneyline');
    if (!ml.length) continue;
    const start = pmTime(ml[0].gameStartTime) || Date.parse(ev.startTime || '');
    if (!(start >= START && start <= END)) continue;
    const key = (/^(.*?-\d{4}-\d{2}-\d{2})/.exec(ev.slug || '') || [])[1] || ev.slug;
    if (!games.has(key)) games.set(key, { id: key, start: iso(start), title: ev.title || '', teams: (ev.teams || []).map((t) => ({ name: t.name, alias: t.alias || '', ordering: t.ordering || '' })), markets: [] });
    const g = games.get(key);
    const top = (type) => ms.filter((m) => m.sportsMarketType === type).sort((a, b) => (num(b.volumeNum) || 0) - (num(a.volumeNum) || 0)).slice(0, 2);
    for (const m of [...ml, ...top('spreads'), ...top('totals'), ...top('both_teams_to_score')]) {
      let tok = [], oc = [];
      try { tok = JSON.parse(m.clobTokenIds || '[]'); oc = JSON.parse(m.outcomes || '[]'); } catch { continue; }
      if (tok.length !== 2 || oc.length !== 2) continue;
      g.markets.push({ type: m.sportsMarketType, title: m.groupItemTitle || m.question || '', outcomes: oc, line: num(m.line), vol: Math.round(num(m.volumeNum) || 0), token: tok[0], series: [] });
    }
  }
  await Promise.all([...games.values()].flatMap((g) => g.markets.map(async (m) => {
    const s = Math.floor(Date.parse(g.start) / 1000);
    const d = await getJSON('clob', 'https://clob.polymarket.com/prices-history?market=' + m.token + '&startTs=' + (s - 12 * 3600) + '&endTs=' + (s + 600) + '&fidelity=60');
    m.series = ((d && d.history) || []).map((x) => [x.t, r3(num(x.p))]).filter((x) => x[1] !== null);
    delete m.token;
  })));
  return [...games.values()];
}

// ---------- Kalshi : marchés réglés, prix horaires sur la journée du match
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
async function kMarkets(ticker) {
  const all = []; let cursor = '';
  for (let page = 0; page < 20; page++) {
    const d = await getJSON('kalshi', 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=' + ticker + '&status=settled&limit=1000' +
      '&min_close_ts=' + Math.floor(START / 1000) + '&max_close_ts=' + Math.floor((END + 3 * 864e5) / 1000) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (!d) break;
    all.push(...(d.markets || []));
    cursor = d.cursor; if (!cursor || !(d.markets || []).length) break;
  }
  return all;
}
async function kGames(prefix) {
  const events = new Map();
  for (const type of ['GAME', 'SPREAD', 'TOTAL']) {
    for (const m of await kMarkets(prefix + type)) {
      const suffix = (m.event_ticker || '').split('-').slice(1).join('-');
      const dm = /^(\d{2})([A-Z]{3})(\d{2})/.exec(suffix);
      if (!dm) continue;
      const day = Date.UTC(2000 + +dm[1], MONTHS[dm[2]], +dm[3]);
      if (day < START - 864e5 || day > END + 864e5) continue;
      if (!events.has(suffix)) events.set(suffix, { id: suffix, date: iso(day).slice(0, 10), markets: [] });
      events.get(suffix).markets.push({ type, ticker: m.ticker, sub: m.yes_sub_title || '', title: m.title || '', strike: num(m.floor_strike), vol: Math.round(num(m.volume_fp) || 0), result: m.result || '', series: [] });
    }
  }
  // garde victoire/nul + les deux handicaps et deux totaux les plus échangés, puis prix horaires de 6 h à 36 h UTC le jour du match
  await Promise.all([...events.values()].map(async (ev) => {
    const top = (type) => ev.markets.filter((x) => x.type === type).sort((a, b) => b.vol - a.vol).slice(0, 2);
    ev.markets = [...ev.markets.filter((x) => x.type === 'GAME'), ...top('SPREAD'), ...top('TOTAL')];
    if (!ev.markets.length) return;
    const day = Math.floor(Date.parse(ev.date + 'T00:00:00Z') / 1000);
    const d = await getJSON('kalshi', 'https://api.elections.kalshi.com/trade-api/v2/markets/candlesticks?market_tickers=' + ev.markets.map((x) => x.ticker).join(',') +
      '&start_ts=' + (day + 6 * 3600) + '&end_ts=' + (day + 36 * 3600) + '&period_interval=60');
    const list = (d && d.markets) || [];
    ev.markets.forEach((x, i) => {
      const mk = list.find((y) => (y.market_ticker || y.ticker) === x.ticker) || list[i];
      x.series = ((mk && mk.candlesticks) || []).map((c) => {
        const bid = num(c.yes_bid && c.yes_bid.close_dollars), ask = num(c.yes_ask && c.yes_ask.close_dollars), last = num(c.price && c.price.close_dollars);
        const p = bid !== null && ask !== null && ask > 0 && ask - bid <= 0.1 ? (bid + ask) / 2 : (last !== null && last > 0 && last < 1 ? last : null);
        return [c.end_period_ts, p === null ? null : r3(p)];
      }).filter((y) => y[1] !== null);
    });
  }));
  return [...events.values()];
}

const sports = (await getJSON('gamma', 'https://gamma-api.polymarket.com/sports')) || [];
const ONLY = (process.env.BT_LEAGUES || '').split(',').filter(Boolean);
const summary = { generatedAt: null, from: iso(START), to: iso(END), days: DAYS, leagues: {} };
fs.mkdirSync('data/backtest', { recursive: true });
for (const [sport, lg, pmCode, kPrefix] of LEAGUES.filter((x) => !ONLY.length || ONLY.includes(x[1]))) {
  const t0 = Date.now();
  const [espn, pm, kalshi] = await Promise.all([espnEvents(sport, lg), pmGames(sports, pmCode), kGames(kPrefix)]);
  fs.writeFileSync('data/backtest/' + lg + '.json', JSON.stringify({ sport, league: lg, from: iso(START), to: iso(END), espn, pm, kalshi }));
  summary.leagues[lg] = { espn: espn.length, espnWithDK: espn.filter((e) => e.competitions[0].odds.length).length, pm: pm.length, kalshi: kalshi.length, seconds: Math.round((Date.now() - t0) / 1000) };
  console.log(lg, JSON.stringify(summary.leagues[lg]));
}
summary.generatedAt = iso(Date.now());
summary.requests = stats.requests; summary.errors = stats.errors; summary.seconds = Math.round((Date.now() - stats.t0) / 1000);
fs.writeFileSync('data/backtest/summary.json', JSON.stringify(summary, null, 1));
console.log('requêtes :', JSON.stringify(stats.requests), '| erreurs :', JSON.stringify(stats.errors));
