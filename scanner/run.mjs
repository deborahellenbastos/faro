// Uma rodada do robô: busca, analisa, vigia as aprovadas e as da sua carteira e (se ligado) compra.
import { avisar } from './push.mjs';
import { simStep, simCrazy, marketTide } from './sim.mjs';
import { entryCandidates, readSwitch, readSellSwitch, buyLimits, readProfile, profileCfg, securityOk, splitScore, readFavs, preBuyBlock } from './autobuy.mjs';
import { entrySignal, exitSignal, trailStop, breakoutSignal, shallowEntry, baseBreakout, trendEntry, fakeBuys, peakPassed } from './signals.mjs';
import { summarizeMarket, prefilter, analyze, scoreToken, scoreParts, chartShape, scamSignals, isLpSignal, summarizeRug, runChecks, baselineFrom, marketAlerts, rugAlerts, mergeSafety, positionFrom } from './analyze.mjs';

const RUG_CACHE_MIN = 30;   // reaproveita o relatório do RugCheck das novas por 30 min
const RECHECK_MIN = 5;      // moedas da carteira: rechecagem de segurança toda rodada (5 min)
const RECHECK_APPROVED_MIN = 30; // aprovadas que você não comprou: a cada 30 min
const MAX_REJECTED_KEPT = 300;
const MAX_PRICE_LOOKUPS = 6;         // preços históricos buscados por rodada (o resto fica para a próxima)
const MAX_CANDLE_CALLS = 20;        // 20/11: a Jupiter responde rápido; o GeckoTerminal (reserva) segue limitado abaixo
const MAX_GECKO_CALLS = 6;          // GeckoTerminal grátis aceita poucas consultas por minuto
const CANDLE_REFRESH_MIN = 5;       // radar e carteira: velas novas a cada rodada, para o sinal de entrada e saída sair na hora

