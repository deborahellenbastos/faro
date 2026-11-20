// Compra no sinal de "Boa entrada": quem pode ser comprada agora (a simulação e a compra real usam a mesma lista)
// e o interruptor que liga/desliga a compra real, mandado pelo painel como um memo assinado pela carteira.

export const SWITCH_RE = /faro:compra=(on|off)/;
// 20/11: interruptor manual da VENDA automática (memo "faro:venda=on/off" assinado pela carteira). Desligado = o robô não vende
// nada sozinho (stops, stop móvel, escada, lucro, vigia e golpe). Sem memo nenhum, fica como hoje (ligada)
export const SELL_SWITCH_RE = /faro:venda=(on|off)/;
export async function readSellSwitch(memos, verify) {
  for (const m of memos || []) {
    if (m.err || !m.memo) continue;
    const r = SELL_SWITCH_RE.exec(m.memo); if (!r) continue;
    if (!(await verify(m.sig))) continue;
    return { on: r[1] === 'on', at: m.at, sig: m.sig };
  }
  return null;
}
import { fakeBuys } from './signals.mjs';
export const PROFILE_RE = /faro:perfil=(agressivo|conservador)/;

// Configuração de um perfil: a base + os ajustes do perfil (cópia, não mexe na base)
export function profileCfg(cfg, name) {
  const over = cfg.perfis?.[name];
  const out = JSON.parse(JSON.stringify(cfg));
  if (!over) return out;
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (k.startsWith('_')) continue; if (v && typeof v === 'object' && !Array.isArray(v)) { a[k] = a[k] && typeof a[k] === 'object' ? a[k] : {}; merge(a[k], v); } else a[k] = v; } };
  merge(out, over);
  out.__perfil = name;
  return out;
}
// Último memo de perfil assinado pela carteira (mesma regra do interruptor da compra)
// Favoritas mandadas pelo painel (memo "faro:favs=mint1,mint2" assinado pela carteira): o robô fica de olho nelas
const FAVS_RE = /^faro:favs=([1-9A-HJ-NP-Za-km-z,]*)$/;
export async function readFavs(memos, verify) {
  for (const m of memos || []) {
    if (m.err || !m.memo) continue;
    const r = FAVS_RE.exec(m.memo.trim()); if (!r) continue;
    if (!(await verify(m.sig))) continue;
    return { mints: r[1].split(',').filter((x) => x.length >= 32 && x.length <= 44).slice(0, 12), at: m.at, sig: m.sig };
  }
  return null;
}
export const isFav = (t, state) => !!(state?.favs?.mints || []).includes(t.mint);
export async function readProfile(memos, verify) {
  for (const m of memos || []) {
    if (m.err || !m.memo) continue;
    const r = PROFILE_RE.exec(m.memo);
    if (!r) continue;
    if (!(await verify(m.sig))) continue;
    return { name: r[1], at: m.at, sig: m.sig };
  }
  return null;
}

// Saiu no stop há pouco e a moeda segue viva: pode reentrar se o fundo se confirmar (uma vez por moeda no dia)
// Quanto o preço está abaixo do pico das últimas 6h (pontos guardados a cada rodada + velas)
export function peakDropPct(t, now = Date.now()) {
  const since = now - 6 * 3600000;
  const pts = [...(t.hist || []).filter((h) => h[0] >= since).map((h) => h[1]), ...(t.candles || []).filter((c) => c[0] >= since).map((c) => c[2])].filter((x) => x > 0);
  const top = Math.max(0, ...pts), px = t.priceUsd || 0;
  return top > 0 && px > 0 ? (1 - px / top) * 100 : 0;
}
// Segurança da moeda, ignorando avisos de momento: queda do topo, vendas dominando, liquidez oscilando e as ações do
// próprio robô ("Robô vendeu..."). Esses deixam o selo em "Atenção", mas não dizem nada sobre golpe (17/11)
const SECURITY_IDS = new Set(['rugged', 'mint', 'freeze', 'lp', 'risco-novo', 'dev-vendendo', 'concentracao', 'insiders', 'liq-sumiu', 'score']);
export function securityOk(t) {
  return !(t.safety?.alerts || []).some((a) => a.level === 'danger' || (SECURITY_IDS.has(a.id) && a.level === 'warn'));
}
// Nota dividida em duas (17/11, ideia da Kerah): QUALIDADE (holders, liquidez, segurança, distribuição: não muda numa correção)
// e MOVIMENTO (força de compra, giro de volume, tendência da hora: sobe e desce com o gráfico). Cada uma de 0 a 100.
const QUAL_RE = /Holders|liquidez|Segurança|Distribuição/;
export function splitScore(t) {
  const parts = t.scoreParts || []; if (!parts.length) return null;
  const sum = (ps) => { const max = ps.reduce((a, p) => a + (p.max || 0), 0); return max ? Math.round((ps.reduce((a, p) => a + (p.pts || 0), 0) / max) * 100) : null; };
  return { qualidade: sum(parts.filter((p) => QUAL_RE.test(p.label))), movimento: sum(parts.filter((p) => !QUAL_RE.test(p.label))) };
}
// 20/11: moeda que só veio pelos rankings da Jupiter precisa de organic score mínimo (busca.jupiter.organicMin) para entrar
// na simulação e na compra. Em 19/11, abaixo de 50, 87 de 115 viraram golpe; com 50 ou mais, 9 de 47.
export function jupOk(t, cfg) {
  if (!t.soJupiter) return true;
  const min = cfg.busca?.jupiter?.organicMin ?? 0;
  return (t.jup?.organicMax ?? t.jup?.organic ?? 0) >= min;
}
// 20/11 (caso GTE 19/11): antes da compra automática, um relatório NOVO do RugCheck (sem cache). O aviso de criador com
// histórico de golpes e as 31 moedas do dev só apareceram depois da compra. Devolve o motivo para não comprar, ou null.
export function preBuyBlock(r, cfg) {
  if (!r) return null; // sem relatório agora: segue com o que já foi checado na aprovação
  const f = cfg.filtros || {};
  const risks = (r.risks || []).map((x) => `${x.name || ''} ${x.description || ''}`).join(' | ');
  if (r.rugged) return 'RugCheck marca a moeda como golpe';
  if (/creator history of rugged/i.test(risks)) return 'criador com histórico de golpes (RugCheck)';
  const n = Array.isArray(r.creatorTokens) ? r.creatorTokens.length : null;
  if (n != null && n > (f.devMaxTokensAnteriores ?? 5)) return `dev já criou ${n} moedas (máx ${f.devMaxTokensAnteriores ?? 5})`;
  if (r.score_normalised != null && r.score_normalised > (f.rugcheckScoreMax ?? 50)) return `risco no RugCheck ${r.score_normalised}/100 (máx ${f.rugcheckScoreMax ?? 50})`;
  return null;
}
export const isReentry = (t, cfg, now) => !!(t.reentry && !t.held && now - t.reentry.at < (cfg.compra?.reentradaHoras ?? 3) * 3600000);

