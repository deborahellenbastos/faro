// Compra no sinal de "Boa entrada": quem pode ser comprada agora (a simulação e a compra real usam a mesma lista)
// e o interruptor que liga/desliga a compra real, mandado pelo painel como um memo assinado pela carteira.

export const SWITCH_RE = /faro:compra=(on|off)/;

// Saiu no stop há pouco e a moeda segue viva: pode reentrar se o fundo se confirmar (uma vez por moeda no dia)
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
export function entryCandidates(tokens, cfg, now, opts = {}) {
  const c = cfg.compra || {};
  const fresh = (c.sinalValidoMin ?? 10) * 60000;
  return Object.values(tokens)
    .filter((t) => t.sinal?.tipo === 'entrada' && t.sinal.boa && now - (t.sinal.at || 0) <= fresh)
    .filter((t) => t.status === 'aprovada' || (t.status === 'aguardando' && (t.score || 0) >= 75) || isReentry(t, cfg, now))
    // reentrada: só com a liquidez ainda de pé (golpe tira a liquidez) e sem alerta de perigo
    .filter((t) => !isReentry(t, cfg, now) || !(t.entryLiquidityUsd > 0) || t.liquidityUsd >= t.entryLiquidityUsd * 0.7)
    .filter((t) => !t.held && t.safety?.level !== 'danger' && buyScoreOk(t, cfg, opts.byApproval))
    .filter((t) => !opts.byApproval || !(t.entryLiquidityUsd > 0) || t.liquidityUsd >= t.entryLiquidityUsd * 0.7)
    .filter((t) => t.dexId !== 'pumpfun') // compra de verdade nunca na curva da pump.fun (modo curva é só simulação)
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
