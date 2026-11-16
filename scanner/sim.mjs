// Modo simulação: o robô "opera de mentira" com as mesmas regras do plano de trade e mede o resultado.
// Nenhum dinheiro é usado. Cada operação simulada tem entrada, stop, alvo e custos (taxa + slippage) estimados.
//
// Entrada: sinal de "Boa entrada" (a mesma lista que a compra automática real usa).
// Saída: as mesmas regras do robô de verdade: stop do sinal, stop móvel, +100%, perigo na moeda ou tempo máximo.

import { trailStop } from './signals.mjs';

const pct = (a, b) => (b ? (a / b - 1) * 100 : 0);

// Stop no fundo recente (entre -8% e -40%) ou -25%; alvo no topo anterior (se 30%+ acima) ou +100%
export function planFor(t, cfg) {
  const S = cfg.simulacao || {};
  const E = t.priceUsd;
  if (!(E > 0)) return null;
  const c = t.candles || [];
  const recent = c.slice(-12);
  const low = recent.length ? Math.min(...recent.map((x) => x[3])) : 0;
  const high = c.length ? Math.max(...c.map((x) => x[2])) : 0;
  const stop = low && low < E * 0.92 && low > E * 0.6 ? low * 0.97 : E * (1 - (S.stopPadraoPct ?? 25) / 100);
  const tp = high > E * 1.3 ? high : E * (1 + (S.alvoPadraoPct ?? 100) / 100);
  const rr = (tp - E) / (E - stop);
  return { entry: E, stop, tp, rr };
}

export function simStep({ state, tokens, candidates, cfg, now, log }) {
  const S = cfg.simulacao || {};
  if (S.ligado === false) return;
  const sim = (state.sim = state.sim || { open: [], closed: [], startedAt: now });
  const base = cfg.compra?.solPorCompra ?? 0.05;
  const cost = ((S.taxaPct ?? 1) + (S.slippagePct ?? 2)) / 100; // por lado (compra e venda)
  const day = now - 86400000;

  // 1. Fecha as abertas que bateram alvo, stop, perigo ou tempo
  for (const o of [...sim.open]) {
    const t = tokens[o.mint];
    const px = t?.priceUsd;
    // máxima e mínima desde a última checagem (velas de 5 min), para não perder toques entre rodadas
    const bars = (t?.candles || []).filter((x) => x[0] >= (o.checkedAt || o.at) - 300000);
    const hi = Math.max(px || 0, ...bars.map((x) => x[2]));
    const lo = Math.min(px || Infinity, ...bars.map((x) => x[3]));
    let exit = null, why = null;
    // stop móvel igual ao robô real (só sobe)
    const SM = cfg.venda?.stopMovel;
    if (SM?.ligado && t?.candles?.length) {
      const tr = trailStop(t.candles, { entryPx: o.entry, entryAt: o.at, peak: Math.max(o.peak || 0, hi) }, SM, o.trail || 0);
      o.peak = Math.max(o.peak || 0, hi);
      if (tr?.ativo) o.trail = tr.stop;
    }
    const lucroPx = o.entry * (1 + (cfg.venda?.lucro?.alvoPct ?? 100) / 100);
    if (o.trail && lo <= o.trail) { exit = o.trail * (1 - (S.slippageStopPct ?? 5) / 100); why = 'stop móvel'; }
    else if (lo <= o.stop) { exit = o.stop * (1 - (S.slippageStopPct ?? 5) / 100); why = 'stop'; }
    else if (hi >= lucroPx) { exit = lucroPx; why = 'alvo'; }
    else if (t?.safety?.level === 'danger' && px) { exit = px * 0.9; why = 'perigo'; }
    else if (now - o.at > (S.horasMaximas ?? 24) * 3600000 && px) { exit = px; why = 'tempo'; }
    else if (!t) { exit = o.entry * 0.5; why = 'sumiu'; }
    o.checkedAt = now;
    if (!exit) continue;
    const gross = exit / o.entry - 1;
    const net = (1 + gross) * (1 - cost) / (1 + cost) - 1; // paga custo na entrada e na saída
    const closed = { ...o, exitAt: now, exit, why, pnlPct: net * 100, pnlSol: base * net };
    sim.open = sim.open.filter((x) => x !== o);
    sim.closed.unshift(closed);
    log(`SIMULAÇÃO: fechou ${o.symbol} por ${why} (${net >= 0 ? '+' : ''}${(net * 100).toFixed(1)}%)`);
  }
  sim.closed = sim.closed.slice(0, 300);

  // 2. Abre novas, dentro das travas
  const todayClosed = sim.closed.filter((x) => x.exitAt > day);
  const todayPnl = todayClosed.reduce((a, x) => a + x.pnlSol, 0);
  const todayOpened = [...sim.open, ...sim.closed].filter((x) => x.at > day).length;
  const lossCap = -(S.perdaMaxDiaVezesBase ?? 3) * base;
  for (const t of candidates || []) {
    if (sim.open.length >= (S.maxAbertas ?? 2)) break;
    if (todayOpened + sim.open.filter((x) => x.at === now).length >= (cfg.compra?.maxComprasPorDia ?? 5)) break;
    if (todayPnl <= lossCap) { log('SIMULAÇÃO: perda máxima do dia atingida, sem novas entradas'); break; }
    if ((t.score || 0) < (cfg.compra?.scoreMinimo ?? 70)) continue;
    if (t.shape && ['morta', 'reta'].includes(t.shape.tipo)) continue;
    if (sim.open.some((x) => x.mint === t.mint)) continue;
    if (sim.closed.some((x) => x.mint === t.mint && x.at > day)) continue; // uma vez por dia por moeda, igual à compra real
    const g = t.sinal, E = t.priceUsd;
    if (!(E > 0) || !(g.stop > 0 && g.stop < E)) continue;
    const tp = E * (1 + (cfg.venda?.lucro?.alvoPct ?? 100) / 100);
    sim.open.push({ mint: t.mint, symbol: t.symbol, at: now, entry: E, stop: g.stop, tp, rr: g.rr, score: t.score, sol: base, sinal: g.msg });
    log(`SIMULAÇÃO: entrou em ${t.symbol} no sinal de boa entrada a ${E} (stop ${pct(g.stop, E).toFixed(0)}%, 1:${g.rr.toFixed(1)})`);
  }

  // 3. Resumo
  const c = sim.closed;
  const wins = c.filter((x) => x.pnlPct > 0);
  const losses = c.filter((x) => x.pnlPct <= 0);
  sim.stats = {
    ops: c.length, open: sim.open.length,
    winRate: c.length ? (wins.length / c.length) * 100 : 0,
    pnlSol: c.reduce((a, x) => a + x.pnlSol, 0),
    avgWin: wins.length ? wins.reduce((a, x) => a + x.pnlPct, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, x) => a + x.pnlPct, 0) / losses.length : 0,
    base,
  };
}