// Moedas com sinal de boa entrada que acabou de aparecer, dentro das regras
// Parte "sólida" da nota (holders, liquidez, segurança, distribuição: 55 pontos), que não cai numa correção saudável
export function solidPts(t) {
  return (t.scoreParts || []).filter((p) => /Holders|liquidez|Segurança|Distribuição/.test(p.label)).reduce((a, p) => a + (p.pts || 0), 0);
}
// Nota que vale para a compra. Normal: a de agora. byApproval: a da aprovação (a correção que gera o sinal derruba a parte de
// "momento" da nota de agora), desde que a parte sólida siga de pé e sem insiders/concentração novos.
export function buyScoreOk(t, cfg, byApproval) {
  const min = cfg.compra?.scoreMinimo ?? 70;
  if (!byApproval) return (t.score || 0) >= min;
  if ((t.score || 0) >= min) return false; // já entra pela regra normal
  const holderAlert = (t.safety?.alerts || []).some((a) => ['insiders', 'concentracao'].includes(a.id));
  return (t.approvalScore || 0) >= min && solidPts(t) >= (cfg.simulacao?.notaAprovacao?.solidaMin ?? 30) && !holderAlert;
}
// Sinal que vale para a compra. Agressivo: o sinal normal ou, se ele não estiver "boa", o sinal do perfil agressivo
// (zona com risco/retorno 1:1,5, entrada rasa na 38,2%, rompimento de base ou rompimento curto)
function pickSignal(t, fresh, now, agr) {
  if (t.sinal?.tipo === 'entrada' && t.sinal.boa && now - (t.sinal.at || 0) <= fresh) return t.sinal;
  if (agr && t.sinalAgr?.boa && now - (t.sinalAgr.at || 0) <= fresh) return t.sinalAgr;
  return null;
}
export function entryCandidates(tokens, cfg, now, opts = {}) {
  const c = cfg.compra || {};
  const fresh = (c.sinalValidoMin ?? 10) * 60000;
  if (opts.agr) {
    // devolve cópias com o sinal escolhido em t.sinal (a simulação e a compra leem dali)
    const picked = Object.values(tokens).map((t) => { const g = pickSignal(t, fresh, now, true); return g ? { ...t, sinal: g, _agr: true, _agrTipo: g === t.sinal ? 'zona' : g.raso ? '38,2%' : g.base ? 'base' : g.fase === 'rompimento' ? 'rompimento' : 'zona 1:1,5' } : null; }).filter(Boolean);
    const okScore = (t) => (t.score || 0) >= (c.scoreMinimo ?? 60) || buyScoreOk(t, { ...cfg, compra: { ...c, scoreMinimo: 70 } }, true);
    return filterCandidates(picked, cfg, now, okScore);
  }
  const list = Object.values(tokens).filter((t) => t.sinal?.tipo === 'entrada' && (t.sinal.boa || (opts.byApproval && t.sinal.notaBaixa)) && now - (t.sinal.at || 0) <= fresh);
  return filterCandidates(list, cfg, now, (t) => buyScoreOk(t, cfg, opts.byApproval), opts.byApproval);
}
function filterCandidates(list, cfg, now, scoreOk, byApproval) {
  const c = cfg.compra || {};
  return list
    .filter((t) => t.status === 'aprovada' || (t.status === 'aguardando' && (t.score || 0) >= 75) || isReentry(t, cfg, now) || (t.favorita && securityOk(t) && (t.checks || []).length && t.checks.every((k) => k.ok !== false)))
    // reentrada: só com a liquidez ainda de pé (golpe tira a liquidez) e sem alerta de perigo
    .filter((t) => !isReentry(t, cfg, now) || !(t.entryLiquidityUsd > 0) || t.liquidityUsd >= t.entryLiquidityUsd * 0.7)
    // reentrada: segurança limpa (alertas de contrato/holders/liquidez sumindo) e sem queda maior que 80% do pico (cara de rug)
    .filter((t) => !isReentry(t, cfg, now) || (securityOk(t) && peakDropPct(t, now) < 80))
    .filter((t) => !t.held && t.safety?.level !== 'danger' && scoreOk(t))
    .filter((t) => !fakeBuys(t.periods) && !(t.compraFalsa && now - t.compraFalsa.at <= 30 * 60000)) // compras falsas de robô com o preço caindo (caso LUCIA); vale por 30 min
    .filter((t) => !byApproval || !(t.entryLiquidityUsd > 0) || t.liquidityUsd >= t.entryLiquidityUsd * 0.7)
    .filter((t) => jupOk(t, cfg))
    .filter((t) => t.dexId !== 'pumpfun') // compra de verdade nunca na curva da pump.fun (modo curva é só simulação)
    // Tempo mínimo no Radar (16/11: os 3 rugs comprados entraram 2 a 9 min depois da aprovação). Reentrada já passou por isso
    .filter((t) => isReentry(t, cfg, now) || t.favorita || now - (t.approvedAt || t.firstSeen || now) >= (c.minutosNoRadarMin ?? 0) * 60000)
    .filter((t) => !(t.shape && ['morta', 'reta'].includes(t.shape.tipo)))
    .filter((t) => (t.sinal.rr || 0) >= (cfg.simulacao?.riscoRetornoMin ?? 2))
    .sort((a, b) => (b.sinal.rr || 0) - (a.sinal.rr || 0) || (b.score || 0) - (a.score || 0));
}

