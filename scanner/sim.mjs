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

export function simStep({ state, key = 'sim', label = 'SIMULAÇÃO', tokens, candidates, rompidas = [], cfg, now, log }) {
  const S = cfg.simulacao || {};
  if (S.ligado === false) return;
  const sim = (state[key] = state[key] || { open: [], closed: [], startedAt: now });
  const logS = (m) => log(m.replace(/^SIMULAÇÃO/, label));
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
    logS(`SIMULAÇÃO: fechou ${o.symbol} por ${why} (${net >= 0 ? '+' : ''}${(net * 100).toFixed(1)}%)`);
  }
  sim.closed = sim.closed.slice(0, 300);

  // 2. Abre novas, dentro das travas
  const todayClosed = sim.closed.filter((x) => x.exitAt > day);
  const todayPnl = todayClosed.reduce((a, x) => a + x.pnlSol, 0);
  const todayOpened = [...sim.open, ...sim.closed].filter((x) => x.at > day).length;
  const lossCap = -(S.perdaMaxDiaVezesBase ?? 3) * base;
  for (const t of [...(candidates || []), ...rompidas.map((t) => ({ ...t, sinal: t.romp, _romp: true }))]) {
    if (sim.open.length >= (S.maxAbertas ?? 2)) break;
    if (todayOpened + sim.open.filter((x) => x.at === now).length >= (cfg.compra?.maxComprasPorDia ?? 5)) break;
    if (todayPnl <= lossCap) { logS('SIMULAÇÃO: perda máxima do dia atingida, sem novas entradas'); break; }
    if (!t._notaAprov && !t._agr && (t.score || 0) < (cfg.compra?.scoreMinimo ?? 70)) continue;
    if (t.shape && ['morta', 'reta'].includes(t.shape.tipo)) continue;
    if (sim.open.some((x) => x.mint === t.mint)) continue;
    // igual à compra real: a mesma moeda de novo só se a última operação saiu no stop (reentrada)
    const prevToday = sim.closed.filter((x) => x.mint === t.mint && x.at > day);
    if (prevToday.length && !/stop/.test(prevToday[0].why || '')) continue;
    const g = t.sinal, E = t.priceUsd;
    if (!(E > 0) || !(g.stop > 0 && g.stop < E)) continue;
    const tp = E * (1 + (cfg.venda?.lucro?.alvoPct ?? 100) / 100);
    sim.open.push({ mint: t.mint, symbol: t.symbol, at: now, entry: E, stop: g.stop, tp, rr: g.rr, score: t.score, sol: base, sinal: g.msg, ...(t._simCurva && t.dexId === 'pumpfun' ? { curva: true } : {}), ...(t._romp ? { romp: true } : {}), ...(t._notaAprov ? { notaAprov: true, approvalScore: t.approvalScore } : {}), ...(t._agrTipo ? { tipo: t._agrTipo } : {}) });
    logS(`SIMULAÇÃO: entrou em ${t.symbol} no sinal de ${t._romp ? 'rompimento' : 'boa entrada'}${t._notaAprov ? ` (pela nota da aprovação ${t.approvalScore}, agora ${t.score})` : ''} a ${E} (stop ${pct(g.stop, E).toFixed(0)}%, 1:${g.rr.toFixed(1)})`);
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
  const cv = c.filter((x) => x.curva);
  const rp = c.filter((x) => x.romp);
  const na = c.filter((x) => x.notaAprov);
  sim.stats.romp = { ops: rp.length, winRate: rp.length ? (rp.filter((x) => x.pnlPct > 0).length / rp.length) * 100 : 0, pnlSol: rp.reduce((a, x) => a + x.pnlSol, 0) };
  sim.stats.notaAprov = { ops: na.length, winRate: na.length ? (na.filter((x) => x.pnlPct > 0).length / na.length) * 100 : 0, pnlSol: na.reduce((a, x) => a + x.pnlSol, 0) };
  sim.stats.curva = { ops: cv.length, winRate: cv.length ? (cv.filter((x) => x.pnlPct > 0).length / cv.length) * 100 : 0, pnlSol: cv.reduce((a, x) => a + x.pnlSol, 0) };
}

// ---------- Perfil Enlouquecido (só simulação) ----------
// Giro rápido: moeda entrou no Radar, espera a PRIMEIRA correção (recuo desde a máxima depois da aprovação) e entra
// na primeira vela de reação com compra, com valor fixo (US$ 3). Vende em +50%; se a alta estiver muito forte,
// segura com um stop colado no topo e vende de vez em +80%. Stop -20% e no máximo 2 h por operação.
export function crazyEntry(t, now, L = {}) {
  if (t.status !== 'aprovada' || t.held || t.dexId === 'pumpfun') return null;
  if (t.safety?.level === 'danger' || (t.shape && ['morta', 'reta'].includes(t.shape.tipo))) return null;
  if ((t.score || 0) < (L.notaMin ?? 50)) return null;
  const since = (t.candles || []).filter((x) => x[0] >= (t.approvedAt || 0) - 300000);
  if (since.length < 3) return null;
  const n = since.length, last = since[n - 1], prev = since[n - 2];
  const peak = Math.max(...since.slice(0, -1).map((x) => x[2]));
  const px = t.priceUsd || last[4];
  const recuo = (1 - Math.min(last[3], prev[3]) / peak) * 100;
  if (recuo < (L.correcaoMinPct ?? 15) || recuo > (L.correcaoMaxPct ?? 45)) return null; // corrigiu, mas não desabou
  const p5 = t.periods?.m5 || {};
  const buysOk = !(p5.buys + p5.sells > 0) || p5.buys >= p5.sells;
  if (!(px > last[1] && px > prev[4] && buysOk)) return null; // vela de reação com compra
  return { px, peak, recuo, key: `${peak}` };
}

