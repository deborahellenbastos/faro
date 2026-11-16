// Uma rodada do robô: busca, analisa, vigia as aprovadas e as da sua carteira e (se ligado) compra.
import { simStep } from './sim.mjs';
import { entryCandidates, readSwitch, buyLimits } from './autobuy.mjs';
import { entrySignal, exitSignal, trailStop } from './signals.mjs';
import { summarizeMarket, prefilter, analyze, scoreToken, scoreParts, chartShape, scamSignals, isLpSignal, summarizeRug, runChecks, baselineFrom, marketAlerts, rugAlerts, mergeSafety, positionFrom } from './analyze.mjs';

const RUG_CACHE_MIN = 30;   // reaproveita o relatório do RugCheck das novas por 30 min
const RECHECK_MIN = 5;      // moedas da carteira: rechecagem de segurança toda rodada (5 min)
const RECHECK_APPROVED_MIN = 30; // aprovadas que você não comprou: a cada 30 min
const MAX_REJECTED_KEPT = 300;
const MAX_PRICE_LOOKUPS = 6;         // preços históricos buscados por rodada (o resto fica para a próxima)
const MAX_CANDLE_CALLS = 8;         // GeckoTerminal grátis aceita poucas consultas por minuto
const CANDLE_REFRESH_MIN = 5;       // radar e carteira: velas novas a cada rodada, para o sinal de entrada e saída sair na hora

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

  const simOpen = new Set((state.sim?.open || []).map((o) => o.mint));
  const monitored = (t) => t.held || simOpen.has(t.mint) || t.status === 'carteira' || (t.status === 'aprovada' && now - (t.approvedAt || now) < trackMs);
  const active = Object.values(tokens).filter((t) => t.status === 'nova' || t.status === 'aguardando' || monitored(t));

  // 3. Dados de mercado de todas de uma vez
  const market = await api.getMarketData(active.map((t) => t.mint), log);

  // 4. Filtro rápido, vigilância de mercado e filas do RugCheck
  const rugQueue = [];
  const recheckQueue = [];
  const marketNow = new Map();
  let lpFlips = 0;
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
      // Nota atualizada toda rodada com o mercado de agora; perigo zera a nota
      if (t.rug) { t.score = t.safety.level === 'danger' ? 0 : scoreToken(m, t.rug); t.scoreParts = scoreParts(m, t.rug); }
      // Aprovada que virou perigo (rug, despejo...): sai do radar e vai para as reprovadas
      if (!t.held && t.status === 'aprovada' && t.safety.level === 'danger') {
        t.status = 'reprovada'; t.rejectedAt = now;
        t.reasons = [`Virou perigo depois da aprovação: ${t.safety.alerts.filter((a) => a.level === 'danger').map((a) => a.msg).join('; ')}`];
        log(`SAIU DO RADAR: ${t.symbol} (${t.reasons[0]})`);
        continue;
      }
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
    t.scoreParts = scoreParts(m, t.rug);
    t.pending = pre.length;
    if (pre.length) { t.status = 'aguardando'; t.reasons = pre; t.checks = null; continue; }
    rugQueue.push({ t, m });
  }

  let rugCalls = 0;
  let shapeCalls = 0;
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
      // LP "destravada" com a liquidez estável no mercado: provavelmente falha do RugCheck, vira só atenção
      { const ld = t.entryLiquidityUsd > 0 ? (1 - m.liquidityUsd / t.entryLiquidityUsd) * 100 : 0;
        if (ld < 15) t._rugAlerts = t._rugAlerts.map((a) => (a.id === 'lp' ? { ...a, level: 'warn', msg: `${a.msg} (a liquidez no mercado não caiu: pode ser falha do RugCheck)` } : a)); }
      t.checks = runChecks(m, sum, cfg);
      t.safety = mergeSafety(t.safety, [...t._rugAlerts, ...(t._mktAlerts || [])], now);
      if (t.safety.level !== 'ok') log(`ALERTA ${t.symbol}: ${t.safety.alerts.map((a) => a.msg).join(' | ')}`);
      // Venda automática de 100% quando o contrato muda para golpe (só com tudo ligado)
      let scam = t.held ? scamSignals(t.baseline, sum, cfg) : [];
      // LP destravada: só vale com a liquidez caindo 15%+ e se não for várias moedas ao mesmo tempo (falha do RugCheck)
      if (scam.some(isLpSignal)) {
        lpFlips++;
        const liqDrop = t.entryLiquidityUsd > 0 ? (1 - m.liquidityUsd / t.entryLiquidityUsd) * 100 : 0;
        if (liqDrop < 15 || lpFlips > 1) { log(`${t.symbol}: RugCheck diz liquidez destravada, mas a liquidez no mercado não caiu (${liqDrop.toFixed(0)}%)${lpFlips > 1 ? ' e aconteceu com várias moedas juntas' : ''}. Ignorado.`); scam = scam.filter((x) => !isLpSignal(x)); }
      }
      // Só vale vender se sobrar pelo menos o valor mínimo (senão as taxas comem tudo)
      const minUsd = cfg.venda?.valorMinimoUsd ?? 1;
      // Operação pequena (investiu ou vale menos de US$ 1): não vende sozinho, a taxa não compensa e ela pode ter um bump
      const worth = Math.min((t.heldAmount || 0) * (m.priceUsd || 0), t.position?.known && t.position.costOpenUsd > 0 ? t.position.costOpenUsd : Infinity);
      if (scam.length && trader?.canSell && !(t.autoSell?.ok) && worth < minUsd) {
        if (!t.autoSell?.skipped) log(`GOLPE em ${t.symbol}, mas a operação é de só US$ ${worth.toFixed(2)} (mínimo US$ ${minUsd}). Não vendi.`);
        t.autoSell = { ok: false, skipped: true, at: now, why: scam.join('; '), worth };
      }
      if (scam.length && trader?.canSell && !(t.autoSell?.ok) && worth >= minUsd && (t.autoSell?.tries || 0) < 3) {
        const why = scam.join('; ');
        log(`GOLPE em ${t.symbol}: ${why}. Vendendo 100%...`, true);
        try {
          const r = await trader.sellAll(t.mint);
          t.autoSell = { ok: true, at: now, sig: r.sig, outSol: r.outSol, why };
          log(r.nada ? `Nada de ${t.symbol} para vender (já vendida).` : `VENDEU 100% de ${t.symbol} por ${r.outSol.toFixed(4)} SOL (tx ${r.sig.slice(0, 8)}...)`);
        } catch (e) {
          t.autoSell = { ok: false, at: now, tries: (t.autoSell?.tries || 0) + 1, why, erro: e.message };
          log(`Venda automática de ${t.symbol} falhou: ${e.message}`, true);
        }
      }
      if (t.autoSell) {
        const a = t.autoSell;
        const alert = a.skipped
          ? { id: 'auto-venda', level: 'info', at: a.at, msg: `Golpe no contrato (${a.why}), mas a operação é menor que US$ ${cfg.venda?.valorMinimoUsd ?? 1}: não compensa vender` }
          : a.ok
          ? { id: 'auto-venda', level: 'danger', at: a.at, msg: `Robô vendeu 100% automaticamente${a.outSol ? ` por ${a.outSol.toFixed(4)} SOL` : ''}. Motivo: ${a.why}`, sig: a.sig }
          : { id: 'auto-venda', level: 'danger', at: a.at, msg: `Tentei vender 100% (${a.why}) e falhou: ${a.erro}. Venda manualmente!` };
        t.safety = mergeSafety(t.safety, [alert, ...t.safety.alerts.filter((x) => x.id !== 'auto-venda')], now);
      }
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
    // Passou em tudo: antes de aprovar, olha o desenho do gráfico (morta ou subida reta = fora)
    if (res.status === 'aprovada' && t.pairAddress && api.getCandles) {
      try {
        if (shapeCalls++ && api.sleep) await api.sleep(6500);
        const c = await (api.getCandlesFor ? api.getCandlesFor(t.mint, t.pairAddress) : api.getCandles(t.pairAddress));
        if (c && c.length) { t.candles = c; t.candlesAt = now; }
      } catch (e) { log(`Velas de ${t.symbol} indisponíveis: ${e.message}`, true); }
      const sh = chartShape(t.candles);
      t.shape = sh;
      const bad = sh.tipo === 'morta' || sh.tipo === 'reta';
      res.checks.push({ id: 'formato', label: 'Formato do gráfico', ok: sh.tipo === 'nova' ? null : !bad, detail: sh.msg, permanent: sh.tipo === 'morta' });
      if (bad) { res.status = sh.tipo === 'morta' ? 'reprovada' : 'aguardando'; res.reasons = [`Formato do gráfico: ${sh.msg}`]; }
    }
    t.status = res.status;
    t.checks = res.checks;
    t.reasons = res.reasons;
    t.score = res.score;
    t.scoreParts = res.scoreParts;
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
      .filter((t) => t.pairAddress && (monitored(t) || newlyApproved.includes(t) || (t.status === 'aguardando' && (t.score || 0) >= 75)))
      .filter((t) => t.held || (state.sim?.open || []).some((o) => o.mint === t.mint) || !t.candlesAt || now - t.candlesAt >= CANDLE_REFRESH_MIN * 60000)
      .sort((a, b) => (b.held ? 1 : 0) - (a.held ? 1 : 0) || (a.candlesAt || 0) - (b.candlesAt || 0))
      .slice(0, MAX_CANDLE_CALLS);
    for (const t of want) {
      try {
        const c = await (api.getCandlesFor ? api.getCandlesFor(t.mint, t.pairAddress) : api.getCandles(t.pairAddress));
        if (c && c.length) { t.candles = c; t.candlesAt = now; delete t.candlesFromHist; }
      } catch (e) {
        log(`Velas de ${t.symbol} indisponíveis: ${e.message}`, true);
        if (e.rateLimited) break;
      }
      if (api.sleep) await api.sleep(6500); // respeita o limite do GeckoTerminal
    }
  }
  // Par sem velas no GeckoTerminal (ex.: contra uma ação tokenizada): monta velas de 5 min com os preços guardados a cada rodada
  for (const t of Object.values(tokens)) {
    if ((t.candles?.length && !t.candlesFromHist) || !(t.hist?.length >= 12) || !(monitored(t))) continue;
    if (t.candlesAt && now - t.candlesAt < 30 * 60000 && !t.candlesFromHist) continue;
    let prev = t.hist[0][1];
    t.candles = t.hist.slice(-72).map(([ms, px]) => { const c = [ms, prev, Math.max(prev, px), Math.min(prev, px), px, 0]; prev = px; return c; });
    t.candlesFromHist = true;
  }
  // Formato atualizado; aprovada que "morreu" sai do radar
  for (const t of Object.values(tokens)) {
    if (!t.candles || !(t.status === 'aprovada' || t.held)) continue;
    t.shape = chartShape(t.candles);
    if (!t.held && t.status === 'aprovada' && t.shape.tipo === 'morta' && !newlyApproved.includes(t)) {
      t.status = 'reprovada'; t.rejectedAt = now; t.reasons = [`Formato do gráfico: ${t.shape.msg}`];
      log(`SAIU DO RADAR: ${t.symbol} (${t.shape.msg})`);
    }
  }

  // 5d. Sinais de entrada (radar) e de saída (suas posições), com as lições dos vídeos
  const rrMin = cfg.simulacao?.riscoRetornoMin || 2;
  const opsOf = (mint) => (state.wallet?.ops || []).filter((o) => o.mint === mint && o.tokens).sort((a, b) => a.at - b.at);
  for (const t of Object.values(tokens)) {
    if (!t.candles?.length) continue;
    const p5 = t.periods?.m5 || {};
    const ctx = { px: t.priceUsd, buys5: p5.buys, sells5: p5.sells, safety: t.safety?.level, shape: t.shape?.tipo, rrMin };
    const prev = t.sinal;
    let sig = null;
    if (t.held && t.position?.known && t.position.avgPriceUsd > 0) {
      // início da posição aberta = primeira compra depois da última vez que zerou
      let net = 0, start = null;
      for (const o of opsOf(t.mint)) { if (net <= 0 && o.tokens > 0) start = o.at; net += o.tokens; if (net <= 0) start = null; }
      const entryAt = start || t.heldSince || now;
      const SM = cfg.venda?.stopMovel;
      if (SM?.ligado) {
        const prevStop = t.trail?.entryAt === entryAt ? t.trail.stop : 0;
        const tr = trailStop(t.candles, { entryPx: t.position.avgPriceUsd, entryAt, peak: Math.max(t.trail?.entryAt === entryAt ? t.trail.peak || 0 : 0, t.priceUsd || 0) }, SM, prevStop);
        if (tr) { if (tr.ativo && !(prevStop > 0)) log(`STOP MÓVEL ligado em ${t.symbol}: garante +${tr.travadoPct.toFixed(0)}%`); t.trail = { ...tr, entryAt }; }
      } else delete t.trail;
      ctx.trail = t.trail;
      const x = exitSignal(t.candles, { entryPx: t.position.avgPriceUsd, entryAt }, ctx);
      if (x) sig = { tipo: 'saida', ...x };
    } else if (t.status === 'aprovada' || (t.status === 'aguardando' && (t.score || 0) >= 75)) {
      sig = { tipo: 'entrada', ...entrySignal(t.candles, ctx) };
    }
    if (!sig) { delete t.sinal; continue; }
    // "desde" muda só quando a fase muda (para o painel avisar uma vez)
    sig.at = prev && prev.tipo === sig.tipo && prev.fase === sig.fase && prev.key === sig.key ? prev.at : now;
    t.sinal = sig;
    if (sig.at === now && (sig.boa || sig.bom || sig.ruim)) log(`SINAL: ${t.symbol} - ${sig.titulo}`);
  }

  // 6b. Venda no lucro: posições pequenas (sem ordem limite possível) vendem 100% ao bater o alvo
  if (trader?.canTakeProfit) {
    const L = cfg.venda.lucro;
    for (const t of Object.values(tokens)) {
      const p = t.position;
      if (!t.held || !p?.known || t.takeProfit?.ok || (t.takeProfit?.tries || 0) >= 3) continue;
      if (!(p.costOpenUsd > 0) || p.costOpenUsd < (cfg.venda?.valorMinimoUsd ?? 1) || p.costOpenUsd >= L.ateUsd || !(p.openPnlPct >= L.alvoPct)) continue;
      log(`LUCRO em ${t.symbol}: +${p.openPnlPct.toFixed(0)}% (investido US$ ${p.costOpenUsd.toFixed(2)}). Vendendo 100%...`);
      try {
        const r = await trader.sellAll(t.mint);
        t.takeProfit = { ok: true, at: now, sig: r.sig, outSol: r.outSol, pct: p.openPnlPct };
        log(r.nada ? `Nada de ${t.symbol} para vender.` : `VENDEU 100% de ${t.symbol} no lucro por ${r.outSol.toFixed(4)} SOL (tx ${r.sig.slice(0, 8)}...)`);
      } catch (e) {
        t.takeProfit = { ok: false, at: now, tries: (t.takeProfit?.tries || 0) + 1, erro: e.message };
        log(`Venda no lucro de ${t.symbol} falhou: ${e.message}`, true);
      }
    }
  }
  for (const t of Object.values(tokens)) {
    const a = t.takeProfit; if (!a || !t.safety) continue;
    const alert = a.ok
      ? { id: 'lucro-auto', level: 'warn', at: a.at, msg: `Robô vendeu 100% no lucro (+${a.pct.toFixed(0)}%)${a.outSol ? ` por ${a.outSol.toFixed(4)} SOL` : ''}`, sig: a.sig }
      : { id: 'lucro-auto', level: 'warn', msg: `Bateu o alvo de lucro, mas a venda falhou: ${a.erro}. Venda manualmente!` };
    if (a.ok) alert.level = 'info';
    t.safety = mergeSafety(t.safety, [alert, ...t.safety.alerts.filter((x) => x.id !== 'lucro-auto')], now);
  }

  // 6c. O que a vigia rápida fez entre as rodadas
  let vig = null;
  try { vig = JSON.parse(await (await import('node:fs/promises')).readFile('/tmp/faro-vigia.json', 'utf8')); } catch {}
  for (const [mint, a] of Object.entries(vig?.sold || {})) {
    const t = tokens[mint]; if (!t || !a || t.watchSell?.at === a.at) continue;
    t.watchSell = a;
    if (a.ok) log(`Vigia vendeu 100% de ${t.symbol}: ${a.why}${a.outSol ? ` (${a.outSol.toFixed(4)} SOL)` : ''}`);
  }
  for (const t of Object.values(tokens)) {
    const a = t.watchSell; if (!a || !t.safety) continue;
    const msg = a.skipped ? `${a.kind === 'golpe' ? 'Golpe' : 'Sinal de venda'} (${a.why}), mas a operação é menor que US$ ${cfg.venda?.valorMinimoUsd ?? 1}: não compensa vender`
      : a.ok ? `Robô vendeu 100%${a.outSol ? ` por ${a.outSol.toFixed(4)} SOL` : ''}. Motivo: ${a.why}`
      : `Vigia rápida tentou vender (${a.why}) e falhou: ${a.erro}. Venda manualmente!`;
    // Golpe no contrato = perigo; queda de liquidez = atenção; queda de preço ou lucro = só aviso (a moeda pode seguir viva)
    const lvl = a.kind === 'golpe' ? 'danger' : /liquidez/.test(a.why || '') ? 'warn' : 'info';
    t.safety = mergeSafety(t.safety, [{ id: 'vigia', level: a.skipped ? 'info' : lvl, at: a.at, msg, ...(a.sig ? { sig: a.sig } : {}) }, ...t.safety.alerts.filter((x) => x.id !== 'vigia')], now);
  }

  // 6c2. Valor por operação conforme a banca: SOL na carteira + valor das moedas abertas, em dólar
  {
    const solUsd = Object.values(tokens).map((t) => (t.priceNative > 0 ? t.priceUsd / t.priceNative : 0)).find((v) => v > 0) || 0;
    const held = Object.values(tokens).filter((t) => t.held).reduce((a, t) => a + (t.heldAmount || 0) * (t.priceUsd || 0), 0);
    const bancaUsd = state.wallet?.solBalance != null && solUsd ? state.wallet.solBalance * solUsd + held : null;
    const faixas = [...(cfg.compra?.faixas || [])].sort((a, b) => b.bancaMinUsd - a.bancaMinUsd);
    const faixa = bancaUsd != null ? faixas.find((f) => bancaUsd >= f.bancaMinUsd) : null;
    if (faixa && solUsd) cfg.compra.solPorCompra = +(faixa.usd / solUsd).toFixed(4);
    state.banca = { usd: bancaUsd, faixaUsd: faixa?.usd ?? null, solPorCompra: cfg.compra?.solPorCompra, at: now };
  }

  // 6d. Compra no sinal de boa entrada: interruptor (memo assinado pela sua carteira), simulação e compra real
  if (wallet && api.getMemos && api.txSigner) {
    try {
      const sw = await readSwitch(await api.getMemos(wallet), async (sig) => (await api.txSigner(sig)) === wallet);
      if (sw && (!state.autoCompra || state.autoCompra.sig !== sw.sig)) log(`Compra automática ${sw.on ? 'LIGADA' : 'DESLIGADA'} pelo painel`);
      if (sw) state.autoCompra = sw;
    } catch (e) { log(`Não consegui ler o interruptor da compra automática: ${e.message}`, true); }
  }
  const buyList = entryCandidates(tokens, cfg, now);
  try { simStep({ state, tokens, candidates: buyList, cfg, now, log }); } catch (e) { log(`Simulação falhou: ${e.message}`, true); }
  if (trader?.canBuy && state.autoCompra?.on && buyList.length) {
    try {
      const limits = buyLimits(state, tokens, cfg, now);
      const trades = await trader.maybeBuy(buyList, state, cfg, log, limits);
      state.trades.push(...trades);
    } catch (e) { log(`Módulo de compra falhou: ${e.message}`, true); }
  }

  // 7. Limpeza
  const rejected = Object.values(tokens).filter((t) => t.status === 'reprovada').sort((a, b) => (b.rejectedAt || 0) - (a.rejectedAt || 0));
  const simNow = new Set((state.sim?.open || []).map((o) => o.mint));
  for (const t of rejected.slice(MAX_REJECTED_KEPT)) if (!simNow.has(t.mint)) delete tokens[t.mint];
  for (const t of Object.values(tokens)) {
    if (t.held || simNow.has(t.mint)) { delete t._rug; continue; }
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
    autoBuy: !!trader?.canBuy,
    autoCompra: state.autoCompra ? { on: state.autoCompra.on, at: state.autoCompra.at } : null,
    autoSell: !!trader?.canSell,
    watch: trader?.canWatch ? { quedaDoPicoPct: cfg.venda.vigia.quedaDoPicoPct, quedaLiquidezPct: cfg.venda.vigia.quedaLiquidezPct } : null,
    takeProfit: trader?.canTakeProfit ? { alvoPct: cfg.venda.lucro.alvoPct, ateUsd: cfg.venda.lucro.ateUsd } : null,
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