// Lê o último memo de liga/desliga da carteira. memos = [{ sig, memo, at, err }] do mais novo para o mais antigo.
// verify(sig) confere que a transação foi assinada pela própria carteira (senão qualquer um poderia mandar um memo citando ela).
export async function readSwitch(memos, verify) {
  for (const m of memos || []) {
    if (m.err || !m.memo) continue;
    const r = SWITCH_RE.exec(m.memo);
    if (!r) continue;
    if (!(await verify(m.sig))) continue;
    return { on: r[1] === 'on', at: m.at, sig: m.sig };
  }
  return null;
}

// Travas da compra real: quantas posições do robô estão abertas, quantas compras hoje e quanto perdeu hoje
export function buyLimits(state, tokens, cfg, now) {
  const c = cfg.compra || {}, S = cfg.simulacao || {};
  const d0 = new Date(now - 3 * 3600000); d0.setUTCHours(0, 0, 0, 0); // meia-noite de Brasília
  const dayStart = d0.getTime() + 3 * 3600000;
  const trades = (state.trades || []).filter((x) => x.ok && x.auto);
  const todayTrades = trades.filter((x) => x.at >= dayStart);
  const open = trades.filter((x) => tokens[x.mint]?.held).length;
  // resultado das compras automáticas de hoje já encerradas: SOL que entrou nas vendas - SOL da compra
  let lossSol = 0;
  for (const x of todayTrades) {
    if (tokens[x.mint]?.held) continue;
    const ops = (state.wallet?.ops || []).filter((o) => o.mint === x.mint && o.at >= x.at - 60000);
    lossSol += ops.reduce((a, o) => a + (o.sol || 0), 0);
  }
  const base = c.solPorCompra ?? 0.05;
  const capSol = -(S.perdaMaxDiaVezesBase ?? 3) * base;
  return {
    open, today: todayTrades.length, lossSol,
    maxOpen: S.maxAbertas ?? 2, maxDay: c.maxComprasPorDia ?? 5,
    stopped: lossSol <= capSol,
    room: Math.max(0, Math.min((S.maxAbertas ?? 2) - open, (c.maxComprasPorDia ?? 5) - todayTrades.length)),
    bought: new Set(todayTrades.map((x) => x.mint)),
    // moedas já compradas hoje que saíram no stop depois da última compra: liberadas para reentrar (quantas vezes for,
    // dentro das travas do dia: abertas, compras por dia e perda máxima)
    reentryOk: new Set([...new Set(todayTrades.map((x) => x.mint))].filter((m) => (tokens[m]?.reentry?.at || 0) > Math.max(...todayTrades.filter((y) => y.mint === m).map((y) => y.at)))),
  };
}
