// Uma rodada do robô: busca, analisa, vigia as aprovadas e as da sua carteira e (se ligado) compra.
import { summarizeMarket, prefilter, analyze, scoreToken, summarizeRug, runChecks, baselineFrom, marketAlerts, rugAlerts, mergeSafety, positionFrom } from './analyze.mjs';

const RUG_CACHE_MIN = 30;   // reaproveita o relatório do RugCheck das novas por 30 min
const RECHECK_MIN = 15;     // moedas da carteira: rechecagem de segurança a cada 15 min
const RECHECK_APPROVED_MIN = 30; // aprovadas que você não comprou: a cada 30 min
const MAX_REJECTED_KEPT = 300;
const MAX_PRICE_LOOKUPS = 6;         // preços históricos buscados por rodada (o resto fica para a próxima)
const MAX_CANDLE_CALLS = 8;         // GeckoTerminal grátis aceita poucas consultas por minuto
const CANDLE_REFRESH_MIN = 15;      // aprovadas: velas atualizadas a cada 15 min (as da carteira, toda rodada)

export async function runOnce({ api, cfg, state, now = Date.now(), trader = null }) {
  const started = Date.now();
  const logs = [];
  const log = (msg, isErr = false) => {
    logs.push({ t: new Date().toISOString(), msg, erro: isErr || undefined });
    (isErr ? console.error : console.log)(msg);
  };

  state = state && typeof state === 'object' ? state : {};
  state.tokens = state.tokens || {};
  state.trades = state.trades || [];
  const tokens = state.tokens;
  const maxAgeMin = cfg.busca.idadeMaximaHoras * 60;
  const trackMs = cfg.busca.diasAcompanhando * 86400000;

  // 1. Candidatas novas
  const candidates = await api.getSolanaCandidates(log);
  for (const c of candidates) {
    const t = tokens[c.mint];
    if (!t) tokens[c.mint] = { mint: c.mint, firstSeen: now, status: 'nova', source: c.source, icon: c.icon, description: c.description, links: c.links };
    else if (!t.icon && c.icon) t.icon = c.icon;
  }

  // 2. Sua carteira (só o endereço PÚBLICO, ninguém consegue mexer nela com isso)
  const wallet = (cfg.carteira?.enderecoPublico || '').trim();
  if (wallet && api.getWalletHoldings) {
    try {
      const held = await api.getWalletHoldings(wallet);
      const heldSet = new Set(held.map((h) => h.mint));
      for (const h of held.slice(0, 40)) {
        let t = tokens[h.mint];
        if (!t) t = tokens[h.mint] = { mint: h.mint, firstSeen: now, status: 'carteira', source: 'sua carteira' };
        if (!t.held) t.heldSince = now;
        if (t.status === 'nova' || t.status === 'aguardando') t.status = 'carteira';
        t.held = true;
        t.heldAmount = h.amount;
        t.decimals = h.decimals;
      }
      for (const t of Object.values(tokens)) if (t.held && !heldSet.has(t.mint)) { t.held = false; t.soldAt = now; }
      log(`Carteira: ${held.length} moedas encontradas`);
      // Compras e vendas (para calcular preço médio e resultado)
      // v3: custo = valor da troca em si, igual à Phantom (sem taxas de rede e de criação de conta) -> relê o histórico uma vez
      state.wallet = state.wallet && state.wallet.address === wallet && state.wallet.v === 3 ? state.wallet : { address: wallet, ops: [], lastSig: null, v: 3 };
      if (api.getSolBalance) { try { state.wallet.solBalance = await api.getSolBalance(wallet); } catch {} }
      if (api.getWalletOps) {
        try {
          const r = await api.getWalletOps(wallet, state.wallet.lastSig);
          let solUsdNow = null;
          if (r.ops.length && api.getSolUsd) { try { solUsdNow = await api.getSolUsd(); } catch {} }
          // Provisório: preço do SOL de agora. O valor exato do minuto da transação é buscado logo abaixo.
          for (const o of r.ops) if (solUsdNow && !o.solUsd && now - o.at < 6 * 3600000) o.solUsd = solUsdNow;
          const seenSig = new Set(state.wallet.ops.map((o) => o.sig + o.mint));
          state.wallet.ops = [...state.wallet.ops, ...r.ops.filter((o) => !seenSig.has(o.sig + o.mint))].slice(-1500);
          state.wallet.lastSig = r.lastSig;
          state.wallet.updatedAt = now;
          if (r.ops.length) log(`Carteira: ${r.ops.length} compras/vendas novas lidas${r.pending ? ` (${r.pending} na fila)` : ''}`);
        } catch (e) { log(`Não consegui ler as transações da carteira: ${e.message}`, true); }
      }
      // Valores exatos: preço do SOL no minuto de cada transação; compras em USDC; moedas recebidas/enviadas
      // (transferência ou ordem limite executada) valem pelo preço de mercado daquele minuto.
      if (api.getPriceAt) {
        let calls = 0;
        const lookup = async (pool, at) => {
          if (calls >= MAX_PRICE_LOOKUPS) return undefined;
          if (calls++ && api.sleep) await api.sleep(6500);
          try { return await api.getPriceAt(pool, at); } catch { return undefined; }
        };
        for (const o of [...state.wallet.ops].reverse()) {
          if (calls >= MAX_PRICE_LOOKUPS) break;
          if (!o.px) {
            const v = await lookup(api.SOL_POOL, o.at);
            if (v === undefined) break;
            if (v) { o.solUsd = v; o.px = 1; } else if ((o.tries = (o.tries || 0) + 1) >= 5) o.px = 1;
            if (o.px && o.stable && o.solUsd) { o.sol += o.stable / o.solUsd; delete o.stable; }
          }
          if (o.px && !o.k && o.solUsd) {
            const moved = (o.tokens > 0 && o.sol > -0.00005) || (o.tokens < 0 && o.sol < 0.00005);
            if (!moved) { o.k = 1; continue; }
            const pool = tokens[o.mint]?.pairAddress;
            if (!pool) continue; // ainda sem par conhecido: tenta na próxima rodada
            const p = await lookup(pool, o.at);
            if (p === undefined) break;
            if (p) { o.sol = (-o.tokens * p) / o.solUsd; o.est = 1; o.k = 1; } else if ((o.tries = (o.tries || 0) + 1) >= 5) o.k = 1;
          }
        }
      }
    } catch (e) {
      log(`Não consegui ler a carteira: ${e.message}`, true);
    }
  }

  const monitored = (t) => t.held || t.status === 'carteira' || (t.status === 'aprovada' && now - (t.approvedAt || now) < trackMs);
  const active = Object.values(tokens).filter((t) => t.status === 'nova' || t.status === 'aguardando' || monitored(t));

  // 3. Dados de mercado de todas de uma vez
  const market = await api.getMarketData(active.map((t) => t.mint), log);

  // 4. Filtro rápido, vigilância de mercado e filas do RugCheck
  const rugQueue = [];
  const recheckQueue = [];
  const marketNow = new Map();
  for (const t of active) {
    const m = summarizeMarket(market.get(t.mint), now);
    t.lastChecked = now;
    if (!m) {
      if (!monitored(t)) { t.status = 'aguardando'; t.reasons = ['Ainda sem par de negociação no DexScreener']; }
      continue;
    }
    marketNow.set(t.mint, m);
    Object.assign(t, {
      symbol: m.symbol, name: m.name, priceUsd: m.priceUsd, liquidityUsd: m.liquidityUsd, mcapUsd: m.mcapUsd,
      ageMin: m.ageMin, pairCreatedAt: m.pairCreatedAt, volumeH1: m.volumeH1, volumeH24: m.volumeH24,
      buyRatioH1: m.buyRatioH1, priceChangeH1: m.priceChangeH1, priceChangeH24: m.priceChangeH24,
      pairUrl: m.pairUrl, pairAddress: m.pairAddress, dexId: m.dexId, icon: t.icon || m.icon,
      priceNative: m.priceNative, fdvUsd: m.fdvUsd, periods: m.periods, quoteSymbol: m.quoteSymbol, boosts: m.boosts,
      links: t.links && t.links.length ? t.links : m.socials,
    });

    if (monitored(t)) {
      track(t, m, now);
      if (t.held && state.wallet) {
        const myOps = state.wallet.ops.filter((o) => o.mint === t.mint);
        t.position = positionFrom(myOps, t.heldAmount || 0, m.priceNative, m.priceUsd);
        // Histórico de compras e vendas desta moeda (mais recentes primeiro)
        t.history = myOps.slice(-50).reverse().map((o) => ({ sig: o.sig, at: o.at, tokens: o.tokens, sol: o.sol, ...(o.est ? { est: 1 } : {}) }));
      }
      t.hist = [...(t.hist || []), [now, m.priceUsd]].slice(-288); // ~24h de pontos a cada 5 min
      t._mktAlerts = marketAlerts(t, m);
      t.safety = mergeSafety(t.safety, [...(t._rugAlerts || []), ...t._mktAlerts], now);
      const every = (t.held ? RECHECK_MIN : RECHECK_APPROVED_MIN) * 60000;
      if (!t._rugAt || now - t._rugAt >= every) recheckQueue.push({ t, m });
      continue;
    }

    if (m.ageMin != null && m.ageMin > maxAgeMin) {
      t.status = 'reprovada';
      t.reasons = [...(t.reasons || []), `Passou de ${cfg.busca.idadeMaximaHoras}h sem ser aprovada`].slice(-4);
      t.rejectedAt = now;
      continue;
    }
    const pre = prefilter(m, cfg);
    // Nota prévia: com o que já se sabe (mercado + RugCheck, se já houver). Ordena a lista "Observando".
    t.score = scoreToken(m, t.rug);
    t.pending = pre.length;
    if (pre.length) { t.status = 'aguardando'; t.reasons = pre; t.checks = null; continue; }
    rugQueue.push({ t, m });
  }

  let rugCalls = 0;
  let paused = false;
  const fetchRug = async (t) => {
    rugCalls++;
    const r = await api.getRugReport(t.mint);
    if (api.sleep) await api.sleep(400);
    return slimReport(r);
  };

  // 5a. Rechecagem de segurança: primeiro as da carteira, depois as aprovadas
  recheckQueue.sort((a, b) => (b.t.held ? 1 : 0) - (a.t.held ? 1 : 0));
  for (const { t, m } of recheckQueue) {
    if (paused || rugCalls >= cfg.busca.maxRugcheckPorRodada) break;
    try {
      const report = await fetchRug(t);
      t._rugAt = now;
      const sum = summarizeRug(report);
      if (!sum) continue;
      if (!t.baseline) t.baseline = baselineFrom(sum);
      t._rugAlerts = rugAlerts(t.baseline, sum, cfg);
      t.checks = runChecks(m, sum, cfg);
      t.safety = mergeSafety(t.safety, [...t._rugAlerts, ...(t._mktAlerts || [])], now);
      if (t.safety.level !== 'ok') log(`ALERTA ${t.symbol}: ${t.safety.alerts.map((a) => a.msg).join(' | ')}`);
    } catch (e) {
      log(`Rechecagem de ${t.symbol || t.mint} falhou: ${e.message}`, true);
      if (e.rateLimited) paused = true;
    }
  }

  // 5b. Novas no RugCheck (priorizando quem tem mais volume)
  rugQueue.sort((a, b) => b.m.volumeH1 - a.m.volumeH1);
  const newlyApproved = [];
  for (const { t, m } of rugQueue) {
    let report = t._rug && now - t._rugAt < RUG_CACHE_MIN * 60000 ? t._rug : null;
    if (!report) {
      if (paused || rugCalls >= cfg.busca.maxRugcheckPorRodada) { t.status = 'aguardando'; t.reasons = ['Na fila do RugCheck (próxima rodada)']; continue; }
      try {
        report = await fetchRug(t);
        t._rug = report;
        t._rugAt = now;
      } catch (e) {
        log(`RugCheck falhou para ${t.symbol || t.mint}: ${e.message}`, true);
        if (e.rateLimited) { paused = true; t.status = 'aguardando'; t.reasons = ['RugCheck pediu uma pausa, tenta na próxima rodada']; }
        continue;
      }
    }
    const res = analyze(m, report, cfg);
    t.status = res.status;
    t.checks = res.checks;
    t.reasons = res.reasons;
    t.score = res.score;
    t.rug = res.rug;
    t.pending = res.reasons.length;
    if (res.status === 'reprovada') t.rejectedAt = now;
    if (res.status === 'aprovada') {
      t.approvedAt = now;
      t.entryPriceUsd = m.priceUsd;
      t.entryMcapUsd = m.mcapUsd;
      t.entryLiquidityUsd = m.liquidityUsd;
      t.maxPriceUsd = m.priceUsd;
      t.changePct = 0;
      t.maxChangePct = 0;
      t.baseline = baselineFrom(res.summary);
      t.safety = { level: 'ok', alerts: [], checkedAt: now };
      newlyApproved.push(t);
      log(`APROVADA: ${t.symbol} (nota ${t.score})`);
    }
  }

  // 5c. Velas para o mini gráfico (aprovadas e as suas), via GeckoTerminal
  if (api.getCandles) {
    const want = Object.values(tokens)
      .filter((t) => t.pairAddress && (monitored(t) || newlyApproved.includes(t)))
      .filter((t) => t.held || !t.candlesAt || now - t.candlesAt >= CANDLE_REFRESH_MIN * 60000)
      .sort((a, b) => (b.held ? 1 : 0) - (a.held ? 1 : 0) || (a.candlesAt || 0) - (b.candlesAt || 0))
      .slice(0, MAX_CANDLE_CALLS);
    for (const t of want) {
      try {
        const c = await api.getCandles(t.pairAddress);
        if (c && c.length) { t.candles = c; t.candlesAt = now; }
      } catch (e) {
        log(`Velas de ${t.symbol} indisponíveis: ${e.message}`, true);
        if (e.rateLimited) break;
      }
      if (api.sleep) await api.sleep(6500); // respeita o limite do GeckoTerminal
    }
  }

  // 6. Compra automática (só se estiver ligada no config E no GitHub)
  if (trader && newlyApproved.length) {
    try {
      const trades = await trader.maybeBuy(newlyApproved, state, cfg, log);
      state.trades.push(...trades);
    } catch (e) {
      log(`Módulo de compra falhou: ${e.message}`, true);
    }
  }

  // 7. Limpeza
  const rejected = Object.values(tokens).filter((t) => t.status === 'reprovada').sort((a, b) => (b.rejectedAt || 0) - (a.rejectedAt || 0));
  for (const t of rejected.slice(MAX_REJECTED_KEPT)) delete tokens[t.mint];
  for (const t of Object.values(tokens)) {
    if (t.held) { delete t._rug; continue; }
    if (t.status === 'carteira' && now - (t.soldAt || t.firstSeen || now) > 86400000) delete tokens[t.mint];
    else if (t.status === 'aprovada' && now - (t.approvedAt || now) > trackMs * 3) delete tokens[t.mint];
    else if (!['aprovada', 'carteira'].includes(t.status) && now - (t.firstSeen || now) > 3 * 86400000) delete tokens[t.mint];
    else if (t.status === 'reprovada' || t.status === 'aprovada') delete t._rug;
    if (!monitored(t)) { delete t.candles; delete t.hist; }
  }
  state.trades = state.trades.slice(-200);

  const counts = Object.values(tokens).reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
  state.updatedAt = now;
  if (!wallet) delete state.wallet;
  state.lastRun = {
    at: now,
    durationMs: Date.now() - started,
    candidates: candidates.length,
    analyzed: rugQueue.length,
    rechecked: recheckQueue.length,
    rugcheckCalls: rugCalls,
    newApproved: newlyApproved.map((t) => t.symbol),
    counts,
    autoBuy: !!trader,
    wallet: wallet ? `${wallet.slice(0, 4)}...${wallet.slice(-4)}` : null,
    logs: logs.slice(-30),
  };
  return state;
}

