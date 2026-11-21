// Probalis — collecteur horaire (GitHub Actions, serveurs hors de France).
// Lit en lecture seule les prix publics de Polymarket et Kalshi et publie data/odds.json,
// plus data/history.json : l'évolution des prix sur 48 h, pour les courbes de l'application.
// Aucun compte, aucun pari : uniquement des cotes publiques.
import fs from 'node:fs';

const NOW = Number(process.env.PA_NOW) || Date.now();
const HORIZON_MS = 5 * 86400e3;
const H = { headers: { 'User-Agent': 'ParisAnalyse/1.0 (lecture seule)', Accept: 'application/json' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, H);
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}
const num = (x) => { const n = typeof x === 'string' ? parseFloat(x) : x; return Number.isFinite(n) ? n : null; };
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- Polymarket
// code Polymarket -> [sport, ligue affichée]
const PM_LEAGUES = {
  epl: ['soccer', 'eng.1'], lal: ['soccer', 'esp.1'], sea: ['soccer', 'ita.1'], bun: ['soccer', 'ger.1'],
  fl1: ['soccer', 'fra.1'], ucl: ['soccer', 'uefa.champions'], uel: ['soccer', 'uefa.europa'],
  nba: ['basketball', 'nba'], nfl: ['football', 'nfl'], nhl: ['hockey', 'nhl'],
  atp: ['tennis', 'atp'], wta: ['tennis', 'wta'],
  rutopft: ['rugby', 'top14'], ruprem: ['rugby', 'premiership'], rueuchamp: ['rugby', 'champions-cup'], rusixnat: ['rugby', 'six-nations']
};
const FULL_GAME = new Set(['moneyline', 'spreads', 'totals', 'both_teams_to_score', 'tennis_set_handicap', 'tennis_set_totals']);

function pmPrice(m) {
  try {
    const p = JSON.parse(m.outcomePrices || '[]').map(num);
    return p.length === 2 && p.every((x) => x !== null) ? p : null;
  } catch { return null; }
}
function pmOutcomes(m) { try { return JSON.parse(m.outcomes || '[]'); } catch { return []; } }

function baseSlug(slug) {
  const m = /^(.*?-\d{4}-\d{2}-\d{2})/.exec(slug || '');
  return m ? m[1] : slug;
}

