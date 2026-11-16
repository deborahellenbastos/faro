// Análise de uma moeda: os 6 pontos do checklist + alertas do RugCheck + força de compra.
// Funções puras (sem internet), para poderem ser testadas com dados simulados.

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const fmtPct = (v) => `${num(v).toFixed(1)}%`;
const fmtUsd = (v) => {
  const n = num(v);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
};

// Escolhe o par com mais liquidez de uma moeda no DexScreener e resume os dados de mercado
export function summarizeMarket(pairs, now = Date.now()) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const best = [...pairs].sort((a, b) => num(b?.liquidity?.usd) - num(a?.liquidity?.usd))[0];
  const created = num(best.pairCreatedAt, 0);
  const buysH1 = num(best?.txns?.h1?.buys);
  const sellsH1 = num(best?.txns?.h1?.sells);
  return {
    symbol: best?.baseToken?.symbol || '?',
    name: best?.baseToken?.name || '',
    priceUsd: num(best.priceUsd),
    liquidityUsd: num(best?.liquidity?.usd),
    mcapUsd: num(best.marketCap, num(best.fdv)),
    pairCreatedAt: created || null,
    ageMin: created ? Math.max(0, (now - created) / 60000) : null,
    volumeH1: num(best?.volume?.h1),
    volumeH24: num(best?.volume?.h24),
    buysH1,
    sellsH1,
    buyRatioH1: buysH1 + sellsH1 > 0 ? (buysH1 / (buysH1 + sellsH1)) * 100 : 0,
    priceChangeH1: num(best?.priceChange?.h1),
    priceChangeH24: num(best?.priceChange?.h24),
    quoteSymbol: best?.quoteToken?.symbol || 'SOL',
    boosts: num(best?.boosts?.active),
    priceNative: num(best.priceNative),
    fdvUsd: num(best.fdv),
    periods: Object.fromEntries(['m5', 'h1', 'h6', 'h24'].map((k) => [k, {
      chg: num(best?.priceChange?.[k]),
      buys: num(best?.txns?.[k]?.buys),
      sells: num(best?.txns?.[k]?.sells),
      vol: num(best?.volume?.[k]),
    }])),
    pairUrl: best.url || null,
    pairAddress: best.pairAddress || null,
    dexId: best.dexId || null,
    icon: best?.info?.imageUrl || null,
    socials: [...(best?.info?.websites || []), ...(best?.info?.socials || [])]
      .map((s) => ({ label: s.label || s.type || 'link', url: s.url }))
      .filter((s) => s.url)
      .slice(0, 4),
  };
}

// Filtro rápido só com dados de mercado (antes de gastar uma consulta no RugCheck).
// Retorna lista de motivos. Todos são "temporários": podem mudar nas próximas rodadas.
export function prefilter(m, cfg) {
  const f = cfg.filtros;
  const b = cfg.busca;
  const reasons = [];
  if (m.ageMin == null) reasons.push('Sem data de criação do par');
  else if (m.ageMin < b.idadeMinimaMinutos) reasons.push(`Muito nova (${m.ageMin.toFixed(0)} min), aguardando ${b.idadeMinimaMinutos} min`);
  if (m.liquidityUsd < f.liquidezMinimaUsd) reasons.push(`Liquidez baixa (${fmtUsd(m.liquidityUsd)})`);
  if (m.mcapUsd < f.marketCapMinimoUsd) reasons.push(`Market cap baixo (${fmtUsd(m.mcapUsd)})`);
  if (m.mcapUsd > f.marketCapMaximoUsd) reasons.push(`Market cap acima do limite (${fmtUsd(m.mcapUsd)})`);
  if (m.volumeH1 < f.volumeH1MinUsd) reasons.push(`Pouco volume na última hora (${fmtUsd(m.volumeH1)})`);
  if (m.buyRatioH1 < f.comprasSobreTotalH1MinPct) reasons.push(`Mais vendas que compras na última hora (${fmtPct(m.buyRatioH1)} compras)`);
  return reasons;
}

