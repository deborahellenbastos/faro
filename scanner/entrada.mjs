// Vigia de entrada (20/11, só simulação): roda ao lado da vigia de venda, no servidor, por N segundos.
// Lê o Radar que a rodada gravou, consulta o preço das aprovadas a cada ~10 s (DexScreener, uma consulta para até 30)
// e simula a entrada rápida (regras em rapida.mjs). Nunca compra de verdade: só escreve em /tmp/faro-entrada.json,
// que a rodada copia para os dados do painel (state.simRapida).
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decrypt } from './vault.mjs';
import { getMarketData } from './api.mjs';
import { summarizeMarket } from './analyze.mjs';
import { addTick, addLiq, rapidSignal, rapidExit, rapidStats } from './rapida.mjs';

export const MEM = process.env.FARO_ENTRADA_MEM || '/tmp/faro-entrada.json';
const LOCK = MEM.replace(/\.json$/, '') + '.lock';
const seconds = Math.max(0, Number(process.argv[2]) || 0);
const until = Date.now() + seconds * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (m, e) => (e ? console.error : console.log)(`[entrada ${new Date().toISOString().slice(11, 19)}] ${m}`);

const cfg = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const R = cfg.entradaRapida || {};
const password = process.env.FARO_SENHA || '';
if (!R.ligado || !password || !seconds) process.exit(0);

// Só um processo por vez (a vigia recomeça a cada 60 s)
try {
  const lk = JSON.parse(await readFile(LOCK, 'utf8'));
  if (lk.pid && lk.pid !== process.pid && Date.now() - lk.at < (seconds + 30) * 1000) { try { process.kill(lk.pid, 0); process.exit(0); } catch {} }
} catch {}
await writeFile(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() })).catch(() => {});
const bye = async (code = 0) => { await unlink(LOCK).catch(() => {}); process.exit(code); };
setTimeout(() => bye(0), (seconds + 15) * 1000).unref();

let state = null;
for (let i = 0; i < 4 && !state; i++) {
  try { state = decrypt(JSON.parse(await readFile(process.env.FARO_DADOS || path.join(root, 'docs', 'data.enc.json'), 'utf8')), password); }
  catch { await sleep(1500); }
}
if (!state) { log('Não consegui abrir os dados; tento no próximo minuto.', true); await bye(0); }

let mem = null;
try { mem = JSON.parse(await readFile(MEM, 'utf8')); } catch {}
// Depois de reiniciar o servidor o /tmp volta vazio: recomeça das operações que a rodada guardou
if (!mem) mem = { open: state.simRapida?.open || [], closed: state.simRapida?.closed || [], startedAt: state.simRapida?.startedAt || Date.now() };
mem.bars = mem.bars || {}; mem.liq = mem.liq || {}; mem.done = mem.done || {}; mem.seen = mem.seen || {}; mem.why = mem.why || {};
const save = () => writeFile(MEM, JSON.stringify(mem)).catch(() => {});

const S = cfg.simulacao || {};
const cost = ((S.taxaPct ?? 1) + (S.slippagePct ?? 2)) / 100;
const sol = state.banca?.solPorCompra || cfg.compra?.solPorCompra || 0.05;
const every = Math.max(5, R.segundos ?? 10) * 1000;
const tokens = state.tokens || {};

function watchList() {
  const open = new Set(mem.open.map((o) => o.mint));
  const radar = Object.values(tokens).filter((t) => t.status === 'aprovada' && !t.held && t.dexId !== 'pumpfun')
    .sort((a, b) => (b.approvedAt || 0) - (a.approvedAt || 0)).slice(0, R.maxMoedas ?? 25).map((t) => t.mint);
  return [...new Set([...open, ...radar])];
}

const day0 = () => { const d = new Date(Date.now() - 3 * 3600000); d.setUTCHours(0, 0, 0, 0); return d.getTime() + 3 * 3600000; };

