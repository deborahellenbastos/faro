// Entrada rápida (20/11, teste só na simulação): olha as moedas aprovadas do Radar a cada ~10 s e monta velas de 1 min.
// Entra quando a correção é rasa ou média (38,2% a 61,8% da subida), o gráfico de 1 min mostra reação (vela verde que
// fecha acima da máxima da anterior, com fundo mais alto), a liquidez está de pé e as compras dominam.
// Sai pelas mesmas regras do robô de verdade, mas olhando o preço a cada ~10 s: stop -15%, stop móvel regra A
// (liga com +20%, 12% abaixo do maior fechamento de 1 min), +100% e liquidez saindo.
// Este arquivo só tem as contas (sem rede), para os testes.
import { fakeBuys, peakPassed } from './signals.mjs';
import { jupOk } from './autobuy.mjs';

const MIN = 60000;

// Junta um preço novo na vela de 1 min do minuto atual. bars = [[início, abre, máx, mín, fecha], ...]
export function addTick(bars, px, now, keepMin = 90) {
  if (!(px > 0)) return bars;
  const m = Math.floor(now / MIN) * MIN;
  const last = bars[bars.length - 1];
  if (last && last[0] === m) { last[2] = Math.max(last[2], px); last[3] = Math.min(last[3], px); last[4] = px; }
  else bars.push([m, last ? last[4] : px, Math.max(px, last ? last[4] : px), Math.min(px, last ? last[4] : px), px]);
  while (bars.length && bars[0][0] < m - keepMin * MIN) bars.shift();
  return bars;
}
// Liquidez: guarda [ms, US$] e devolve a queda desde o maior valor da janela, em %
export function addLiq(hist, liq, now, keepMin = 30) {
  if (liq > 0) hist.push([now, liq]);
  while (hist.length && hist[0][0] < now - keepMin * MIN) hist.shift();
  return hist;
}
export function liqDropPct(hist, now, winMin) {
  const w = hist.filter(([t]) => t >= now - winMin * MIN);
  if (w.length < 2) return 0;
  const top = Math.max(...w.map((x) => x[1])), cur = w[w.length - 1][1];
  return top > 0 ? (1 - cur / top) * 100 : 0;
}

// A subida desde a aprovação: base (fundo antes do topo), topo e quanto a correção atual devolveu dela
export function moveOf(t, bars, now) {
  const since = (t.approvedAt || t.firstSeen || now) - 5 * MIN;
  const all = [...(t.candles || []).filter((c) => c[0] >= since).map((c) => [c[0], c[2], c[3]]), ...bars.map((b) => [b[0], b[2], b[3]])].sort((a, b) => a[0] - b[0]);
  if (all.length < 4) return null;
  let iTop = 0; all.forEach((c, i) => { if (c[1] >= all[iTop][1]) iTop = i; });
  const peak = all[iTop][1];
  const before = all.slice(0, iTop + 1);
  const base = Math.min(...before.map((c) => c[2]));
  return { peak, peakAt: all[iTop][0], base, rise: base > 0 ? (peak / base - 1) * 100 : 0 };
}