// Extrai do relatório do RugCheck o que importa, de forma defensiva (campos podem faltar)
export function summarizeRug(r) {
  if (!r || typeof r !== 'object') return null;
  const known = r.knownAccounts || {};
  const markets = Array.isArray(r.markets) ? r.markets : [];

  // Contas que são pools / travas de liquidez: não contam como "holder"
  const excluded = new Set();
  for (const mk of markets) {
    for (const k of ['pubkey', 'liquidityAAccount', 'liquidityBAccount', 'liquidityA', 'liquidityB']) {
      if (typeof mk?.[k] === 'string') excluded.add(mk[k]);
    }
  }
  for (const [addr, info] of Object.entries(known)) {
    const t = String(info?.type || '').toUpperCase();
    if (t === 'AMM' || t === 'LOCKER') excluded.add(addr);
  }

  let creator = r.creator || null;
  if (!creator) {
    const c = Object.entries(known).find(([, i]) => String(i?.type || '').toUpperCase() === 'CREATOR');
    if (c) creator = c[0];
  }

  const holders = (Array.isArray(r.topHolders) ? r.topHolders : [])
    .filter((h) => !excluded.has(h?.address) && !excluded.has(h?.owner))
    .map((h) => ({ address: h.address, owner: h.owner, pct: num(h.pct), insider: !!h.insider }))
    .sort((a, b) => b.pct - a.pct);

  const top10Pct = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const maxHolderPct = holders.length ? holders[0].pct : 0;
  const devPct = creator ? holders.filter((h) => h.owner === creator || h.address === creator).reduce((s, h) => s + h.pct, 0) : null;
  const insiderHolders = holders.filter((h) => h.insider).length;

  const lpPcts = markets.map((mk) => num(mk?.lp?.lpLockedPct, NaN)).filter(Number.isFinite);
  const lpLockedPct = lpPcts.length ? Math.max(...lpPcts) : Number.isFinite(Number(r.lpLockedPct)) ? Number(r.lpLockedPct) : null;

  const risks = (Array.isArray(r.risks) ? r.risks : []).map((x) => ({
    name: x.name,
    level: x.level,
    value: x.value || '',
    description: x.description || '',
  }));

  return {
    mintAuthority: r.mintAuthority ?? r.token?.mintAuthority ?? null,
    freezeAuthority: r.freezeAuthority ?? r.token?.freezeAuthority ?? null,
    lpLockedPct,
    top10Pct,
    maxHolderPct,
    insiders: Math.max(num(r.graphInsidersDetected), insiderHolders),
    creator,
    devPct,
    devPreviousTokens: Array.isArray(r.creatorTokens) ? r.creatorTokens.length : null,
    totalHolders: r.totalHolders != null ? num(r.totalHolders) : null,
    scoreNormalised: r.score_normalised != null ? num(r.score_normalised) : null,
    transferFeePct: num(r.transferFee?.pct),
    mutableMetadata: r.tokenMeta?.mutable === true,
    rugged: r.rugged === true,
    dangerRisks: risks.filter((x) => x.level === 'danger'),
    warnRisks: risks.filter((x) => x.level === 'warn'),
  };
}