export function simCrazy({ state, tokens, cfg, now, log, solUsd }) {
  const L = cfg.perfis?.enlouquecido || {};
  if (L.ligado === false) return;
  const sim = (state.simLouco = state.simLouco || { open: [], closed: [], done: {}, startedAt: now });
  const S = cfg.simulacao || {};
  const cost = ((S.taxaPct ?? 1) + (S.slippagePct ?? 2)) / 100;
  const usd = L.valorUsd ?? 3;
  const sol = solUsd > 0 ? usd / solUsd : 0;
  const day = now - 86400000;
  // 1. Saídas
  for (const o of [...sim.open]) {
    const t = tokens[o.mint];
    const px = t?.priceUsd;
    const bars = (t?.candles || []).filter((x) => x[0] >= (o.checkedAt || o.at) - 300000);
    const hi = Math.max(px || 0, ...bars.map((x) => x[2]));
    const lo = Math.min(px || Infinity, ...bars.map((x) => x[3]));
    o.peak = Math.max(o.peak || o.entry, hi);
    const tp1 = o.entry * (1 + (L.alvoPct ?? 50) / 100), tp2 = o.entry * (1 + (L.alvoMaxPct ?? 80) / 100);
    const forte = (t?.buyRatioH1 ?? 0) >= (L.forteCompraPct ?? 60) && t?.shape?.tipo === 'organica';
    let exit = null, why = null;
    if (lo <= o.entry * (1 - (L.stopPct ?? 20) / 100)) { exit = o.entry * (1 - (L.stopPct ?? 20) / 100) * 0.95; why = 'stop'; }
    else if (o.trail && lo <= o.trail) { exit = o.trail * 0.97; why = 'segurou e saiu'; }
    else if (hi >= tp2) { exit = tp2; why = 'alvo +80%'; }
    else if (hi >= tp1 && !forte && !o.trail) { exit = tp1; why = 'alvo +50%'; }
    else if (hi >= tp1 && forte) o.trail = Math.max(o.trail || 0, tp1 * 0.97, o.peak * 0.88); // alta muito forte: segura um pouco
    if (!exit && o.trail) o.trail = Math.max(o.trail, o.peak * 0.88);
    if (!exit && t?.safety?.level === 'danger' && px) { exit = px * 0.9; why = 'perigo'; }
    if (!exit && now - o.at > (L.horasMax ?? 2) * 3600000 && px) { exit = px; why = 'tempo (2h)'; }
    if (!exit && !t) { exit = o.entry * 0.5; why = 'sumiu'; }
    o.checkedAt = now;
    if (!exit) continue;
    const net = (exit / o.entry) * (1 - cost) / (1 + cost) - 1;
    sim.open = sim.open.filter((x) => x !== o);
    sim.closed.unshift({ ...o, exitAt: now, exit, why, pnlPct: net * 100, pnlSol: o.sol * net });
    log(`SIMULAÇÃO ENLOUQUECIDO: fechou ${o.symbol} por ${why} (${net >= 0 ? '+' : ''}${(net * 100).toFixed(1)}%)`);
  }
  sim.closed = sim.closed.slice(0, 300);
  // 2. Entradas (uma vez por moeda: "a primeira correção")
  const todayClosed = sim.closed.filter((x) => x.exitAt > day);
  const todayPnl = todayClosed.reduce((a, x) => a + x.pnlSol, 0);
  const todayOpened = [...sim.open, ...sim.closed].filter((x) => x.at > day).length;
  if (sol > 0 && todayPnl > -(L.perdaMaxDiaVezes ?? 5) * sol) {
    for (const t of Object.values(tokens)) {
      if (sim.open.length >= (L.maxAbertas ?? 4) || todayOpened + sim.open.filter((x) => x.at === now).length >= (L.maxComprasPorDia ?? 15)) break;
      if (sim.done[t.mint] || sim.open.some((x) => x.mint === t.mint)) continue;
      const g = crazyEntry(t, now, L);
      if (!g) continue;
      sim.done[t.mint] = now;
      sim.open.push({ mint: t.mint, symbol: t.symbol, at: now, entry: g.px, sol, usd, score: t.score, recuo: g.recuo, stop: g.px * (1 - (L.stopPct ?? 20) / 100), tp: g.px * (1 + (L.alvoPct ?? 50) / 100), rr: (L.alvoPct ?? 50) / (L.stopPct ?? 20), sinal: `Primeira correção (-${g.recuo.toFixed(0)}% do topo) com reação` });
      log(`SIMULAÇÃO ENLOUQUECIDO: entrou em ${t.symbol} na primeira correção (-${g.recuo.toFixed(0)}% do topo), US$ ${usd}`);
    }
  }
  for (const k of Object.keys(sim.done)) if (now - sim.done[k] > 2 * 86400000) delete sim.done[k];
  // 3. Resumo
  const c = sim.closed, wins = c.filter((x) => x.pnlPct > 0), losses = c.filter((x) => x.pnlPct <= 0);
  sim.stats = { ops: c.length, open: sim.open.length, winRate: c.length ? (wins.length / c.length) * 100 : 0, pnlSol: c.reduce((a, x) => a + x.pnlSol, 0),
    avgWin: wins.length ? wins.reduce((a, x) => a + x.pnlPct, 0) / wins.length : 0, avgLoss: losses.length ? losses.reduce((a, x) => a + x.pnlPct, 0) / losses.length : 0,
    avgMin: c.length ? c.reduce((a, x) => a + (x.exitAt - x.at), 0) / c.length / 60000 : 0, base: sol };
}