// 25/11: preço de referência do SOL (mediana dos pares contra SOL), para moeda cujo par não é contra SOL
let solRefCache = { at: 0, v: null }, solRefTokens = null;
function solRef() {
  if (Date.now() - solRefCache.at < 60000 && solRefCache.v) return solRefCache.v;
  const v = Object.values(solRefTokens || {}).filter((t) => /^(W?SOL)$/i.test(t.quoteSymbol || '') && t.priceNative > 0).map((t) => t.priceUsd / t.priceNative).filter((x) => x > 20 && x < 2000).sort((a, b) => a - b);
  solRefCache = { at: Date.now(), v: v.length ? v[Math.floor(v.length / 2)] : null };
  return solRefCache.v;
}
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
  solRefTokens = tokens; solRefCache = { at: 0, v: null };
  // Devs de golpes que o Faro já viu: moedas novas do mesmo dev são reprovadas
  state.badDevs = state.badDevs || {};
  for (const t of Object.values(tokens)) {
    const c = t.rug?.creator; if (!c || state.badDevs[c] || !t.approvedAt) continue;
    const rugged = (t.safety?.alerts || []).some((a) => a.id === 'liq-sumiu' || a.id === 'rugged') || (t.changePct ?? 0) <= -90;
    if (rugged) state.badDevs[c] = { symbol: t.symbol, mint: t.mint, at: now };
  }
  { const e = Object.entries(state.badDevs); if (e.length > 500) state.badDevs = Object.fromEntries(e.sort((a, b) => b[1].at - a[1].at).slice(0, 500)); }
  cfg.__badDevs = state.badDevs;
  // Interruptor manual da venda automática (painel): lido antes de qualquer venda da rodada
  { const w = (cfg.carteira?.enderecoPublico || '').trim();
    if (w && api.getMemos && api.txSigner) {
      try {
        const sv = await readSellSwitch(await api.getMemos(w), async (sig) => (await api.txSigner(sig)) === w);
        if (sv && (!state.autoVenda || state.autoVenda.sig !== sv.sig)) log(`Venda automática ${sv.on ? 'LIGADA' : 'DESLIGADA'} pelo painel`);
        if (sv) state.autoVenda = sv;
      } catch (e) { log(`Não consegui ler o interruptor da venda automática: ${e.message}`, true); }
    }
    if (state.autoVenda?.on === false && trader) {
      trader = { ...trader, canSell: false, canTakeProfit: false, canWatch: false, sellAll: async () => { throw new Error('venda automática desligada pelo painel'); } };
    }
  }
  const maxAgeMin = cfg.busca.idadeMaximaHoras * 60;
  const trackMs = cfg.busca.diasAcompanhando * 86400000;

  // 1. Candidatas novas
  const candidates = await api.getSolanaCandidates(log);
  for (const c of candidates) {
    const t = tokens[c.mint];
    if (!t) tokens[c.mint] = { mint: c.mint, firstSeen: now, status: 'nova', source: c.source, icon: c.icon, description: c.description, links: c.links, ...(c.soJupiter ? { soJupiter: true } : {}) };
    else if (!t.icon && c.icon) t.icon = c.icon;
  }
  // 26/11 (pedido da Kerah): carteiras que ela segue. Moeda que elas comprarem entra na análise do Faro na hora
  // e, no fim da rodada (já com nome e nota), vai um aviso para o celular
  const seguidasNovas = [];
  state.seguir = state.seguir || {};
  const listaSeguir = api.lerSeguidas ? await api.lerSeguidas(cfg.seguir?.carteiras || []).catch(() => cfg.seguir?.carteiras || []) : cfg.seguir?.carteiras || [];
  for (const w of listaSeguir) {
    if (!w?.endereco || w.ligado === false) continue;
    const apelido = w.apelido || `${w.endereco.slice(0, 4)}...${w.endereco.slice(-4)}`;
    try {
      const st = state.seguir[w.endereco] || {};
      const r = await api.getFollowedBuys(w.endereco, st.lastSig);
      state.seguir[w.endereco] = { ...st, apelido, lastSig: r.lastSig || st.lastSig, at: now };
      for (const b of r.buys) {
        let t = tokens[b.mint];
        if (!t) t = tokens[b.mint] = { mint: b.mint, firstSeen: now, status: 'nova', source: `carteira seguida (${apelido})` };
        t.seguida = { apelido, carteira: w.endereco, at: b.at || now, sol: -b.sol, sig: b.sig };
        seguidasNovas.push({ mint: b.mint, apelido, sol: -b.sol, sig: b.sig });
        log(`CARTEIRA SEGUIDA: ${apelido} comprou ${t.symbol || b.mint.slice(0, 6)} (${(-b.sol).toFixed(3)} SOL)`);
      }
    } catch (e) { log(`Carteira seguida ${apelido}: não consegui ler agora (${e.message})`); }
  }
  // Rankings da Jupiter: guarda em quais listas a moeda apareceu e a nota orgânica (0 a 100). Só registra, não muda a nota do Faro
  for (const [mint, j] of candidates.jupiter || []) {
    const t = tokens[mint]; if (!t) continue;
    const prev = t.jup || {};
    t.jup = { organic: j.organic, organicLabel: j.organicLabel, holders: j.holders, verificada: j.verificada, at: now,
      listas: [...new Set([...(prev.listas || []), ...j.listas])], primeiraVez: prev.primeiraVez || now,
      organicMax: Math.max(prev.organicMax ?? 0, j.organic ?? 0) };
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
      for (const t of Object.values(tokens)) if (t.held && !heldSet.has(t.mint)) {
        t.held = false; t.soldAt = now;
        // Vendida à mão (não foi o robô nos últimos 15 min): também fica vigiada para reentrada
        const robo = [t.watchSell, t.autoSell, t.takeProfit].some((x) => x?.ok && now - x.at < 15 * 60000);
        if (!robo && t.position?.buys) t.reentry = { at: now, kind: 'manual', exitPx: t.priceUsd || null };
      }
      log(`Carteira: ${held.length} moedas encontradas`);
      // Compras e vendas (para calcular preço médio e resultado)
      // v3: custo = valor da troca em si, igual à Phantom (sem taxas de rede e de criação de conta) -> relê o histórico uma vez
      // v4: ignora poeira de outra moeda deixada pela rota da Jupiter (17/11: compras da Minnie não eram registradas)
      state.wallet = state.wallet && state.wallet.address === wallet && state.wallet.v === 4 ? state.wallet : { address: wallet, ops: [], lastSig: null, v: 4 };
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
          // Dinheiro de venda que chegou depois, noutra transação (venda pela Phantom por outra rota)
          if (!state.wallet.insScan && api.getWalletIncoming) { try { r.ins = [...(r.ins || []), ...(await api.getWalletIncoming(wallet, 60))]; state.wallet.insScan = true; } catch {} }
          const seenIn = new Set((state.wallet.ins || []).map((x) => x.sig));
          state.wallet.ins = [...(state.wallet.ins || []), ...(r.ins || []).filter((x) => !seenIn.has(x.sig) && (seenIn.add(x.sig), true))].filter((x) => now - x.at < 7 * 86400000).slice(-300);
          if (api.linkDelayedProceeds) { const n = api.linkDelayedProceeds(state.wallet.ops, state.wallet.ins); if (n) log(`Carteira: ${n} venda(s) com o dinheiro chegando depois, ligadas`); }
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
      // 25/11 (Zolana): valor estimado de moeda enviada/recebida fora de qualquer proporção com o preço de compra
      // (par que não é contra SOL/dólar dá preço absurdo) não vale: enviada sem preço confiável conta como zero
      const precoCompra = {};
      for (const o of state.wallet.ops) if (!o.est && o.tokens > 0 && o.sol < 0 && o.solUsd) { const c = (precoCompra[o.mint] = precoCompra[o.mint] || { usd: 0, tok: 0 }); c.usd += -o.sol * o.solUsd; c.tok += o.tokens; }
      for (const o of state.wallet.ops) {
        if (!o.est || o.estFora || !o.solUsd || !o.tokens) continue;
        const c = precoCompra[o.mint]; if (!c?.tok) continue;
        const pc = c.usd / c.tok, pe = Math.abs(o.sol * o.solUsd / o.tokens);
        if (pe > pc * 1000 || pe < pc / 10000) { log(`Carteira: valor estimado absurdo numa transferência de ${tokens[o.mint]?.symbol || o.mint.slice(0, 6)} (${o.sol.toFixed(4)} SOL), conta como zero`); o.sol = 0; o.estFora = 1; }
      }
    } catch (e) {
      log(`Não consegui ler a carteira: ${e.message}`, true);
    }
  }

  const simOpen = new Set([...(state.sim?.open || []), ...(state.simAgr?.open || []), ...(state.simLouco?.open || []), ...(state.simSeg?.open || [])].map((o) => o.mint));
  const REENTRY_MS = (cfg.compra?.reentradaHoras ?? 3) * 3600000;
  const reentryOpen = (t) => !!(t.reentry && !t.held && now - t.reentry.at < REENTRY_MS);
  const curveOn = (t) => !!(t.curva?.ok && now - t.curva.at < 3600000);
  // Favoritas (até 24h depois de enviadas ao robô): vigiadas mesmo fora do Radar; golpe confirmado tira da lista
  const FAV_MS = 24 * 3600000;
  const favSet = new Set(state.favs && now - (state.favs.at || 0) < FAV_MS ? (state.favs.mints || []).filter((m) => !(state.favsOut || []).includes(m)) : []);
  for (const m of favSet) if (!tokens[m]) tokens[m] = { mint: m, firstSeen: now, status: 'aguardando', source: 'favorita' };
  for (const t of Object.values(tokens)) { if (favSet.has(t.mint)) t.favorita = true; else delete t.favorita; }
  // 21/11: moedas que a Kerah reprovou à mão no painel (lista no servidor). Saem do Radar e não voltam a ser avaliadas;
  // "Desfazer" no painel tira da lista e a moeda volta para a análise na rodada seguinte. Moeda na carteira não é mexida
  const manuais = api.lerReprovadas ? await api.lerReprovadas().catch(() => ({})) : {};
  for (const t of Object.values(tokens)) {
    const r = manuais[t.mint];
    if (r && !t.held) {
      if (!t.reprovadaManual) { log(`REPROVADA POR VOCÊ: ${t.symbol || t.mint.slice(0, 6)} saiu do Radar`); t.rejectedAt = now; }
      t.reprovadaManual = r.at; t.status = 'reprovada'; t.reasons = ['Reprovada por você no painel']; delete t.favorita; delete t.sinal; delete t.sinalAgr;
    } else if (t.reprovadaManual && !r) { delete t.reprovadaManual; t.status = 'aguardando'; t.reasons = ['Reprovação desfeita: volta para a análise']; }
  }
  const monitored = (t) => t.favorita || t.held || (t.seguida && now - (t.seguida.at || 0) < 6 * 3600000) || simOpen.has(t.mint) || t.status === 'carteira' || reentryOpen(t) || curveOn(t) || (t.status === 'aprovada' && now - (t.approvedAt || now) < trackMs);
  const active = Object.values(tokens).filter((t) => (!t.reprovadaManual || t.held || simOpen.has(t.mint)) && (t.status === 'nova' || t.status === 'aguardando' || monitored(t)));

  // 3. Dados de mercado de todas de uma vez
  const market = await api.getMarketData(active.map((t) => t.mint), log);

  // 4. Filtro rápido, vigilância de mercado e filas do RugCheck
  const rugQueue = [];
  const curveQueue = [];
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
        t.position = positionFrom(myOps, t.heldAmount || 0, m.priceNative, m.priceUsd, solRef());
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
      // Aprovada que levou um despejo (estrutura quebrada + insiders/concentração novos, ou -60% em poucos minutos): sai do radar
      const dump = !t.held && t.status === 'aprovada' ? dumpReason(t, m.priceUsd, now) : null;
      if (dump) {
        t.status = 'reprovada'; t.rejectedAt = now; t.reasons = [dump];
        log(`SAIU DO RADAR: ${t.symbol} (${dump})`);
        continue;
      }
      const every = (t.held ? RECHECK_MIN : RECHECK_APPROVED_MIN) * 60000;
      if (!t._rugAt || now - t._rugAt >= every) recheckQueue.push({ t, m });
      continue;
    }

    // 27/11 (pedido da Kerah): moeda em Análise que despencou 95%+ (rug) vai direto para as reprovadas.
    // Guarda os preços dos últimos 20 min (cada rodada) e usa também a variação de 5 min, 1 h e 6 h da DexScreener
    if (!t.held && m.priceUsd > 0) {
      t.pxWin = [...(t.pxWin || []).filter(([ms]) => now - ms <= 20 * 60000), [now, m.priceUsd]];
      const top10 = Math.max(0, ...t.pxWin.filter(([ms]) => now - ms <= 10 * 60000).map(([, p]) => p));
      const P = m.periods || {}, ch = (k) => Number(P[k]?.chg);
      const why = top10 > 0 && m.priceUsd <= top10 * 0.05 ? `caiu ${((1 - m.priceUsd / top10) * 100).toFixed(0)}% em menos de 10 min`
        : ch('m5') <= -95 ? `caiu ${Math.abs(ch('m5')).toFixed(0)}% em 5 min` : ch('h1') <= -95 ? `caiu ${Math.abs(ch('h1')).toFixed(0)}% na última hora`
        : ch('h6') <= -95 ? `caiu ${Math.abs(ch('h6')).toFixed(0)}% nas últimas 6 h` : null;
      if (why) {
        t.status = 'reprovada'; t.rejectedAt = now; t.reasons = [`Despencou: ${why} (golpe)`]; delete t.pxWin;
        log(`REPROVADA: ${t.symbol} (${t.reasons[0]})`);
        continue;
      }
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
    if (pre.length) {
      t.status = 'aguardando'; t.reasons = pre; t.checks = null;
      // Modo curva (só simulação): moeda ainda na curva da pump.fun, perto de migrar e com muita compra
      const CV = cfg.curva || {};
      if (CV.ligado && m.dexId === 'pumpfun' && m.mcapUsd >= (CV.marketCapMinUsd ?? 45000) && (m.ageMin ?? 0) >= (CV.idadeMinMin ?? 15)
        && m.buysH1 >= (CV.comprasHoraMin ?? 100) && m.buyRatioH1 >= (CV.compraPctMin ?? 55)) curveQueue.push({ t, m });
      else if (t.curva && m.dexId !== 'pumpfun') delete t.curva; // migrou: segue pelo caminho normal
      continue;
    }
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
      // 26/11 (DEXDATA): recompra é uma posição nova; a referência dos sinais de golpe passa a ser a de agora.
      // Antes valia a da primeira compra (dev com 3,9%) e o robô via "dev vendeu" de novo e vendia a recompra
      // 27/11 (Zhaki): vale para qualquer compra. A referência passa a ser a última leitura ANTES da compra (até 1 h antes);
      // sem ela, a de agora. Antes ficava a da aprovação (dev com 5,1%) e o robô vendeu por algo de antes da compra
      if (t.held && t.heldSince && t.baselineFor !== t.heldSince) {
        const c = [t.rugLast, t.baseline && { base: t.baseline, at: t.baselineAt || 0 }].filter((x) => x && x.at <= t.heldSince + 60000).sort((a, b) => b.at - a.at)[0];
        if (c && t.heldSince - c.at <= 3600000) { t.baseline = c.base; t.baselineAt = c.at; } else { t.baseline = baselineFrom(sum); t.baselineAt = now; }
        t.baselineFor = t.heldSince; delete t.autoSell;
      }
      if (!t.baseline) { t.baseline = baselineFrom(sum); t.baselineAt = now; }
      t._rugAlerts = rugAlerts(t.baseline, sum, cfg);
      // 27/11: lista "Dev vendeu" no painel. Guarda quando o dev começou a vender e quanto tinha
      if (t.baseline.devPct != null && sum.devPct != null && t.baseline.devPct - sum.devPct >= 1) {
        t.devVendeu = { at: t.devVendeu?.at || now, tinhaPct: t.baseline.devPct, agoraPct: sum.devPct, pxAt: t.devVendeu?.pxAt || t.priceUsd || null };
        if (sum.devPct < 0.1 && !t.devVendeu.zerouAt) t.devVendeu.zerouAt = now;
      }
      // LP "destravada" com a liquidez estável no mercado: provavelmente falha do RugCheck, vira só atenção
      { const ld = t.entryLiquidityUsd > 0 ? (1 - m.liquidityUsd / t.entryLiquidityUsd) * 100 : 0;
        if (ld < 15) t._rugAlerts = t._rugAlerts.map((a) => (a.id === 'lp' ? { ...a, level: 'warn', msg: `${a.msg} (a liquidez no mercado não caiu: pode ser falha do RugCheck)` } : a)); }
      t.checks = runChecks(m, sum, cfg);
      t.safety = mergeSafety(t.safety, [...t._rugAlerts, ...(t._mktAlerts || [])], now);
      t.rugLast = { base: baselineFrom(sum), at: now };
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
      const minUsd = cfg.venda?.valorMinimoProtecaoUsd ?? 0.25; // golpe é proteção: vende a partir de US$ 0,25
      // Posição que vale menos que isso: não vende sozinho (a taxa não compensa e ela pode ter um bump)
      const worth = (t.heldAmount || 0) * (m.priceUsd || 0);
      if (scam.length && trader?.canSell && !(t.autoSell?.ok) && worth < minUsd) {
        if (!t.autoSell?.skipped) log(`GOLPE em ${t.symbol}, mas a operação é de só US$ ${worth.toFixed(2)} (mínimo US$ ${minUsd}). Não vendi.`);
        t.autoSell = { ok: false, skipped: true, at: now, why: scam.join('; '), worth };
      }
      if (scam.length && t.segurar) { if (!t.autoSell?.segurando) log(`${t.symbol}: sinal de golpe (${scam.join('; ')}), mas é do perfil Segurar. Não vende.`); t.autoSell = { ok: false, segurando: true, at: now, why: scam.join('; ') }; }
      else if (scam.length && trader?.canSell && !(t.autoSell?.ok) && worth >= minUsd && (t.autoSell?.tries || 0) < 3) {
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
        // 26/11: no modo Segurar o robô decide NÃO vender; isso aparecia como "venda falhou: undefined" (DEXDATA)
        const alert = a.segurando
          ? { id: 'auto-venda', level: 'info', at: a.at, msg: `Sinal de golpe (${a.why}), mas a moeda está no modo Segurar: o robô não vende por isso` }
          : a.skipped
          ? { id: 'auto-venda', level: 'info', at: a.at, msg: `Golpe no contrato (${a.why}), mas a operação é menor que US$ ${cfg.venda?.valorMinimoProtecaoUsd ?? 0.25}: não compensa vender` }
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
      t.approvalScore = res.score;
      t.entryPriceUsd = m.priceUsd;
      t.entryMcapUsd = m.mcapUsd;
      t.entryLiquidityUsd = m.liquidityUsd;
      t.maxPriceUsd = m.priceUsd;
      t.changePct = 0;
      t.maxChangePct = 0;
      t.baseline = baselineFrom(res.summary); t.baselineAt = now;
      t.safety = { level: 'ok', alerts: [], checkedAt: now };
      newlyApproved.push(t);
      log(`APROVADA: ${t.symbol} (nota ${t.score})`);
    }
  }

  // 5b2. Modo curva (só simulação): segurança sem os itens de liquidez (na curva não existe pool ainda)
  {
    const CV = cfg.curva || {};
    let n = 0;
    for (const { t, m } of curveQueue.sort((a, b) => b.m.mcapUsd - a.m.mcapUsd)) {
      if (paused || n >= (CV.maxRugcheckPorRodada ?? 3) || rugCalls >= cfg.busca.maxRugcheckPorRodada + (CV.maxRugcheckPorRodada ?? 3)) break;
      if (t.curva && now - t.curva.at < 10 * 60000) continue;
      try {
        n++;
        const sum = summarizeRug(await fetchRug(t));
        if (!sum) continue;
        const checks = runChecks(m, sum, cfg).filter((c) => ['mint', 'freeze', 'holders', 'dev', 'rugcheck'].includes(c.id));
        const bad = checks.filter((c) => c.ok === false);
        t.rug = t.rug || { creator: sum.creator, totalHolders: sum.totalHolders, top10Pct: sum.top10Pct };
        t.curva = { ok: !bad.length, at: now, mc: m.mcapUsd, reasons: bad.map((c) => `${c.label.replace(/^\d\.\s*/, '')}: ${c.detail}`) };
        if (t.curva.ok) log(`CURVA (simulação): ${t.symbol} ok para o sinal (market cap ${Math.round(m.mcapUsd)})`);
      } catch (e) { if (e.rateLimited) { paused = true; break; } }
    }
  }

  // 5c. Velas para o mini gráfico (aprovadas e as suas), via GeckoTerminal
  if (api.getCandles) {
    // Moeda da carteira que já não vale nada (resto, morta ou perdida) não gasta consulta de velas: antes ocupava as vagas
    // e o radar ficava sem velas (17/11: AI pediu velas 7x numa hora e a JALU, +1900%, ficou "sem movimento para medir")
    const worthUsd = (t) => (t.heldAmount || 0) * (t.priceUsd || 0);
    const heldLive = (t) => t.held && worthUsd(t) >= 0.25;
    // 20/11: resto sem valor na carteira vai para o fim da fila (antes contava como "aprovada" e passava na frente)
    const rank = (t) => (heldLive(t) ? 3 : t.favorita ? 2 : t.held ? -1 : newlyApproved.includes(t) || t.status === 'aprovada' ? 1 : 0);
    const want = Object.values(tokens)
      .filter((t) => t.pairAddress && (monitored(t) || newlyApproved.includes(t) || (t.status === 'aguardando' && (t.score || 0) >= 75)))
      .filter((t) => !t.held || heldLive(t) || !t.candlesAt || now - t.candlesAt >= 60 * 60000)
      .filter((t) => heldLive(t) || t.favorita || simOpen.has(t.mint) || !t.candlesAt || now - t.candlesAt >= CANDLE_REFRESH_MIN * 60000)
      // moeda que deu "limite de consultas" espera 30 min (20/11: a ANGSTIPAN, morta, travava as velas de todas as outras)
      .filter((t) => !t.candlesFailAt || now - t.candlesFailAt >= 30 * 60000)
      .sort((a, b) => rank(b) - rank(a) || (a.candlesAt || 0) - (b.candlesAt || 0))
      .slice(0, MAX_CANDLE_CALLS);
    let geckoCalls = 0, geckoBlocked = false;
    for (const t of want) {
      // sem o GeckoTerminal nesta rodada (bloqueado ou no limite), só a Jupiter
      const pair = geckoBlocked || geckoCalls >= MAX_GECKO_CALLS ? null : t.pairAddress;
      let src = null;
      try {
        const c = await (api.getCandlesFor ? api.getCandlesFor(t.mint, pair) : api.getCandles(t.pairAddress));
        src = c?.src || (api.getCandlesFor ? null : 'gecko');
        if (c && c.length) { t.candles = c; t.candlesAt = now; delete t.candlesFromHist; delete t.candlesFailAt; }
      } catch (e) {
        src = 'gecko';
        log(`Velas de ${t.symbol} indisponíveis: ${e.message}`, true);
        if (e.rateLimited) { t.candlesFailAt = now; geckoBlocked = true; } // pula só esta moeda; as outras seguem pela Jupiter
      }
      if (src === 'gecko') geckoCalls++;
      if (api.sleep) await api.sleep(src === 'gecko' ? 6500 : 300); // a pausa longa é só para o GeckoTerminal
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

  // 5c2. Compras falsas: o alerta fica 30 min depois da última vez que o padrão apareceu (sem piscar Perigo/Segura
  // quando a conta fica em cima do limite de 80%, caso JALU 17/11)
  for (const t of Object.values(tokens)) {
    const f = fakeBuys(t.periods);
    // 20/11: em moeda já sem liquidez a marcação não ajuda (7 de 9 em 19/11). Mínimo em regrasEmTeste.compraFalsa.liquidezMinUsd
    const liqMin = cfg.regrasEmTeste?.compraFalsa?.liquidezMinUsd ?? 0;
    if (f && (t.liquidityUsd || 0) >= liqMin) {
      // registro de cada marcação nova (preço e liquidez da hora) para a análise medir acertos e alarmes falsos
      if (!t.compraFalsa) state.compraFalsaLog = [...(state.compraFalsaLog || []), { mint: t.mint, symbol: t.symbol, at: now, px: t.priceUsd, liq: t.liquidityUsd, status: t.status, held: !!t.held }].filter((x) => now - x.at < 7 * 86400000).slice(-300);
      t.compraFalsa = { at: now, msg: f.msg, desde: t.compraFalsa?.desde || now };
    }
    else if (t.compraFalsa && now - t.compraFalsa.at > 30 * 60000) delete t.compraFalsa;
  }
  // 5d. Sinais de entrada (radar) e de saída (suas posições), com as lições dos vídeos
  const rrMin = cfg.simulacao?.riscoRetornoMin || 2;
  const SG = cfg.sinais || {};
  const opsOf = (mint) => (state.wallet?.ops || []).filter((o) => o.mint === mint && o.tokens).sort((a, b) => a.at - b.at);
  for (const t of Object.values(tokens)) {
    if (!t.candles?.length) continue;
    const p5 = t.periods?.m5 || {};
    // Último "Boa entrada" da moeda: guarda o preço e a máxima depois dele (para não repetir sinal que não andou)
    if (t.boa && now - t.boa.at >= (SG.repeticaoJanelaHoras ?? 24) * 3600000) delete t.boa;
    if (t.boa) t.boa.max = Math.max(t.boa.max || 0, t.priceUsd || 0, ...t.candles.filter((x) => x[0] >= t.boa.at).map((x) => x[2]));
    const ctx = { px: t.priceUsd, buys5: p5.buys, sells5: p5.sells, safety: t.safety?.level, shape: t.shape?.tipo, rrMin,
      score: t.score, notaMin: SG.notaMinima ?? 0, boaPrev: t.boa, now, repetirSeSubiuPct: SG.naoRepetirSeNaoSubiuPct ?? 10, repetirHoras: SG.repeticaoJanelaHoras ?? 24 };
    const prev = t.sinal;
    { const sp = splitScore(t); if (sp) { t.qualidade = sp.qualidade; t.movimento = sp.movimento; } }
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
      // 26/11: posição no modo Segurar não tem sinal de saída (nem "bateu o stop móvel")
      if (t.segurar) { delete t.trail; sig = { tipo: 'saida', fase: 'segurar', titulo: (t.segurar.alvoPct ?? 150) >= 999 ? 'Segurando sem limite (Infinito)' : `Segurando até +${t.segurar.alvoPct ?? 150}%`, msg: 'Modo Segurar: sem stop e sem sinais de saída. O robô vende quando chegar no alvo.', key: 'segurar' }; }
      else { const x = exitSignal(t.candles, { entryPx: t.position.avgPriceUsd, entryAt }, ctx); if (x) sig = { tipo: 'saida', ...x }; }
    } else if (t.status === 'aprovada' || (t.status === 'aguardando' && (t.score || 0) >= 75) || reentryOpen(t) || curveOn(t) || t.favorita) {
      sig = { tipo: 'entrada', ...entrySignal(t.candles, ctx) };
      // Subida saudável (aula de análise técnica): moeda segura que sobe sem corrigir até a zona. Vale para o Conservador
      // A trava é a QUALIDADE (segurança e holders), não a nota total: o movimento é o próprio gráfico que o sinal lê
      const qual = splitScore(t)?.qualidade ?? 0;
      if (!sig.boa && SG.tendencia?.ligado !== false) {
        const te = trendEntry(t.candles, { ...ctx, score: qual, safety: securityOk(t) && (t.checks || []).every((k) => k.ok !== false) ? 'ok' : 'warn', notaTendencia: SG.tendencia?.qualidadeMinima ?? 70 });
        if (te) sig = { tipo: 'entrada', ...te };
      }
      // Rompimento de base (aula: rompimento com volume explodindo): mesmas travas da subida saudável
      if (!sig.boa && SG.rompimentoBase?.ligado !== false && securityOk(t) && (t.checks || []).every((k) => k.ok !== false)
        && qual >= (SG.rompimentoBase?.qualidadeMinima ?? 70) && !['morta', 'reta'].includes(t.shape?.tipo)) {
        const bb = baseBreakout(t.candles, { ...ctx, safety: 'ok' });
        if (bb) sig = { tipo: 'entrada', ...bb };
      }
      // Rompimento (só simulação): guarda à parte, não mexe no sinal principal nem na compra real
      const br = breakoutSignal(t.candles, ctx);
      if (br) { if (!t.romp || t.romp.key !== br.key) { t.romp = { ...br, at: now }; log(`ROMPIMENTO (simulação): ${t.symbol}`); } }
      else if (t.romp && now - t.romp.at > 15 * 60000) delete t.romp;
      // Sinal do perfil agressivo (só quando o normal não é "boa"): zona com risco/retorno menor, 38,2% em tendência forte,
      // rompimento de base ou rompimento curto. A simulação do agressivo usa sempre; a compra real só com o perfil ligado.
      const rrAgr = cfg.perfis?.agressivo?.simulacao?.riscoRetornoMin ?? 1.5;
      const ctxA = { ...ctx, rrMin: rrAgr, buyRatioH1: t.buyRatioH1 };
      let ag = null;
      if (!sig.boa) {
        const z = entrySignal(t.candles, ctxA);
        // 20/11: entrada rasa (38,2%) e rompimento curto desligáveis (sinais.entradaRasa / sinais.rompimentoCurto). Até 19/11:
        // 38,2% com 5 entradas e 5 perdas, rompimentos com 6 e 6 no Agressivo
        const rasaOn = SG.entradaRasa?.ligado !== false, rompCurtoOn = SG.rompimentoCurto?.ligado !== false;
        ag = z.boa ? z : (rasaOn && shallowEntry(t.candles, ctxA)) || baseBreakout(t.candles, ctxA) || (rompCurtoOn && t.romp && now - t.romp.at <= 10 * 60000 ? t.romp : null);
      }
      // Trava "pico já passou": vale para o sinal, a compra real e a simulação (normal e agressivo)
      const PP = SG.picoPassou;
      if (PP?.ligado && (sig.boa || sig.notaBaixa || ag?.boa)) {
        const top = Math.max(0, ...t.candles.map((x) => x[2]));
        const ti = t.candles.findIndex((x) => x[2] === top);
        if (top > 0 && (!t.ath || top > t.ath.px)) t.ath = { ...(t.ath || {}), px: top, at: t.candles[ti][0] };
        if (!t.ath?.full && api.getPeak) {
          const pk = await api.getPeak(t.mint);
          if (pk && (!t.ath || pk.px > t.ath.px)) t.ath = { px: pk.px, at: pk.at };
          if (t.ath && pk) t.ath.full = true;
        }
        const pp = peakPassed(t.priceUsd, t.ath, now, PP);
        if (pp) {
          if (sig.boa || sig.notaBaixa) { if (t.sinal?.fase !== 'pico-passou') log(`PICO JÁ PASSOU: ${t.symbol} está ${pp.abaixo.toFixed(0)}% abaixo do topo (há ${Math.round(pp.ha)} min). Não compra.`); sig = { ...sig, boa: false, notaBaixa: false, fase: 'pico-passou', titulo: 'Pico já passou', msg: pp.msg }; }
          if (ag?.boa) ag = null;
        }
      }
      if (ag) {
        const pa = t.sinalAgr;
        t.sinalAgr = { tipo: 'entrada', ...ag, at: pa && pa.key === ag.key && pa.fase === ag.fase ? pa.at : now };
        if (t.sinalAgr.at === now) log(`SINAL (agressivo): ${t.symbol} - ${ag.titulo}`);
      } else delete t.sinalAgr;
    }
    if (!sig) { delete t.sinal; continue; }
    // "desde" muda só quando a fase muda (para o painel avisar uma vez)
    sig.at = prev && prev.tipo === sig.tipo && prev.fase === sig.fase && prev.key === sig.key ? prev.at : now;
    t.sinal = sig;
    // 21/11 (pedido da Kerah): favorita chegou na zona de Fibonacci de 50% a 61,8% da subida: avisa no celular,
    // uma vez por correção (a chave do sinal muda quando a moeda faz um topo novo)
    if (t.favorita && !t.held && sig.tipo === 'entrada' && sig.retr >= 0.48 && sig.retr <= 0.64 && t.favZona !== (sig.key || '')) {
      t.favZona = sig.key || '';
      const r = Math.round(sig.retr * 1000) / 10;
      log(`FAVORITA NA ZONA: ${t.symbol} corrigiu ${String(r).replace('.', ',')}% da subida`);
      await avisar({ titulo: `Favorita na zona 50-61,8%: ${t.symbol}`, texto: `Corrigiu ${String(r).replace('.', ',')}% da subida. ${sig.boa ? 'E já deu Boa entrada.' : 'Ainda esperando a reação (vela verde e compras) para a Boa entrada.'}`, mint: t.mint, chave: `favzona-${t.mint}-${sig.key || now}` });
    }
    // 19/11: moeda do Radar na zona (ou travada) sem virar "Boa entrada": anota o motivo quando ele muda
    if (sig.tipo === 'entrada' && !sig.boa && !t.held && t.status === 'aprovada' && ['zona', 'pico-passou', 'repetido'].includes(sig.fase)) {
      const mot = sig.fase === 'pico-passou' ? ['pico já passou'] : sig.fase === 'repetido' ? ['sinal repetido'] : sig.faltou?.length ? sig.faltou : [sig.titulo];
      const k = `${sig.fase}|${mot.map((x) => x.replace(/\(.*\)/, '')).join(',')}`;
      if (t.zonaMot !== k) {
        t.zonaMot = k;
        t.zonaHist = [...(t.zonaHist || []), { at: now, px: t.priceUsd, fase: sig.fase, faltou: mot }].slice(-30);
        log(`NA ZONA SEM ENTRADA: ${t.symbol} - ${mot.join('; ')}`);
      }
    } else if (t.zonaMot && !(sig.tipo === 'entrada' && sig.fase === 'zona')) delete t.zonaMot;
    if (sig.tipo === 'entrada' && (sig.boa || sig.notaBaixa) && sig.at === now) t.boa = { at: now, px: t.priceUsd, max: t.priceUsd, key: sig.key };
    if (sig.at === now && (sig.boa || sig.bom || sig.ruim)) log(`SINAL: ${t.symbol} - ${sig.titulo}`);
    if (sig.tipo === 'entrada' && sig.boa && sig.at === now && t.status === 'aprovada' && !t.held)
      await avisar({ titulo: `Boa entrada: ${t.symbol}`, texto: [sig.titulo, sig.msg].filter(Boolean).join('. '), mint: t.mint, chave: `boa-${t.mint}-${sig.key || now}` });
  }

  // 6b. Venda no lucro: posições pequenas (sem ordem limite possível) vendem 100% ao bater o alvo
  if (trader?.canTakeProfit) {
    const L = cfg.venda.lucro;
    for (const t of Object.values(tokens)) {
      const p = t.position;
      if (!t.held || t.segurar || !p?.known || t.takeProfit?.ok || (t.takeProfit?.tries || 0) >= 3) continue;
      if (!(p.costOpenUsd > 0) || !((t.heldAmount || 0) * (t.priceUsd || 0) >= (cfg.venda?.valorMinimoUsd ?? 1)) || p.costOpenUsd >= L.ateUsd || !(p.openPnlPct >= L.alvoPct)) continue;
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
  // 20/11: simulação da entrada rápida (vigia de entrada, só simulação) vai para os dados do painel
  try {
    const er = JSON.parse(await (await import('node:fs/promises')).readFile('/tmp/faro-entrada.json', 'utf8'));
    if (er && Array.isArray(er.closed)) state.simRapida = { open: er.open || [], closed: (er.closed || []).slice(0, 300), stats: er.stats, startedAt: er.startedAt, updatedAt: er.updatedAt };
  } catch {}
  for (const [mint, a] of Object.entries(vig?.sold || {})) {
    const t = tokens[mint]; if (!t || !a || t.watchSell?.at === a.at) continue;
    t.watchSell = a;
    // Saiu no stop (perda, móvel ou queda forte): a moeda segue vigiada para uma possível reentrada no fundo
    if (a.ok && ['stop-perda', 'stop-movel', 'vigia'].includes(a.kind)) t.reentry = { at: a.at, kind: a.kind, exitPx: t.priceUsd || null };
    if (a.ok) log(`Vigia vendeu 100% de ${t.symbol}: ${a.why}${a.outSol ? ` (${a.outSol.toFixed(4)} SOL)` : ''}`);
  }
  // Vendas parciais da escada de realização (+30% / +50% / +80%)
  for (const a of vig?.partial || []) {
    const t = tokens[a.mint]; if (!t || (t.partials || []).some((x) => x.sig === a.sig)) continue;
    t.partials = [...(t.partials || []), a].slice(-10);
    log(`Vigia vendeu ${a.frac}% de ${t.symbol}: ${a.why}${a.outSol ? ` (${a.outSol.toFixed(4)} SOL)` : ''}`);
    t.safety = mergeSafety(t.safety, [{ id: 'parcial-' + a.sig.slice(0, 8), level: 'info', at: a.at, msg: `Robô realizou lucro: vendeu ${a.frac}% do que sobrou por ${a.outSol?.toFixed(4)} SOL. Motivo: ${a.why}. O resto segue com o stop móvel.`, sig: a.sig }]);
  }
  for (const t of Object.values(tokens)) {
    const a = t.watchSell; if (!a || !t.safety || a.dust) continue; // resto sem valor: sem aviso
    const msg = a.nada ? `A vigia ia vender (${a.why}), mas a moeda já tinha saído da carteira (venda feita antes, fora do robô)`
      : a.skipped ? `${a.kind === 'golpe' ? 'Golpe' : 'Sinal de venda'} (${a.why}), mas a operação é menor que US$ ${cfg.venda?.valorMinimoProtecaoUsd ?? 0.25}: não compensa vender`
      : a.ok ? `Robô vendeu 100%${a.outSol ? ` por ${a.outSol.toFixed(4)} SOL` : ''}. Motivo: ${a.why}`
      : `Vigia rápida tentou vender (${a.why}) e falhou: ${a.erro}. Venda manualmente!`;
    // Golpe no contrato = perigo; queda de liquidez = atenção; queda de preço ou lucro = só aviso (a moeda pode seguir viva)
    let lvl = a.kind === 'golpe' ? 'danger' : /liquidez/.test(a.why || '') ? 'warn' : 'info';
    // "LP destravada" com a liquidez ainda de pé no mercado: foi alarme falso do RugCheck, a moeda não fica marcada como perigo
    const falso = lpFalseAlarm(t, a);
    if (falso) lvl = 'info';
    t.safety = mergeSafety(t.safety, [{ id: 'vigia', level: a.skipped || a.nada ? 'info' : lvl, at: a.at, msg: falso ? `${msg} (depois se viu que foi alarme falso: a liquidez seguiu no mercado)` : msg, ...(a.sig ? { sig: a.sig } : {}) }, ...t.safety.alerts.filter((x) => x.id !== 'vigia')], now);
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

  // 6c3. Recupera o SOL parado em contas de moeda zeradas (o aluguel que a compra pagou e a venda não devolveu)
  if (trader?.canClean && trader.closeEmpty) {
    state.contas = state.contas || { fechadas: 0, sol: 0, naoFecham: [] };
    try {
      const r = await trader.closeEmpty(cfg.venda?.contasPorRodada ?? 10, new Set(state.contas.naoFecham));
      if (r.closed) {
        state.contas.fechadas += r.closed; state.contas.sol = +(state.contas.sol + r.sol).toFixed(9); state.contas.at = now;
        log(`Recuperou ${r.sol.toFixed(4)} SOL fechando ${r.closed} conta(s) de moeda vazia${r.left > 0 ? ` (faltam ${r.left})` : ''}`);
      }
      if (r.bad?.length) state.contas.naoFecham = [...new Set([...state.contas.naoFecham, ...r.bad])].slice(-50);
    } catch (e) { log(`Não consegui fechar as contas vazias: ${e.message}`, true); }
  }

  // 6d. Compra no sinal de boa entrada: interruptor (memo assinado pela sua carteira), simulação e compra real
  if (wallet && api.getMemos && api.txSigner) {
    try {
      const sw = await readSwitch(await api.getMemos(wallet), async (sig) => (await api.txSigner(sig)) === wallet);
      if (sw && (!state.autoCompra || state.autoCompra.sig !== sw.sig)) log(`Compra automática ${sw.on ? 'LIGADA' : 'DESLIGADA'} pelo painel`);
      if (sw) state.autoCompra = sw;
    } catch (e) { log(`Não consegui ler o interruptor da compra automática: ${e.message}`, true); }
  }
  // Perfil de operação (Conservador ou Agressivo), trocado pelo painel com um memo assinado pela carteira
  if (wallet && api.getMemos && api.txSigner) {
    try {
      const pf = await readProfile(await api.getMemos(wallet), async (sig) => (await api.txSigner(sig)) === wallet);
      if (pf && (!state.perfil || state.perfil.sig !== pf.sig)) log(`Perfil de operação: ${pf.name.toUpperCase()} (trocado pelo painel)`);
      if (pf) state.perfil = pf;
    } catch (e) { log(`Não consegui ler o perfil de operação: ${e.message}`, true); }
  }
  // Favoritas enviadas pelo painel
  if (wallet && api.getMemos && api.txSigner) {
    try {
      const fv = await readFavs(await api.getMemos(wallet), async (sig) => (await api.txSigner(sig)) === wallet);
      if (fv && (!state.favs || state.favs.sig !== fv.sig)) { log(`Favoritas recebidas do painel: ${fv.mints.length}`); state.favsOut = []; }
      if (fv) state.favs = fv;
    } catch (e) { log(`Não consegui ler as favoritas: ${e.message}`, true); }
  }
  // Favorita com golpe confirmado no contrato (mint/freeze/liquidez sumindo) sai da lista sozinha
  for (const t of Object.values(tokens)) if (t.favorita && (t.safety?.alerts || []).some((a) => a.level === 'danger' && ['rugged', 'mint', 'freeze', 'liq-sumiu'].includes(a.id))) {
    state.favsOut = [...new Set([...(state.favsOut || []), t.mint])]; delete t.favorita; log(`Favorita ${t.symbol} saiu da lista: golpe no contrato`);
  }
  const perfil = ['agressivo', 'segurar'].includes(state.perfil?.name) ? state.perfil.name : 'conservador';
  const cfgAgr = profileCfg(cfg, 'agressivo');
  // 21/11 (pedido da Kerah): perfil Segurar. Entra nos mesmos sinais do Conservador e segura até +alvoPct (150%):
  // sem stop, sem stop móvel, sem venda parcelada, sem venda por golpe. Só vale para as compras do robô feitas com ele
  const cfgSeg = profileCfg(cfg, 'segurar');
  const agrList = entryCandidates(tokens, cfgAgr, now, { agr: true });
  const buyList = entryCandidates(tokens, cfg, now);
  // Moedas que só vieram pelos rankings da Jupiter: por enquanto só Radar e simulação (config busca.jupiter.compraReal)
  const realList = (perfil === 'agressivo' ? agrList : buyList).filter((t) => !t.soJupiter || cfg.busca?.jupiter?.compraReal === true);
  const realCfg = perfil === 'agressivo' ? cfgAgr : perfil === 'segurar' ? cfgSeg : cfg;
  // Teste (só simulação): nota da aprovação em vez da de agora, para sinais que a correção derrubou abaixo de 70
  const notaList = cfg.simulacao?.notaAprovacao?.ligado === false ? [] : entryCandidates(tokens, cfg, now, { byApproval: true }).filter((t) => !buyList.includes(t)).map((t) => ({ ...t, _notaAprov: true }));
  // Simulação: os mesmos sinais da compra real + (modo curva) moedas na curva da pump.fun com boa entrada
  const curveList = Object.values(tokens).filter((t) => curveOn(t) && !t.held && t.sinal?.tipo === 'entrada' && t.sinal.boa && now - (t.sinal.at || 0) <= 10 * 60000).map((t) => Object.assign(t, { _simCurva: true }));
  // rompimentos frescos (até 10 min) em moedas do radar, com as mesmas travas de segurança da lista de compra
  const rompList = Object.values(tokens).filter((t) => t.romp && now - t.romp.at <= 10 * 60000 && !t.held && t.status === 'aprovada' && t.safety?.level !== 'danger' && t.dexId !== 'pumpfun' && !buyList.includes(t));
  try { simStep({ state, tokens, candidates: [...buyList, ...curveList.filter((t) => !buyList.includes(t)), ...notaList], rompidas: rompList, cfg, now, log }); } catch (e) { log(`Simulação falhou: ${e.message}`, true); }
  // Maré do mercado (regra em teste): a maioria das moedas do Radar caindo no dia
  { const prevM = state.mare?.vermelha; state.mare = marketTide(tokens, now, cfg.regrasEmTeste?.mare);
    if (state.mare.vermelha !== !!prevM) log(`Maré do mercado: ${state.mare.vermelha ? 'VERMELHA' : 'normal'} (${state.mare.red} de ${state.mare.n} moedas do Radar caindo no dia)`); }
  // Perfil Crazy (só simulação): primeira correção depois do Radar, US$ 3, giro rápido
  try {
    const solUsdNow = Object.values(tokens).map((t) => (t.priceNative > 0 ? t.priceUsd / t.priceNative : 0)).find((v) => v > 0) || 0;
    simCrazy({ state, tokens, cfg, now, log, solUsd: solUsdNow });
  } catch (e) { log(`Simulação enlouquecida falhou: ${e.message}`, true); }
  // Simulação do perfil agressivo, sempre rodando ao lado (para comparar antes e depois de trocar)
  try { simStep({ state, key: 'simAgr', label: 'SIMULAÇÃO AGRESSIVO', tokens, candidates: agrList, rompidas: [], cfg: cfgAgr, now, log }); } catch (e) { log(`Simulação agressiva falhou: ${e.message}`, true); }
  // Simulação do perfil Segurar, sempre rodando ao lado (mesmas entradas do Conservador, sai só em +150%)
  if (cfgSeg.segurar?.ligado) { try { simStep({ state, key: 'simSeg', label: 'SIMULAÇÃO SEGURAR', tokens, candidates: buyList, rompidas: [], cfg: cfgSeg, now, log }); } catch (e) { log(`Simulação Segurar falhou: ${e.message}`, true); } }
  if (trader?.canBuy && state.autoCompra?.on && realList.length) {
    try {
      const limits = buyLimits(state, tokens, realCfg, now);
      // 20/11 (GTE): RugCheck novo, sem cache, nas primeiras candidatas, antes de gastar SOL
      let okList = realList;
      if (api.getRugReport && limits.room > 0 && !limits.stopped) {
        okList = [];
        for (const t of realList.filter((x) => !limits.bought.has(x.mint) || limits.reentryOk?.has(x.mint)).slice(0, limits.room + 2)) {
          let r = null;
          try { r = await api.getRugReport(t.mint); } catch (e) { log(`RugCheck antes da compra falhou em ${t.symbol}: ${e.message}`, true); }
          const why = preBuyBlock(r, realCfg);
          if (why) {
            log(`COMPRA CANCELADA: ${t.symbol} - ${why}`);
            const tt = tokens[t.mint] || t; // a lista do agressivo é de cópias
            tt.safety = tt.safety || { level: 'ok', alerts: [] };
            tt.safety.alerts = [...(tt.safety.alerts || []).filter((a) => a.id !== 'pre-compra'), { id: 'pre-compra', level: 'danger', at: now, msg: `Compra automática cancelada: ${why}` }];
            tt.safety.level = 'danger';
          } else okList.push(t);
          if (okList.length >= limits.room) break;
        }
      }
      const trades = okList.length ? await trader.maybeBuy(okList, state, realCfg, log, limits) : [];
      state.trades.push(...trades);
      for (const x of trades.filter((y) => y.ok && y.sig)) await avisar({ titulo: `Robô comprou: ${x.symbol}`, texto: `Compra automática de ${(x.sol || 0).toFixed(4)} SOL no sinal de boa entrada. A vigia e os stops já estão protegendo.`, mint: x.mint, chave: `compra-${x.sig}` });
      // Compra feita agora: já entra na carteira desta rodada, com entrada e posição (antes só aparecia na rodada seguinte, 5 min depois)
      const okBuys = trades.filter((x) => x.ok && x.sig);
      // 26/11 (pedido da Kerah): de madrugada (horário de Brasília) a compra do Segurar entra no Normal; acordada, ela muda à mão
      const M = cfgSeg.segurar?.madrugada || {};
      const horaBR = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
      const madrugada = M.ligado !== false && horaBR >= (M.de ?? 0) && horaBR < (M.ate ?? 6);
      if (perfil === 'segurar' && madrugada) for (const b of okBuys) log(`${b.symbol}: comprada de madrugada (${horaBR}h) no perfil Segurar. Entra no Normal; dá para mudar o alvo no painel.`);
      if (perfil === 'segurar' && !madrugada) for (const b of okBuys) if (tokens[b.mint] && !tokens[b.mint].segurar) tokens[b.mint].segurar = { desde: now, alvoPct: cfgSeg.segurar?.alvoPct ?? 150, sig: b.sig };
      if (okBuys.length && wallet && state.wallet && api.getRecentOps) {
        try {
          if (api.sleep) await api.sleep(2500);
          const recent = await api.getRecentOps(wallet, 8);
          let solUsdNow = null; try { solUsdNow = api.getSolUsd ? await api.getSolUsd() : null; } catch {}
          for (const b of okBuys) {
            if (perfil === 'segurar' && !madrugada && tokens[b.mint]) { tokens[b.mint].segurar = { desde: now, alvoPct: cfgSeg.segurar?.alvoPct ?? 150, sig: b.sig }; log(`${b.symbol}: comprada no perfil SEGURAR. Só vende em +${tokens[b.mint].segurar.alvoPct}%.`); }
            const op = recent.find((o) => o.sig === b.sig && o.mint === b.mint); const t = tokens[b.mint];
            if (!op || !t) continue;
            if (solUsdNow && !op.solUsd) op.solUsd = solUsdNow;
            if (!state.wallet.ops.some((o) => o.sig === op.sig && o.mint === op.mint)) state.wallet.ops.push(op);
            if (!t.held) t.heldSince = now;
            t.held = true; t.closedOp = false; t.heldAmount = (t.heldAmount || 0) + op.tokens; t.status = t.status === 'nova' ? 'carteira' : t.status;
            const myOps = state.wallet.ops.filter((o) => o.mint === t.mint);
            t.position = positionFrom(myOps, t.heldAmount, t.priceNative, t.priceUsd, solRef());
            t.history = myOps.slice(-50).reverse().map((o) => ({ sig: o.sig, at: o.at, tokens: o.tokens, sol: o.sol }));
          }
        } catch (e) { log(`Não consegui registrar a compra na hora: ${e.message}`, true); }
      }
    } catch (e) { log(`Módulo de compra falhou: ${e.message}`, true); }
  }

  // 21/11: a reprovação manual vale mesmo se alguma etapa acima mexeu no status (ex.: simulação aberta nela)
  for (const t of Object.values(tokens)) if (t.reprovadaManual && !t.held && t.status !== 'reprovada') { t.status = 'reprovada'; t.reasons = ['Reprovada por você no painel']; delete t.sinal; delete t.sinalAgr; }

  // 21/11: alvo do Segurar escolhido moeda por moeda no painel (vale para as compras dela e do robô)
  if (api.lerSegurar) {
    const esc = await api.lerSegurar().catch(() => ({}));
    for (const [mint, e] of Object.entries(esc)) {
      const t = tokens[mint];
      if (!t || (!t.held && now - e.at > 10 * 60000)) { await api.definirSegurar(mint, null).catch(() => {}); continue; } // posição fechada: a escolha sai
      if (!t.held) continue;
      const antes = t.segurar?.alvoPct || 0;
      if (e.alvoPct > 0) t.segurar = { ...(t.segurar || { desde: e.at }), alvoPct: e.alvoPct, manual: true };
      else delete t.segurar;
      if (antes !== (e.alvoPct || 0)) log(`${t.symbol}: ${e.alvoPct > 0 ? `modo Segurar ${e.alvoPct >= 999 ? 'Infinito' : `até +${e.alvoPct}%`} (escolhido no painel)` : 'saiu do modo Segurar, volta às regras normais (escolhido no painel)'}`);
    }
  }
  // Posição do Segurar fechada (vendeu tudo): a marca sai, e uma compra futura segue o perfil da hora
  for (const t of Object.values(tokens)) if (t.segurar && !t.held && now - (t.segurar.desde || 0) > 10 * 60000) delete t.segurar;

  // 21/11: servidor do painel pega código novo sozinho
  if (api.atualizarPainel) await api.atualizarPainel(log).catch(() => {});

  // Aviso das compras das carteiras seguidas (agora a moeda já tem nome, nota e situação no Faro)
  for (const s of seguidasNovas) {
    const t = tokens[s.mint]; if (!t) continue;
    const sit = t.status === 'aprovada' ? 'Já está no Radar' : t.status === 'reprovada' ? `Reprovada no Faro: ${(t.reasons || [])[0] || 'não passou nos critérios'}` : 'Em análise no Faro';
    await avisar({ titulo: `${s.apelido} comprou ${t.symbol || 'uma moeda nova'}`, texto: `${s.sol.toFixed(3)} SOL.${t.score != null ? ` Nota ${Math.round(t.score)}.` : ''} ${sit}.`, mint: s.mint, chave: `seguida-${s.sig}-${s.mint}` });
  }

  // 7. Limpeza
  const rejected = Object.values(tokens).filter((t) => t.status === 'reprovada').sort((a, b) => (b.rejectedAt || 0) - (a.rejectedAt || 0));
  const simNow = new Set([...(state.sim?.open || []), ...(state.simAgr?.open || []), ...(state.simLouco?.open || []), ...(state.simSeg?.open || [])].map((o) => o.mint));
  for (const t of rejected.slice(MAX_REJECTED_KEPT)) if (!simNow.has(t.mint)) delete tokens[t.mint];
  for (const t of Object.values(tokens)) {
    if (t.held || t.favorita || simNow.has(t.mint)) { delete t._rug; continue; }
    if (t.status === 'carteira' && now - (t.soldAt || t.firstSeen || now) > 86400000) delete tokens[t.mint];
    else if (t.status === 'aprovada' && now - (t.approvedAt || now) > trackMs * 3) delete tokens[t.mint];
    else if (!['aprovada', 'carteira'].includes(t.status) && now - (t.firstSeen || now) > 3 * 86400000) delete tokens[t.mint];
    else if (t.status === 'reprovada' || t.status === 'aprovada') delete t._rug;
    if (!monitored(t)) { delete t.candles; delete t.hist; }
  }
  state.trades = state.trades.slice(-200);

  // Avisos no celular (push, só no servidor): moeda nova no Radar e perigo numa moeda que você tem
  for (const t of newlyApproved) await avisar({ titulo: `Nova no Radar: ${t.symbol}`, texto: `Aprovada com nota ${t.score ?? '-'}. Espere a correção: o Faro avisa a boa entrada.`, mint: t.mint, chave: `nova-${t.mint}` });
  for (const t of Object.values(tokens)) {
    if (!t.held || (t.heldAmount || 0) * (t.priceUsd || 0) < 0.25) continue;
    for (const a of (t.safety?.alerts || []).filter((x) => x.level === 'danger' && !['vigia', 'auto-venda'].includes(x.id) && now - (x.at || 0) < 15 * 60000))
      await avisar({ titulo: `Perigo: ${t.symbol}`, texto: a.msg, mint: t.mint, chave: `perigo-${t.mint}-${a.id}`, urgente: true });
  }

  const counts = Object.values(tokens).reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
  state.updatedAt = now;
  if (!wallet) delete state.wallet;
  // Quais transações foram do robô (compra automática, vigia, venda por golpe, lucro, escada). O resto é manual (você)
  {
    const R = new Set(state.roboSigs || []);
    for (const x of state.trades || []) if (x.ok && x.sig) R.add(x.sig);
    for (const t of Object.values(tokens)) {
      for (const a of [t.watchSell, t.autoSell, t.takeProfit, ...(t.partials || [])]) if (a?.ok !== false && a?.sig) R.add(a.sig);
    }
    for (const a of Object.values(vig?.sold || {})) if (a?.ok && a.sig) R.add(a.sig);
    for (const a of vig?.partial || []) if (a?.sig) R.add(a.sig);
    state.roboSigs = [...R].slice(-800);
  }
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
    perfil: { name: ['agressivo', 'segurar'].includes(state.perfil?.name) ? state.perfil.name : 'conservador', at: state.perfil?.at || null },
    autoSell: !!trader?.canSell,
    autoVenda: state.autoVenda ? { on: state.autoVenda.on, at: state.autoVenda.at } : null,
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

// Venda por "liquidez destravada" em que a liquidez continuou no mercado (80%+ da referência): falha do RugCheck
export function lpFalseAlarm(t, a) {
  return !!(a && a.kind === 'golpe' && /destravada/.test(a.why || '') && t.entryLiquidityUsd > 0 && t.liquidityUsd >= t.entryLiquidityUsd * 0.8);
}

// Despejo depois da aprovação. hist = [[ms, preço], ...] a cada rodada (~5 min)
export function dumpReason(t, px, now) {
  if (!(px > 0)) return null;
  const recent = (t.hist || []).filter(([ms]) => now - ms <= 20 * 60000).map(([, p]) => p).filter((p) => p > 0);
  const top = Math.max(...recent, 0);
  if (top > 0 && px <= top * 0.4) return `Despejo: caiu ${((1 - px / top) * 100).toFixed(0)}% em menos de 20 minutos`;
  const holders = (t.safety?.alerts || []).filter((a) => ['insiders', 'concentracao'].includes(a.id) && (!t.approvedAt || a.at >= t.approvedAt));
  if (t.sinal?.fase === 'quebrou' && holders.length) return `Perdeu a estrutura (abaixo de 78,6%) e ${holders.map((a) => a.msg.charAt(0).toLowerCase() + a.msg.slice(1)).join('; ')}`;
  return null;
}