// Os 6 pontos + extras. ok: true (passou), false (reprovou), null (sem dados, olhar manualmente)
export function runChecks(m, rug, cfg) {
  const f = cfg.filtros;
  const checks = [];
  const add = (id, label, ok, detail, permanent = true) => checks.push({ id, label, ok, detail, permanent });

  add('mint', '1. Mint revogada', rug.mintAuthority == null,
    rug.mintAuthority == null ? 'Ninguém pode criar mais tokens' : 'O criador ainda pode emitir tokens novos');

  add('freeze', '2. Freeze revogada', rug.freezeAuthority == null,
    rug.freezeAuthority == null ? 'Ninguém pode congelar sua carteira' : 'O criador pode congelar carteiras e impedir a venda');

  // Regra obrigatória: sem confirmação de liquidez travada/queimada, não aprova.
  // Não é permanente: a liquidez pode ser travada ou queimada depois, então a moeda volta a ser checada.
  if (rug.lpLockedPct == null) add('lp', '3. Liquidez travada/queimada', false, 'Sem confirmação de que a liquidez está travada', false);
  else add('lp', '3. Liquidez travada/queimada', rug.lpLockedPct >= f.lpTravadaMinPct,
    `${fmtPct(rug.lpLockedPct)} travada (mínimo ${f.lpTravadaMinPct}%)`, false);

  const holderProblems = [];
  if (rug.top10Pct > f.top10MaxPct) holderProblems.push(`top 10 com ${fmtPct(rug.top10Pct)} (máx ${f.top10MaxPct}%)`);
  if (rug.maxHolderPct > f.maiorHolderMaxPct) holderProblems.push(`maior carteira com ${fmtPct(rug.maxHolderPct)} (máx ${f.maiorHolderMaxPct}%)`);
  if (rug.insiders > f.insidersMax) holderProblems.push(`${rug.insiders} carteiras ligadas entre si (insiders)`);
  if (rug.totalHolders != null && rug.totalHolders < f.holdersMin) holderProblems.push(`só ${rug.totalHolders} holders (mín ${f.holdersMin})`);
  add('holders', '4. Holders bem distribuídos', holderProblems.length === 0,
    holderProblems.length ? holderProblems.join('; ') : `Top 10 com ${fmtPct(rug.top10Pct)}, sem insiders detectados`,
    false);

  const devProblems = [];
  let devOk = true;
  if (rug.devPct == null) devOk = null;
  else if (rug.devPct > f.devMaxPct) { devOk = false; devProblems.push(`dev segura ${fmtPct(rug.devPct)} (máx ${f.devMaxPct}%)`); }
  if (rug.devPreviousTokens != null && rug.devPreviousTokens > f.devMaxTokensAnteriores) {
    devOk = false;
    devProblems.push(`dev já criou ${rug.devPreviousTokens} moedas (máx ${f.devMaxTokensAnteriores})`);
  }
  const devHist = rug.devPreviousTokens == null ? 'histórico: conferir no GMGN' : `${rug.devPreviousTokens} moedas anteriores`;
  add('dev', '5. Dev limpo', devOk,
    devProblems.length ? devProblems.join('; ') : rug.devPct == null ? `Carteira do dev não identificada; ${devHist}` : `Dev segura ${fmtPct(rug.devPct)}; ${devHist}`,
    false);

  const liqRatio = m.mcapUsd > 0 ? (m.liquidityUsd / m.mcapUsd) * 100 : 0;
  add('liquidez', '6. Liquidez saudável', m.liquidityUsd >= f.liquidezMinimaUsd && liqRatio >= f.liquidezSobreMarketCapMinPct,
    `${fmtUsd(m.liquidityUsd)} de liquidez para ${fmtUsd(m.mcapUsd)} de market cap (${fmtPct(liqRatio)}, mín ${f.liquidezSobreMarketCapMinPct}%)`,
    false);

  const rcProblems = [];
  if (rug.rugged) rcProblems.push('RugCheck marcou como RUGADA');
  if (rug.transferFeePct > 0) rcProblems.push(`taxa escondida de ${fmtPct(rug.transferFeePct)} em cada transferência`);
  for (const d of rug.dangerRisks) rcProblems.push(d.name);
  if (rug.scoreNormalised != null && rug.scoreNormalised > f.rugcheckScoreMax) rcProblems.push(`risco ${rug.scoreNormalised}/100 (máx ${f.rugcheckScoreMax})`);
  const warns = rug.warnRisks.map((w) => w.name);
  if (rug.mutableMetadata) warns.push('Metadados podem ser alterados');
  add('rugcheck', 'Sem alertas graves no RugCheck', rcProblems.length === 0,
    rcProblems.length ? rcProblems.join('; ') : warns.length ? `Avisos leves: ${warns.join('; ')}` : `Risco ${rug.scoreNormalised ?? '?'}/100`);

  return checks;
}