// Acompanha o preço desde a referência (alerta de aprovação ou quando apareceu na carteira)
function track(t, m, now) {
  if (!t.entryPriceUsd) {
    t.entryPriceUsd = m.priceUsd;
    t.entryLiquidityUsd = m.liquidityUsd;
    t.entryAt = now;
  }
  t.maxPriceUsd = Math.max(t.maxPriceUsd || 0, m.priceUsd);
  t.changePct = ((m.priceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100;
  t.maxChangePct = ((t.maxPriceUsd - t.entryPriceUsd) / t.entryPriceUsd) * 100;
}

// Guarda só os campos do relatório que a análise usa (o relatório completo é enorme)
function slimReport(r) {
  if (!r) return r;
  return {
    mintAuthority: r.mintAuthority, freezeAuthority: r.freezeAuthority,
    token: r.token ? { mintAuthority: r.token.mintAuthority, freezeAuthority: r.token.freezeAuthority } : undefined,
    topHolders: (r.topHolders || []).slice(0, 20).map((h) => ({ address: h.address, owner: h.owner, pct: h.pct, insider: h.insider })),
    markets: (r.markets || []).map((mk) => ({
      pubkey: mk.pubkey, liquidityAAccount: mk.liquidityAAccount, liquidityBAccount: mk.liquidityBAccount,
      lp: mk.lp ? { lpLockedPct: mk.lp.lpLockedPct } : undefined,
    })),
    knownAccounts: r.knownAccounts, creator: r.creator, creatorTokens: r.creatorTokens,
    graphInsidersDetected: r.graphInsidersDetected, totalHolders: r.totalHolders,
    score_normalised: r.score_normalised, transferFee: r.transferFee,
    tokenMeta: r.tokenMeta ? { mutable: r.tokenMeta.mutable } : undefined,
    rugged: r.rugged, risks: r.risks, lpLockedPct: r.lpLockedPct,
  };
}
