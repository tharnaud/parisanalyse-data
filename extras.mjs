// Données complémentaires pour la mesure (lecture seule, sources gratuites, sans compte) :
// - football-data.co.uk : cotes de clôture Betfair Exchange (bourse de paris) et moyenne du marché, championnats européens ;
//   Les deux saisons précédentes servent à calculer un Elo maison sur les résultats (l'API ClubElo est désactivée).
// Sortie : data/backtest/extra/ (fichiers bruts + index.json). L'analyse se fait sur le PC (tools/backtest-extras.mjs).
import fs from 'node:fs';

const DAYS = Number(process.env.BT_DAYS) || 40;
const OUT = 'data/backtest/extra';
const H = { headers: { 'User-Agent': 'ParisAnalyse/1.0 (lecture seule)' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getText(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000); // 20 s au plus par requête
    try {
      const r = await fetch(url, Object.assign({ signal: ctrl.signal }, H));
      const t = r.ok ? await r.text() : null;
      clearTimeout(timer);
      if (r.ok) return t;
      if (r.status === 404) return null;
    } catch (e) { clearTimeout(timer); }
    await sleep(2000);
  }
  return null;
}
const FD = { 'eng.1': 'E0', 'esp.1': 'SP1', 'ita.1': 'I1', 'ger.1': 'D1', 'fra.1': 'F1', 'eng.2': 'E1', 'fra.2': 'F2', 'por.1': 'P1', 'ned.1': 'N1' };
const season = (d) => { const y = d.getUTCFullYear() % 100, a = d.getUTCMonth() >= 6 ? y : y - 1; return String(a).padStart(2, '0') + String(a + 1).padStart(2, '0'); };

fs.mkdirSync(OUT, { recursive: true });
const now = new Date(), from = new Date(now.getTime() - DAYS * 86400e3);
const index = { generatedAt: now.toISOString(), from: from.toISOString(), fd: {} };
const back = (code, k) => { const a = +code.slice(0, 2) - k; return String(a).padStart(2, '0') + String(a + 1).padStart(2, '0'); };
for (const [lg, code] of Object.entries(FD)) {
  for (const s of new Set([back(season(from), 2), back(season(from), 1), season(from), season(now)])) {
    const t = await getText(`https://www.football-data.co.uk/mmz4281/${s}/${code}.csv`);
    if (!t || !t.startsWith('Div,')) continue;
    const f = `fd-${s}-${code}.csv`;
    fs.writeFileSync(`${OUT}/${f}`, t);
    (index.fd[lg] = index.fd[lg] || []).push(f);
  }
  console.log('football-data', lg, index.fd[lg] ? 'ok' : 'absent');
  await sleep(500);
}
fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
console.log('football-data :', Object.values(index.fd).flat().length, 'fichier(s)');