// Nota de 0 a 100 para ordenar as aprovadas (segurança + força de compra)
export function scoreToken(m, rug) {
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const buyPressure = clamp((m.buyRatioH1 - 50) / 25); // 50% compras = 0, 75%+ = 1
  const volVsLiq = clamp(m.volumeH1 / Math.max(1, m.liquidityUsd) / 1.5); // girou 1,5x a liquidez em 1h = 1
  const trend = clamp(m.priceChangeH1 / 50); // +50% na hora = 1 (negativo = 0)
  rug = rug || {};
  const holders = rug.totalHolders ? clamp(Math.log10(rug.totalHolders) / 3.5) : 0.3; // ~3000 holders = 1
  const liq = clamp(Math.log10(Math.max(1, m.liquidityUsd)) / 6); // $1M = 1
  const safety = rug.scoreNormalised != null ? clamp(1 - rug.scoreNormalised / 100) : 0.5;
  const distribution = rug.top10Pct != null ? clamp(1 - rug.top10Pct / 40) : 0.5; // sem RugCheck ainda: neutro
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const s = n(buyPressure) * 20 + n(volVsLiq) * 15 + n(trend) * 10 + n(holders) * 15 + n(liq) * 10 + n(safety) * 15 + n(distribution) * 15;
  return Math.round(s);
}