// Sinal de entrada rápida. Devolve { ok: true, ... } ou { ok: false, motivo }
export function rapidSignal(t, bars, liqHist, mkt, now, R = {}, cfg = {}) {
  const no = (motivo) => ({ ok: false, motivo });
  if (t.status !== 'aprovada' || t.held || t.dexId === 'pumpfun') return no('fora do Radar');
  if (t.safety?.level === 'danger') return no('perigo na moeda');
  if (t.shape && ['morta', 'reta'].includes(t.shape.tipo)) return no('gráfico morto ou reto');
  if ((t.score || 0) < (R.notaMin ?? 70)) return no(`nota ${t.score || 0}`);
  if (!jupOk(t, cfg)) return no('organic baixo');
  const closed = bars.filter((b) => b[0] < Math.floor(now / MIN) * MIN);
  if (closed.length < 4) return no('poucas velas de 1 min');
  const px = mkt?.priceUsd || closed[closed.length - 1][4];
  const mv = moveOf(t, bars, now);
  if (!mv || mv.rise < (R.subidaMinPct ?? 20)) return no('sem subida para medir');
  const [c4, c3, c2, c1] = closed.slice(-4);
  const fundo = Math.min(c2[3], c3[3], c4[3]);
  const recuo = mv.peak > mv.base ? ((mv.peak - fundo) / (mv.peak - mv.base)) * 100 : 0;
  if (recuo < (R.recuoMinPct ?? 38.2)) return no(`correção pequena (${recuo.toFixed(0)}%)`);
  if (recuo > (R.recuoMaxPct ?? 61.8)) return no(`correção funda (${recuo.toFixed(0)}%)`);
  if (px >= mv.peak * 0.97) return no('já voltou ao topo');
  // reação no 1 min: vela verde, fecha acima da máxima da anterior, fundo mais alto e o preço segurando
  if (!(c1[4] > c1[1] && c1[4] > c2[2] && c1[3] > fundo && px >= c1[4] * 0.99)) return no('sem reação no 1 min');
  if (liqHist.length < 3 || liqHist[liqHist.length - 1][0] - liqHist[0][0] < 3 * MIN) return no('pouco histórico de liquidez');
  const dl = liqDropPct(liqHist, now, R.janelaLiquidezMin ?? 10);
  if (dl > (R.liquidezQuedaMaxPct ?? 10)) return no(`liquidez caiu ${dl.toFixed(0)}%`);
  const p5 = mkt?.periods?.m5 || {};
  if ((p5.buys || 0) + (p5.sells || 0) > 0 && (p5.buys || 0) < (p5.sells || 0)) return no('vendas dominando');
  if (fakeBuys(mkt?.periods)) return no('compras falsas');
  if (peakPassed(px, t.ath, now, cfg.sinais?.picoPassou)) return no('pico já passou');
  return { ok: true, px, fundo, recuo, peak: mv.peak, base: mv.base };
}

// Uma posição simulada aberta: atualiza o topo e diz se sai agora. o = { entry, at, peakClose }
export function rapidExit(o, px, bars, liqHist, now, R = {}) {
  if (!(px > 0)) return null;
  const closes = bars.filter((b) => b[0] >= Math.floor(o.at / MIN) * MIN && b[0] < Math.floor(now / MIN) * MIN).map((b) => b[4]);
  o.peakClose = Math.max(o.peakClose || o.entry, ...closes);
  o.peak = Math.max(o.peak || o.entry, px);
  const SM = R.stopMovel || {};
  if (px <= o.entry * (1 - (R.stopPct ?? 15) / 100)) return { exit: px, why: 'stop' };
  if (px >= o.entry * (1 + (R.alvoPct ?? 100) / 100)) return { exit: px, why: 'alvo' };
  if ((o.peakClose / o.entry - 1) * 100 >= (SM.ativarPct ?? 20)) {
    o.trail = Math.max(o.trail || 0, o.peakClose * (1 - (SM.distanciaPct ?? 12) / 100), o.entry * 1.05);
    if (px < o.trail) return { exit: px, why: 'stop móvel' };
  }
  if (liqDropPct(liqHist, now, 5) >= (R.quedaLiquidezSaidaPct ?? 30)) return { exit: px, why: 'liquidez saindo' };
  if (now - o.at > (R.horasMax ?? 24) * 3600000) return { exit: px, why: 'tempo' };
  return null;
}

export function rapidStats(closed, open) {
  const w = closed.filter((x) => x.pnlPct > 0), l = closed.filter((x) => x.pnlPct <= 0);
  const avg = (a, k) => (a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : 0);
  return { ops: closed.length, open: open.length, winRate: closed.length ? (w.length / closed.length) * 100 : 0,
    pnlSol: closed.reduce((s, x) => s + x.pnlSol, 0), avgWin: avg(w, 'pnlPct'), avgLoss: avg(l, 'pnlPct'),
    avgMin: closed.length ? closed.reduce((s, x) => s + (x.exitAt - x.at), 0) / closed.length / MIN : 0 };
}