while (Date.now() < until) {
  const t0 = Date.now();
  const mints = watchList();
  let market = new Map();
  try { market = await getMarketData(mints, log); } catch (e) { log(`mercado indisponível: ${e.message}`, true); }
  const now = Date.now();
  const mk = {};
  for (const m of mints) {
    const s = summarizeMarket(market.get(m) || [], now);
    if (!s) continue;
    mk[m] = s; mem.seen[m] = now;
    addTick((mem.bars[m] = mem.bars[m] || []), s.priceUsd, now);
    addLiq((mem.liq[m] = mem.liq[m] || []), s.liquidityUsd, now);
  }
  // 1. Saídas
  for (const o of [...mem.open]) {
    const s = mk[o.mint];
    let ex = s ? rapidExit(o, s.priceUsd, mem.bars[o.mint] || [], mem.liq[o.mint] || [], now, R) : null;
    if (!s && now - (mem.seen[o.mint] || o.at) > 10 * 60000) ex = { exit: (o.lastPx || o.entry) * 0.5, why: 'sumiu' };
    if (s) o.lastPx = s.priceUsd;
    if (!ex) continue;
    const net = (ex.exit / o.entry) * (1 - cost) / (1 + cost) - 1;
    mem.open = mem.open.filter((x) => x !== o);
    mem.closed.unshift({ ...o, exitAt: now, exit: ex.exit, why: ex.why, pnlPct: net * 100, pnlSol: o.sol * net });
    mem.done[o.mint] = now;
    log(`SIMULAÇÃO RÁPIDA: fechou ${o.symbol} por ${ex.why} (${net >= 0 ? '+' : ''}${(net * 100).toFixed(1)}%)`);
  }
  mem.closed = mem.closed.slice(0, 300);
  // 2. Entradas (com as travas da simulação: abertas, compras por dia, perda do dia)
  const d0 = day0();
  const today = [...mem.open, ...mem.closed].filter((x) => x.at >= d0);
  const lossDay = mem.closed.filter((x) => x.exitAt >= d0).reduce((a, x) => a + x.pnlSol, 0);
  if (lossDay > -(R.perdaMaxDiaVezesBase ?? 4) * sol) {
    for (const m of mints) {
      if (mem.open.length >= (R.maxAbertas ?? 2) || today.length >= (R.maxComprasPorDia ?? 8)) break;
      const t = tokens[m], s = mk[m];
      if (!t || !s || mem.open.some((x) => x.mint === m)) continue;
      if (now - (mem.done[m] || 0) < (R.reentradaHoras ?? 6) * 3600000) continue;
      const g = rapidSignal({ ...t, priceUsd: s.priceUsd }, mem.bars[m] || [], mem.liq[m] || [], s, now, R, cfg);
      if (!g.ok) { mem.why[m] = g.motivo; continue; }
      const o = { mint: m, symbol: t.symbol, at: now, entry: g.px, sol, score: t.score, recuo: g.recuo, fundo: g.fundo, peakMove: g.peak,
        stop: g.px * (1 - (R.stopPct ?? 15) / 100), tp: g.px * (1 + (R.alvoPct ?? 100) / 100), rr: (R.alvoPct ?? 100) / (R.stopPct ?? 15),
        sinal: `Entrada rápida: correção de ${g.recuo.toFixed(0)}% da subida e reação no 1 min`, sinalRodada: t.sinal?.fase || null, liq: s.liquidityUsd, soJupiter: !!t.soJupiter };
      mem.open.push(o); today.push(o);
      log(`SIMULAÇÃO RÁPIDA: entrou em ${t.symbol} a US$ ${g.px.toPrecision(4)} (correção ${g.recuo.toFixed(0)}%, liquidez US$ ${Math.round(s.liquidityUsd)})`);
    }
  }
  // limpeza: moedas que saíram da lista
  for (const k of Object.keys(mem.bars)) if (!mints.includes(k) && now - (mem.seen[k] || 0) > 30 * 60000) { delete mem.bars[k]; delete mem.liq[k]; delete mem.seen[k]; delete mem.why[k]; }
  for (const k of Object.keys(mem.done)) if (now - mem.done[k] > 2 * 86400000) delete mem.done[k];
  mem.stats = rapidStats(mem.closed, mem.open);
  mem.updatedAt = now;
  await save();
  const wait = Math.min(every - (Date.now() - t0), until - Date.now());
  if (wait > 0) await sleep(wait);
}
await bye(0);