// A mesma nota, peça por peça (o painel mostra "por que essa nota")
export function scoreParts(m, rug) {
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const n = (v) => (Number.isFinite(v) ? v : 0);
  rug = rug || {};
  const pct = (v) => `${Math.round(n(v))}%`;
  const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${Math.round(n(v))}`);
  const p = (label, max, frac, why) => ({ label, max, pts: Math.round(n(frac) * max), why });
  return [
    p('Força de compra', 20, clamp((m.buyRatioH1 - 50) / 25), `${pct(m.buyRatioH1)} das negociações da última hora foram compras (75%+ = nota cheia)`),
    p('Giro de volume', 15, clamp(m.volumeH1 / Math.max(1, m.liquidityUsd) / 1.5), `volume de ${usd(m.volumeH1)} na hora para ${usd(m.liquidityUsd)} de liquidez (1,5x = nota cheia)`),
    p('Tendência', 10, clamp(m.priceChangeH1 / 50), `preço ${m.priceChangeH1 >= 0 ? '+' : ''}${Math.round(n(m.priceChangeH1))}% na última hora (+50% = nota cheia)`),
    p('Holders', 15, rug.totalHolders ? clamp(Math.log10(rug.totalHolders) / 3.5) : 0.3, rug.totalHolders ? `${rug.totalHolders} carteiras (~3.000 = nota cheia)` : 'ainda sem dados do RugCheck'),
    p('Tamanho da liquidez', 10, clamp(Math.log10(Math.max(1, m.liquidityUsd)) / 6), `${usd(m.liquidityUsd)} (US$ 1M = nota cheia)`),
    p('Segurança (RugCheck)', 15, rug.scoreNormalised != null ? clamp(1 - rug.scoreNormalised / 100) : 0.5, rug.scoreNormalised != null ? `risco ${rug.scoreNormalised}/100 no RugCheck (0 = nota cheia)` : 'ainda sem dados do RugCheck'),
    p('Distribuição', 15, rug.top10Pct != null ? clamp(1 - rug.top10Pct / 40) : 0.5, rug.top10Pct != null ? `top 10 carteiras com ${pct(rug.top10Pct)} (quanto menos, melhor)` : 'ainda sem dados do RugCheck'),
  ];
}

// Formato do gráfico (velas de 5 min: [ms, abre, máx, mín, fecha, vol])
//  - morta: caiu 50%+ do topo e o topo ficou para trás há 30 min ou mais
//  - reta: subiu 150%+ sem nenhuma correção de 10% no caminho (desenho típico de rug)
//  - organica: sobe, corrige (recuos de 10%+) e segura acima de 60% do topo
//  - lateral / nova: o resto, ou pouca vela para dizer
export function chartShape(c) {
  if (!Array.isArray(c) || c.length < 6) return { tipo: 'nova', msg: 'Pouco gráfico ainda para avaliar o formato' };
  let iHi = 0; c.forEach((x, i) => { if (x[2] >= c[iHi][2]) iHi = i; });
  const hi = c[iHi][2], last = c[c.length - 1][4];
  const fromTop = (1 - last / hi) * 100;
  const minsSinceTop = (c[c.length - 1][0] - c[iHi][0]) / 60000;
  let iLo = 0; for (let i = 0; i <= iHi; i++) if (c[i][3] <= c[iLo][3]) iLo = i;
  const lo = c[iLo][3], rise = lo > 0 ? (hi / lo - 1) * 100 : 0;
  // maior correção durante a subida (do fundo até o topo)
  let peak = 0, pull = 0;
  for (let i = iLo; i <= iHi; i++) { peak = Math.max(peak, c[i][2]); pull = Math.max(pull, (1 - c[i][3] / peak) * 100); }
  const p0 = (v) => `${Math.round(v)}%`;
  if (fromTop >= 50 && minsSinceTop >= 30) return { tipo: 'morta', msg: `Já passou do auge: está ${p0(fromTop)} abaixo do topo de ${Math.round(minsSinceTop)} min atrás` };
  if (rise >= 150 && pull < 10 && iHi - iLo >= 4) return { tipo: 'reta', msg: `Subiu ${p0(rise)} em linha reta, sem correção (maior recuo ${p0(pull)}): cara de rug` };
  if (rise >= 30 && pull >= 10 && fromTop <= 40) return { tipo: 'organica', msg: `Sobe e corrige (recuos de até ${p0(pull)}), ${p0(fromTop)} abaixo do topo` };
  return { tipo: 'lateral', msg: `Sem tendência clara (${p0(fromTop)} abaixo do topo)` };
}
export const SHAPE_LABEL = { morta: 'Morta', reta: 'Subida reta', organica: 'Orgânica', lateral: 'Lateral', nova: 'Nova' };

// Junta tudo e decide o status
export function analyze(m, rugReport, cfg) {
  const rug = summarizeRug(rugReport);
  if (!rug) return { status: 'aguardando', reasons: ['RugCheck sem resposta, tenta de novo na próxima rodada'], checks: [], permanent: false };
  const checks = runChecks(m, rug, cfg);
  const failed = checks.filter((c) => c.ok === false);
  const permanent = failed.some((c) => c.permanent);
  const status = failed.length === 0 ? 'aprovada' : permanent ? 'reprovada' : 'aguardando';
  return {
    status,
    permanent,
    checks,
    reasons: failed.map((c) => `${c.label.replace(/^\d\.\s*/, '')}: ${c.detail}`),
    score: scoreToken(m, rug),
    scoreParts: scoreParts(m, rug),
    summary: rug,
    rug: {
      scoreNormalised: rug.scoreNormalised,
      totalHolders: rug.totalHolders,
      top10Pct: rug.top10Pct,
      lpLockedPct: rug.lpLockedPct,
      creator: rug.creator,
    },
  };
}

// ---------- Monitoramento depois da aprovação / compra ----------

// Foto da segurança no momento da aprovação (ou da 1ª checagem de uma moeda da carteira)
export function baselineFrom(sum) {
  return {
    lpLockedPct: sum.lpLockedPct, top10Pct: sum.top10Pct, maxHolderPct: sum.maxHolderPct,
    devPct: sum.devPct, insiders: sum.insiders, scoreNormalised: sum.scoreNormalised,
    dangerNames: sum.dangerRisks.map((d) => d.name),
    mint: sum.mintAuthority != null, freeze: sum.freezeAuthority != null,
  };
}

// Sinais de golpe no contrato que MUDARAM depois da compra (o que já era assim na compra não conta).
// É isso que dispara a venda automática de 100%.
export function scamSignals(base, sum, cfg) {
  if (!base || !sum) return [];
  const f = cfg.filtros;
  const out = [];
  if (sum.rugged) out.push('RugCheck marcou como rugada');
  if (base.mint === false && sum.mintAuthority != null) out.push('mint authority reativada (podem criar tokens novos)');
  if (base.freeze === false && sum.freezeAuthority != null) out.push('freeze authority reativada (podem congelar sua carteira)');
  if (base.lpLockedPct != null && base.lpLockedPct >= f.lpTravadaMinPct && sum.lpLockedPct != null && sum.lpLockedPct < f.lpTravadaMinPct) {
    out.push(`liquidez destravada (era ${base.lpLockedPct.toFixed(0)}%, agora ${sum.lpLockedPct.toFixed(0)}%)`);
  }
  if (base.devPct != null && base.devPct >= 1 && sum.devPct != null && sum.devPct <= base.devPct * 0.5) {
    out.push(`dev vendeu mais da metade (tinha ${base.devPct.toFixed(1)}%, agora ${sum.devPct.toFixed(1)}%)`);
  }
  return out;
}

// Alertas a partir do mercado (roda toda rodada, não gasta RugCheck)
export function marketAlerts(t, m) {
  const out = [];
  if (t.entryLiquidityUsd) {
    const drop = (1 - m.liquidityUsd / t.entryLiquidityUsd) * 100;
    if (drop >= 80) out.push({ id: 'liq-sumiu', level: 'danger', msg: `Liquidez sumiu (-${drop.toFixed(0)}%). Possível rug` });
    else if (drop >= 50) out.push({ id: 'liq-caiu', level: 'danger', msg: `Liquidez caiu ${drop.toFixed(0)}% desde a referência` });
  }
  if (t.maxPriceUsd && m.priceUsd) {
    const fromTop = (1 - m.priceUsd / t.maxPriceUsd) * 100;
    if (fromTop >= 50) out.push({ id: 'preco-topo', level: 'warn', msg: `Preço ${fromTop.toFixed(0)}% abaixo da máxima` });
  }
  if (m.buysH1 + m.sellsH1 >= 30 && m.buyRatioH1 < 35) {
    out.push({ id: 'vendas', level: 'warn', msg: `Vendas dominando a última hora (só ${m.buyRatioH1.toFixed(0)}% compras)` });
  }
  return out;
}

// Alertas comparando o RugCheck de agora com a foto da aprovação
export function rugAlerts(base, sum, cfg) {
  const f = cfg.filtros;
  const out = [];
  if (sum.rugged) out.push({ id: 'rugged', level: 'danger', msg: 'RugCheck marcou como RUGADA' });
  if (sum.mintAuthority != null) out.push({ id: 'mint', level: 'danger', msg: 'Mint authority ativa: podem emitir tokens novos' });
  if (sum.freezeAuthority != null) out.push({ id: 'freeze', level: 'danger', msg: 'Freeze authority ativa: podem congelar sua carteira' });
  if (sum.lpLockedPct == null || sum.lpLockedPct < f.lpTravadaMinPct) {
    out.push({ id: 'lp', level: 'danger', msg: sum.lpLockedPct == null ? 'Não dá mais para confirmar a liquidez travada' : `Liquidez destravada: só ${sum.lpLockedPct.toFixed(0)}% travada` });
  }
  const newDanger = sum.dangerRisks.map((d) => d.name).filter((n) => !(base?.dangerNames || []).includes(n));
  if (newDanger.length) out.push({ id: 'risco-novo', level: 'danger', msg: `Novo alerta grave no RugCheck: ${newDanger.join('; ')}` });
  if (base) {
    if (base.devPct != null && sum.devPct != null && base.devPct - sum.devPct >= 1) {
      out.push({ id: 'dev-vendendo', level: 'danger', msg: `Dev vendendo: tinha ${base.devPct.toFixed(1)}%, agora ${sum.devPct.toFixed(1)}%` });
    }
    if (sum.top10Pct - base.top10Pct >= 10 || (sum.top10Pct > f.top10MaxPct && base.top10Pct <= f.top10MaxPct)) {
      out.push({ id: 'concentracao', level: 'warn', msg: `Holders concentrando: top 10 foi de ${base.top10Pct.toFixed(0)}% para ${sum.top10Pct.toFixed(0)}%` });
    }
    if (sum.insiders > (base.insiders || 0)) {
      out.push({ id: 'insiders', level: 'warn', msg: `Apareceram ${sum.insiders} carteiras ligadas entre si (insiders)` });
    }
  }
  if (sum.scoreNormalised != null && sum.scoreNormalised > f.rugcheckScoreMax) {
    out.push({ id: 'score', level: 'warn', msg: `Risco no RugCheck subiu para ${sum.scoreNormalised}/100` });
  }
  return out;
}

// Junta os alertas, mantendo a hora em que cada um apareceu pela primeira vez
export function mergeSafety(prev, alerts, now) {
  const firstSeen = new Map((prev?.alerts || []).map((a) => [a.id, a.at]));
  const list = alerts.map((a) => ({ ...a, at: firstSeen.get(a.id) || a.at || now }));
  // 'info' (ex.: o robô vendeu numa queda de preço) não muda o nível de risco da moeda
  const level = list.some((a) => a.level === 'danger') ? 'danger' : list.some((a) => a.level === 'warn') ? 'warn' : 'ok';
  return { level, alerts: list, checkedAt: now };
}

// ---------- Sua operação (a partir das transações da carteira) ----------
const soldTokensFor = (sells) => sells.reduce((a, o) => a - o.tokens, 0);
export function positionFrom(ops, heldAmount, priceNative, priceUsd) {
  const solUsd = priceNative > 0 ? priceUsd / priceNative : null;
  const valueSol = heldAmount * (priceNative || 0);
  const base = { amount: heldAmount, valueSol, valueUsd: solUsd ? valueSol * solUsd : null, solUsd };
  const buys = (ops || []).filter((o) => o.tokens > 0 && o.sol < 0);
  const sells = (ops || []).filter((o) => o.tokens < 0 && o.sol > 0);
  if (!buys.length) return { ...base, known: false };
  const spentSol = buys.reduce((a, o) => a - o.sol, 0);
  const bought = buys.reduce((a, o) => a + o.tokens, 0);
  const receivedSol = sells.reduce((a, o) => a + o.sol, 0);
  const prices = buys.map((o) => -o.sol / o.tokens);
  const avg = spentSol / bought;
  const pnlSol = valueSol + receivedSol - spentSol;
  const usd = (v) => (solUsd ? v * solUsd : null);
  // Em dólar, cada compra/venda vale pelo preço do SOL da hora em que aconteceu (quando conhecido)
  const atUsd = (o) => Math.abs(o.sol) * (o.solUsd || solUsd || 0);
  const spentUsdHist = buys.reduce((a, o) => a + atUsd(o), 0);
  const receivedUsdHist = sells.reduce((a, o) => a + atUsd(o), 0);
  const avgUsd = spentUsdHist / (buys.reduce((a, o) => a + o.tokens, 0) || 1);
  // Realizado: o que já foi vendido, comparado com o preço médio de compra
  const soldTokens = sells.reduce((a, o) => a - o.tokens, 0);
  const realizedSol = receivedSol - soldTokens * avg;
  // Em aberto: o que você ainda tem, comparado com o preço médio
  const costOpenSol = heldAmount * avg;
  const openPnlSol = valueSol - costOpenSol;
  return {
    ...base, known: true,
    realizedSol, realizedUsd: receivedUsdHist - soldTokensFor(sells) * avgUsd,
    receivedUsd: receivedUsdHist,
    costOpenSol, costOpenUsd: heldAmount * avgUsd,
    openPnlSol,
    openPnlUsd: solUsd ? valueSol * solUsd - heldAmount * avgUsd : null,
    openPnlPct: heldAmount * avgUsd > 0 && solUsd ? ((valueSol * solUsd - heldAmount * avgUsd) / (heldAmount * avgUsd)) * 100 : 0,
    spentSol, spentUsd: spentUsdHist, receivedSol,
    avgPriceSol: avg, avgPriceUsd: avgUsd,
    minPriceUsd: usd(Math.min(...prices)), maxPriceUsd: usd(Math.max(...prices)),
    pnlSol, pnlUsd: solUsd ? valueSol * solUsd + receivedUsdHist - spentUsdHist : null,
    pnlPct: spentUsdHist ? ((valueSol * (solUsd || 0) + receivedUsdHist - spentUsdHist) / spentUsdHist) * 100 : 0,
    buys: buys.length, sells: sells.length,
    firstBuyAt: Math.min(...buys.map((o) => o.at)), lastBuyAt: Math.max(...buys.map((o) => o.at)),
  };
}