const DEBUG = [];
async function polymarket() {
  const sports = await getJSON('https://gamma-api.polymarket.com/sports');
  const games = new Map();
  const minEnd = new Date(NOW - 86400e3).toISOString();
  const maxEnd = new Date(NOW + HORIZON_MS + 8 * 86400e3).toISOString();
  for (const [code, [sport, league]] of Object.entries(PM_LEAGUES)) {
    const s = sports.find((x) => x.sport === code);
    if (!s) continue;
    const seriesId = String(s.series).split(',')[0];
    for (let offset = 0; offset < 1500; offset += 500) {
      const url = 'https://gamma-api.polymarket.com/events?series_id=' + seriesId + '&closed=false&limit=500&offset=' + offset +
        '&end_date_min=' + encodeURIComponent(minEnd) + '&end_date_max=' + encodeURIComponent(maxEnd);
      let evs;
      try { evs = await getJSON(url); } catch { break; }
      for (const ev of evs) {
        const start = Date.parse(ev.startTime || (ev.markets && ev.markets[0] && ev.markets[0].gameStartTime) || '');
        if (!(start > NOW) || start > NOW + HORIZON_MS) continue;
        const teams = ev.teams || [];
        if (teams.length !== 2) continue;
        const home = teams.find((t) => t.ordering === 'home') || teams[0];
        const away = teams.find((t) => t !== home);
        const key = baseSlug(ev.slug);
        if (!games.has(key)) {
          games.set(key, {
            src: 'polymarket', id: key, sport, league, start: new Date(start).toISOString(),
            home: home.name, away: away.name, homeAlias: home.alias || '', awayAlias: away.alias || '',
            ml: {}, spreads: [], totals: [], btts: null, sets: [], vol: 0
          });
        }
        const g = games.get(key);
        if (sport === 'soccer' && DEBUG.length < 6) {
          DEBUG.push({ slug: ev.slug, types: [...new Set((ev.markets || []).map((m) => m.sportsMarketType))],
            ml: (ev.markets || []).filter((m) => m.sportsMarketType === 'moneyline').slice(0, 3).map((m) => [m.question, m.groupItemTitle, m.outcomes, m.outcomePrices]) });
        }
        for (const m of ev.markets || []) {
          if (m.closed || !FULL_GAME.has(m.sportsMarketType)) continue;
          const pr = pmPrice(m); const oc = pmOutcomes(m);
          if (!pr || oc.length !== 2) continue;
          g.vol += num(m.volumeNum) || 0;
          const side = (name) => sideOf(name, home, away);
          if (m.sportsMarketType === 'moneyline') {
            if (/^yes$/i.test(oc[0])) {
              const t = (m.groupItemTitle || m.question || '');
              if (/draw|nul|tie/i.test(t)) g.ml.draw = r3(pr[0]);
              else { const sd = side(t); if (sd) g.ml[sd] = r3(pr[0]); }
            } else {
              const s0 = side(oc[0]), s1 = side(oc[1]);
              if (s0 && s1 && s0 !== s1) { g.ml[s0] = r3(pr[0]); g.ml[s1] = r3(pr[1]); }
            }
          } else if (m.sportsMarketType === 'spreads' || m.sportsMarketType === 'tennis_set_handicap') {
            const L = num(m.line); const s0 = side(oc[0]), s1 = side(oc[1]);
            if (L === null || !s0 || !s1 || s0 === s1) continue;
            const arr = m.sportsMarketType === 'spreads' ? g.spreads : g.sets;
            arr.push({ side: s0, line: L, p: r3(pr[0]) }, { side: s1, line: -L, p: r3(pr[1]) });
          } else if (m.sportsMarketType === 'totals' || m.sportsMarketType === 'tennis_set_totals') {
            const L = num(m.line); if (L === null) continue;
            const overIdx = /^over/i.test(oc[0]) ? 0 : 1;
            (m.sportsMarketType === 'totals' ? g.totals : (g.setTotals = g.setTotals || [])).push({ line: L, over: r3(pr[overIdx]) });
          } else if (m.sportsMarketType === 'both_teams_to_score') {
            g.btts = r3(/^yes$/i.test(oc[0]) ? pr[0] : pr[1]);
          }
        }
      }
      if (evs.length < 500) break;
      await sleep(200);
    }
  }
  const out = [...games.values()].filter((g) => Object.keys(g.ml).length || g.spreads.length || g.totals.length);
  out.forEach((g) => { g.vol = Math.round(g.vol); });
  return out;
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function sideOf(name, home, away) {
  const n = norm(name);
  // correspondance par mots entiers (évite « che » dans « manchester »)
  const hit = (t) => [t.name, t.alias, t.abbreviation].filter(Boolean).some((x) => {
    const v = norm(x);
    return v && n && ((' ' + n + ' ').includes(' ' + v + ' ') || (' ' + v + ' ').includes(' ' + n + ' '));
  });
  const h = hit(home), a = hit(away);
  if (h && !a) return 'home';
  if (a && !h) return 'away';
  return null;
}

// ---------------------------------------------------------------- Kalshi
const K_SERIES = {
  soccer: {
    'eng.1': ['KXEPLGAME', 'KXEPLSPREAD', 'KXEPLTOTAL'], 'esp.1': ['KXLALIGAGAME', 'KXLALIGASPREAD', 'KXLALIGATOTAL'],
    'ita.1': ['KXSERIEAGAME', 'KXSERIEASPREAD', 'KXSERIEATOTAL'], 'ger.1': ['KXBUNDESLIGAGAME', 'KXBUNDESLIGASPREAD', 'KXBUNDESLIGATOTAL'],
    'fra.1': ['KXLIGUE1GAME', 'KXLIGUE1SPREAD', 'KXLIGUE1TOTAL'], 'uefa.champions': ['KXUCLGAME', 'KXUCLSPREAD', 'KXUCLTOTAL'],
    'uefa.europa': ['KXUELGAME', 'KXUELSPREAD', 'KXUELTOTAL']
  },
  basketball: { nba: ['KXNBAGAME', 'KXNBASPREAD', 'KXNBATOTAL'] },
  football: { nfl: ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL'] },
  hockey: { nhl: ['KXNHLGAME', 'KXNHLSPREAD', 'KXNHLTOTAL'] },
  tennis: { atp: ['KXATPMATCH'], wta: ['KXWTAMATCH'] },
  rugby: { top14: ['KXRUGBYFRA14MATCH'] }
};
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function kPrice(m) {
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
  if (bid !== null && ask !== null && ask > 0 && ask - bid <= 0.1) return (bid + ask) / 2;
  if (last !== null && last > 0 && last < 1) return last;
  return null;
}

async function kalshi() {
  const games = new Map();
  for (const [sport, leagues] of Object.entries(K_SERIES)) {
    for (const [league, series] of Object.entries(leagues)) {
      for (const ticker of series) {
        let cursor = '';
        for (let page = 0; page < 5; page++) {
          let d;
          try {
            d = await getJSON('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=' + ticker + '&status=open&limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
          } catch { break; }
          for (const m of d.markets || []) {
            const ev = m.event_ticker || '';
            const suffix = ev.split('-').slice(1).join('-');
            const dm = /^(\d{2})([A-Z]{3})(\d{2})/.exec(suffix);
            if (!dm) continue;
            const date = new Date(Date.UTC(2000 + +dm[1], MONTHS[dm[2]], +dm[3]));
            if (date.getTime() < NOW - 2 * 86400e3 || date.getTime() > NOW + HORIZON_MS) continue;
            const exp = Date.parse(m.occurrence_datetime || m.expected_expiration_time || '');
            if (exp && exp < NOW) continue; // déjà joué
            const p = kPrice(m); if (p === null) continue;
            const key = league + ':' + suffix;
            if (!games.has(key)) games.set(key, { src: 'kalshi', id: key, sport, league, date: date.toISOString().slice(0, 10), teams: [], ml: {}, spreads: [], totals: [], vol: 0 });
            const g = games.get(key);
            g.vol += num(m.volume_fp) || 0;
            if (/GAME$|MATCH$/.test(ticker)) {
              const t = m.yes_sub_title || '';
              if (/^tie$|^draw$/i.test(t)) g.ml.Tie = r3(p);
              else { g.ml[t] = r3(p); if (!g.teams.includes(t)) g.teams.push(t); }
            } else if (/SPREAD$/.test(ticker)) {
              const mm = /^(.*?) wins by (?:over|more than) ([\d.]+)/i.exec(m.yes_sub_title || m.title || '');
              if (mm) g.spreads.push({ team: mm[1].trim(), over: num(mm[2]), p: r3(p) });
            } else if (/TOTAL$/.test(ticker)) {
              const L = num(m.floor_strike);
              if (L !== null) g.totals.push({ line: L, over: r3(p) });
            }
          }
          cursor = d.cursor || '';
          if (!cursor) break;
          await sleep(150);
        }
        await sleep(150);
      }
    }
  }
  const out = [...games.values()].filter((g) => g.teams.length >= 2 || g.spreads.length || g.totals.length);
  out.forEach((g) => { g.vol = Math.round(g.vol); });
  return out;
}

// ---------------------------------------------------------------- Historique 48 h
// Une valeur par heure et par marché, codée sur 2 caractères (0 à 1000 = 0 à 100 %), « ~~ » = absent.
const ALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const MISS = '~~';
const MAX_POINTS = 49; // 48 h d'écart entre le premier et le dernier relevé
function enc(p) {
  if (!(p > 0 && p < 1)) return MISS;
  const v = Math.round(p * 1000);
  return ALPH[v >> 6] + ALPH[v & 63];
}
const ladder = (p) => p >= 0.02 && p <= 0.98; // extrémités des échelles de handicaps : inutiles
/** Prix d'un match à plat : clé -> probabilité (orientation propre à la source, relue par l'application). */
function flatten(src, g) {
  const o = {};
  Object.keys(g.ml || {}).forEach((k) => { o['ml|' + k] = g.ml[k]; });
  if (src === 'polymarket') {
    (g.spreads || []).forEach((x) => { if (x.side === 'home' && ladder(x.p)) o['sp|' + x.line] = x.p; });
    (g.sets || []).forEach((x) => { if (x.side === 'home') o['se|' + x.line] = x.p; });
    (g.totals || []).forEach((x) => { if (ladder(x.over)) o['to|' + x.line] = x.over; });
    (g.setTotals || []).forEach((x) => { o['st|' + x.line] = x.over; });
    if (g.btts !== null && g.btts !== undefined) o.bt = g.btts;
  } else {
    (g.spreads || []).forEach((x) => { if (ladder(x.p)) o['sp|' + x.team + '|' + x.over] = x.p; });
    (g.totals || []).forEach((x) => { if (ladder(x.over)) o['to|' + x.line] = x.over; });
  }
  return o;
}
/**
 * Ajoute le relevé du jour à l'historique.
 * prev : historique précédent (ou null) ; result : sortie de la collecte ; now : ms.
 * Une source en erreur garde ses matchs, avec un relevé « absent ».
 */
function updateHistory(prev, result, now) {
  const T = Math.round(now / 60000);
  const ok = prev && prev.v === 1 && Array.isArray(prev.t);
  const t = ok ? prev.t.slice() : [];
  const replace = t.length > 0 && Math.floor(T / 60) === Math.floor(t[t.length - 1] / 60); // même heure : on remplace le dernier relevé
  if (replace) t[t.length - 1] = T; else t.push(T);
  const n = t.length;
  const out = { v: 1, generatedAt: new Date(now).toISOString(), t, polymarket: {}, kalshi: {} };
  for (const src of ['polymarket', 'kalshi']) {
    const old = (ok && prev[src]) || {};
    const failed = !(result.sources[src] && result.sources[src].ok);
    const games = failed ? Object.keys(old).map((id) => ({ id, _carry: true })) : result[src];
    for (const g of games) {
      const o = old[g.id];
      const flat = g._carry ? {} : flatten(src, g);
      const s = o ? o.s : n - 1;
      const len = n - s; // longueur finale de chaque série de ce match
      const keys = new Set([...Object.keys(flat), ...Object.keys((o && o.k) || {})]);
      const k = {};
      for (const key of keys) {
        let str = (o && o.k[key]) || '';
        const keep = len - 1; // valeurs conservées avant le relevé courant
        str = str.slice(0, keep * 2);
        while (str.length < keep * 2) str = MISS + str; // nouvelle ligne de marché : début absent
        str += enc(flat[key]);
        if (/[^~]/.test(str)) k[key] = str;
      }
      if (Object.keys(k).length) out[src][g.id] = { s, st: g.start || g.date || (o && o.st), k };
    }
  }
  // Fenêtre glissante de 48 h
  const drop = Math.max(0, out.t.length - MAX_POINTS);
  if (drop) {
    out.t = out.t.slice(drop);
    for (const src of ['polymarket', 'kalshi']) {
      for (const [id, g] of Object.entries(out[src])) {
        g.s -= drop;
        if (g.s < 0) {
          const cut = -g.s * 2; g.s = 0;
          for (const key of Object.keys(g.k)) { g.k[key] = g.k[key].slice(cut); if (!/[^~]/.test(g.k[key])) delete g.k[key]; }
          if (!Object.keys(g.k).length) delete out[src][id];
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- Publication
export { polymarket, kalshi, sideOf, norm, updateHistory, flatten, enc };
if (!process.env.PA_NO_MAIN) await main();
async function main() {
const result = { generatedAt: new Date().toISOString(), sources: {}, polymarket: [], kalshi: [] };
for (const [name, fn] of [['polymarket', polymarket], ['kalshi', kalshi]]) {
  try {
    result[name] = await fn();
    result.sources[name] = { ok: true, games: result[name].length };
  } catch (e) {
    result.sources[name] = { ok: false, error: String(e && e.message || e) };
  }
}
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/odds.json', JSON.stringify(result));
let prev = null;
try { prev = JSON.parse(fs.readFileSync('data/history.json', 'utf8')); } catch { /* premier relevé */ }
if (Object.values(result.sources).some((x) => x.ok)) {
  const hist = updateHistory(prev, result, NOW);
  fs.writeFileSync('data/history.json', JSON.stringify(hist));
  console.log('historique : ' + hist.t.length + ' relevé(s), ' + Object.keys(hist.polymarket).length + ' + ' + Object.keys(hist.kalshi).length + ' matchs');
}
fs.writeFileSync('data/debug.json', JSON.stringify(DEBUG, null, 1));
console.log(JSON.stringify(result.sources));
}
