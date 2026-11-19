// Vigia rápida: roda entre uma rodada e outra do robô (no lugar da espera de ~5 min).
// A cada ~10s olha preço e liquidez das moedas da sua carteira e vende 100% sozinho se:
//   - o preço cair X% a partir do pico desde a compra, ou
//   - a liquidez cair Y% em até 5 minutos.
// Usa a chave do robô (sem Phantom, sem confirmações). Só age se a posição valer o mínimo configurado.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decrypt } from './vault.mjs';
import { createTrader } from './trader.mjs';
import { getRugReport, getWalletHoldings, getRecentOps } from './api.mjs';
import { summarizeRug, scamSignals, isLpSignal } from './analyze.mjs';
import { weakSignals, realizeCheck } from './signals.mjs';
import { avisar } from './push.mjs';

const seconds = Math.max(0, Number(process.argv[2]) || 0);
const until = Date.now() + seconds * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = '/tmp/faro-vigia.json'; // memória entre as esperas (picos, liquidez recente e vendas feitas)
const log = (m, e) => (e ? console.error : console.log)(`[vigia ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function idle() { const left = until - Date.now(); if (left > 0) await sleep(left); }

const cfg = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const V = cfg.venda?.vigia || {};
const password = process.env.FARO_SENHA || '';
const wallet = (process.env.FARO_WALLET || '').trim();
if (!V.ligado || process.env.VIGIA === 'false' || !password || !wallet) { await idle(); process.exit(0); }

let state;
// No servidor a vigia roda junto com a rodada, que pode estar gravando o arquivo agora: tenta de novo algumas vezes
for (let i = 0; i < 4 && !state; i++) {
  try { state = decrypt(JSON.parse(await readFile(path.join(root, 'docs', 'data.enc.json'), 'utf8')), password); }
  catch { await new Promise((r) => setTimeout(r, 1500)); }
}
if (!state) { log('Não consegui abrir os dados; só esperando.', true); await idle(); process.exit(0); }

cfg.carteira = { enderecoPublico: wallet };
const trader = await createTrader(cfg, log);
if (!trader?.canWatch) { await idle(); process.exit(0); }

let mem = {};
try { mem = JSON.parse(await readFile(MEM, 'utf8')); } catch {}
mem.peak = mem.peak || {}; mem.liq = mem.liq || {}; mem.sold = mem.sold || {}; mem.ladder = mem.ladder || {}; mem.partial = mem.partial || [];
const save = () => writeFile(MEM, JSON.stringify(mem)).catch(() => {});

const dropPct = V.quedaDoPicoPct ?? 40;
const hardDrop = V.quedaSemConfirmacaoPct ?? 60;
const confLiq = V.confirmaLiquidezPct ?? 15;
const confSells = V.confirmaVendasPct ?? 60;
const liqPct = V.quedaLiquidezPct ?? 30;
const liqWin = (V.janelaLiquidezMin ?? 5) * 60000;
const minUsd = cfg.venda?.valorMinimoUsd ?? 1;
// Proteções (stop de perda, stop móvel, golpe, queda forte): vendem a partir de US$ 0,25. A taxa da venda é ~US$ 0,01,
// então vale sair. O mínimo de US$ 1 fica só para realizar lucro (17/11: JVOLT caiu -30% valendo US$ 0,84 e o robô não vendeu)
const minProtect = cfg.venda?.valorMinimoProtecaoUsd ?? 0.25;
const PROTECT = new Set(['stop-perda', 'stop-movel', 'golpe', 'vigia']);
const dustUsd = cfg.venda?.restoSemValorUsd ?? 0.05;
const SM = cfg.venda?.stopMovel || {};
const trailOn = SM.ligado === true;
const SP = cfg.venda?.stopPerda || {};
const lossOn = SP.ligado === true;
const lossPct = SP.pct ?? 25;
// Confirmação: guarda quando o preço furou e só libera a venda depois de N segundos seguidos abaixo
function confirmBelow(t, now, secs, label) {
  mem.below = mem.below || {};
  if (!mem.below[t.mint]) { mem.below[t.mint] = now; log(`${t.symbol}: abaixo do ${label}, confirmando por ${secs}s antes de vender...`); }
  return now - mem.below[t.mint] >= secs * 1000;
}
const RZ = cfg.venda?.realizar || {};
const realizeOn = RZ.ligado === true && process.env.LUCRO_AUTO !== 'false';

// Moedas que você tem agora, com o pico desde a compra (velas do robô + o que a vigia já viu)
// Uma venda feita antes de uma nova compra da mesma moeda não conta mais
// (também vale o que ficou registrado nas rodadas anteriores, para não repetir o mesmo aviso)
// "Não vendida por valer pouco" não tira a moeda da vigia para sempre: depois de 10 min ela volta a ser vigiada (pode ter subido)
// Venda antiga não conta se a moeda foi comprada de novo depois (inclusive à mão, antes do robô ler a compra nova)
const done = (t) => [mem.sold[t.mint], t.watchSell].some((x) => x && x.at > Math.max(t.position?.lastBuyAt || 0, t.heldSince || 0, t.reboughtAt || 0) && (!x.skipped || Date.now() - x.at < (x.dust ? 6 * 3600000 : 600000)));
let held = Object.values(state.tokens || {}).filter((t) => t.held && t.heldAmount > 0 && !done(t));
const L = cfg.venda?.lucro || {};
const lucroOn = L.ligado === true && process.env.LUCRO_AUTO !== 'false';
const golpeOn = cfg.venda?.automatica === true && process.env.AUTO_SELL === 'true';
let lastHoldings = 0, lastRug = 0, lastAuth = 0;
mem.base = mem.base || {};

// Carteira ao vivo: moedas compradas depois da última rodada também entram na vigia
// Compra recente que o robô ainda não leu (a posição só aparece na rodada seguinte): preço médio de entrada em SOL,
// lido direto da blockchain, para o stop de perda já valer desde o primeiro minuto (17/11: Privium)
const liveEntry = {};
async function refreshEntries() {
  // Só compras recentes (até 30 min) e no máximo 1 consulta a cada 3 min: antes, um resto antigo sem compra recente
  // fazia 15 consultas ao RPC a cada 30 s e o robô levava "pausa (429)" ao ler a carteira (17/11)
  const nowE = Date.now();
  const need = held.filter((t) => ((!(t.position?.known && t.position.costOpenUsd > 0) && nowE - Math.max(t.heldSince || 0, t.reboughtAt || 0) < 30 * 60000) || t.staleCost)
    && !liveEntry[t.mint] && nowE - (refreshEntries.tried?.[t.mint] || 0) > (t.staleCost ? 20000 : 180000));
  if (!need.length || !wallet) return;
  refreshEntries.tried = refreshEntries.tried || {}; for (const t of need) refreshEntries.tried[t.mint] = nowE;
  try {
    const ops = await getRecentOps(wallet, 15);
    for (const t of need) {
      // Só a operação aberta: compras depois da última vez que a moeda zerou na carteira
      let tok = 0, sol = 0, net = 0;
      for (const o of ops.filter((x) => x.mint === t.mint && x.tokens).sort((a, b) => a.at - b.at)) {
        if (net <= (t.heldAmount || 0) * 0.01) { tok = 0; sol = 0; net = 0; }
        net += o.tokens; if (o.tokens > 0 && o.sol < 0) { tok += o.tokens; sol -= o.sol; }
      }
      if (t.staleCost && tok < (t.heldAmount || 0) * 0.8) { log(`${t.symbol}: não achei todas as compras recentes; segurando só pelas proteções de golpe e queda até a próxima rodada`); continue; }
      if (tok > 0 && sol > 0) { liveEntry[t.mint] = sol / tok; log(`${t.symbol}: entrada lida da blockchain (${(sol / tok).toExponential(3)} SOL por moeda); stop de perda já vale`); }
    }
  } catch (e) { log(`não consegui ler as compras recentes: ${e.message}`, true); }
}
async function refreshHoldings() {
  try {
    const list = await getWalletHoldings(wallet);
    const map = new Map(list.map((h) => [h.mint, h]));
    // Comprou mais depois da última rodada do robô: o custo guardado não inclui a compra nova. Usar ele dava lucro falso
    // (17/11: JALU, US$ 5 + US$ 10 comprados, o robô viu "+208% sobre US$ 5" e vendeu tudo 30 s depois, três vezes)
    held = held.filter((t) => map.has(t.mint)).map((t) => {
      const amt = map.get(t.mint).amount, base = t.snapAmount ?? t.heldAmount ?? 0;
      const stale = t.staleCost || amt > base * 1.02 + 1e-9;
      if (stale && !t.staleCost) { delete liveEntry[t.mint]; if (refreshEntries.tried) delete refreshEntries.tried[t.mint]; log(`${t.symbol}: compra nova depois da rodada; recalculando a entrada pela blockchain`); }
      return { ...t, snapAmount: base, heldAmount: amt, staleCost: stale };
    });
    for (const h of list) {
      if (held.some((t) => t.mint === h.mint)) continue;
      const old = state.tokens?.[h.mint] || { mint: h.mint, symbol: h.mint.slice(0, 6) };
      // Entrou na carteira (ou voltou) depois da rodada: o custo guardado é de outra operação, então não vale até ler a compra
      const stale = !!old.position?.known && Math.abs(h.amount - (old.heldAmount || 0)) > Math.max(1e-9, (old.heldAmount || 0) * 0.02);
      const t = { ...old, held: true, heldAmount: h.amount, snapAmount: h.amount, staleCost: stale || !old.held, position: old.position, isNew: !old.held, reboughtAt: old.held ? 0 : Date.now() };
      if (!old.held && mem.peak) { mem.peak[t.mint] = 0; if (mem.peakKey) mem.peakKey[t.mint] = 'recompra'; } // recompra depois de zerar: pico novo
      if (!done(t)) { held.push(t); log(`nova na carteira: ${t.symbol}`); }
    }
  } catch (e) { log(`não consegui ler a carteira: ${e.message}`, true); }
}

// Sinais de golpe no contrato: mint/freeze direto da blockchain (rápido) e RugCheck completo a cada minuto
async function contractCheck(now) {
  const out = {};
  if (!golpeOn || !held.length) return out;
  if (now - lastAuth >= 10000) {
    lastAuth = now;
    try {
      const r = await fetch(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [held.map((t) => t.mint), { encoding: 'jsonParsed' }] }), signal: AbortSignal.timeout(8000) }).then((x) => x.json());
      (r?.result?.value || []).forEach((acc, i) => {
        const t = held[i]; const info = acc?.data?.parsed?.info; if (!t || !info) return;
        const b = (mem.base[t.mint] = mem.base[t.mint] || { mint: info.mintAuthority != null, freeze: info.freezeAuthority != null });
        const why = [];
        if (!b.mint && info.mintAuthority != null) why.push('mint authority reativada (podem criar tokens novos)');
        if (!b.freeze && info.freezeAuthority != null) why.push('freeze authority reativada (podem congelar sua carteira)');
        if (why.length) out[t.mint] = why.join('; ');
      });
    } catch (e) { log(`checagem do contrato falhou: ${e.message}`, true); }
  }
  if (now - lastRug >= 60000) {
    lastRug = now;
    const lpSeen = [], rugSig = {};
    for (const t of held) {
      try {
        const sum = summarizeRug(await getRugReport(t.mint));
        if (!sum) continue;
        // Moeda nova na carteira: a primeira leitura vira a referência (o que já era assim na compra não conta)
        const mb = (mem.base[t.mint] = mem.base[t.mint] || {});
        if (!mb.rug) mb.rug = { lpLockedPct: sum.lpLockedPct, devPct: sum.devPct, mint: sum.mintAuthority != null, freeze: sum.freezeAuthority != null };
        const base = t.baseline || mb.rug;
        const sig = scamSignals(base, sum, cfg);
        if (sig.some(isLpSignal)) lpSeen.push(t.mint);
        if (sig.length) (rugSig[t.mint] = sig);
        await sleep(400);
      } catch (e) { if (e.rateLimited) break; }
    }
    // Várias moedas com "liquidez destravada" na mesma leitura = falha do RugCheck, não golpe
    const glitch = lpSeen.length > 1;
    if (glitch) log(`RugCheck disse liquidez destravada em ${lpSeen.length} moedas ao mesmo tempo: parece falha dele, ignorado.`);
    for (const [mint, sig] of Object.entries(rugSig)) {
      const keep = sig.filter((x) => !isLpSignal(x) || !glitch);
      if (keep.length) out[mint] = [out[mint], ...keep].filter(Boolean).join('; ');
    }
  }
  return out;
}

// Realização em escada (17/11, pedido da Kerah): +30% vende 1/3, +50% chega a 2/3, +80% vende o resto.
// Em cada faixa, se a alta estiver FORTE (sem nenhum sinal de fraqueza e perto do topo), segura e deixa para a próxima,
// até o +100%. Posição pequena (menos de US$ 1,50) não divide: vende tudo na primeira faixa sem força.
const ESCADA = cfg.venda?.escada || { ligado: true, faixas: [{ lucroPct: 30, vendido: 1 / 3 }, { lucroPct: 50, vendido: 2 / 3 }, { lucroPct: 80, vendido: 1 }], minimoDividirUsd: 1.5 };
async function sellPart(t, frac, why, px, target) {
  const L0 = mem.ladder[t.mint];
  if ((t.heldAmount || 0) * px * frac < 0.3) return sell(t, why, 'realizar', px); // pedaço pequeno demais: vende tudo
  log(`${t.symbol}: ${why}. Vendendo ${Math.round(frac * 100)}% do que sobrou...`);
  try {
    const s = await trader.sellAll(t.mint, frac);
    if (s.nada) return;
    L0.at = Date.now(); L0.sold = target;
    mem.partial.push({ mint: t.mint, at: Date.now(), sig: s.sig, outSol: s.outSol, why, frac: Math.round(frac * 100) });
    mem.partial = mem.partial.slice(-60);
    t.heldAmount = (t.heldAmount || 0) * (1 - frac);
    log(`VENDEU ${Math.round(frac * 100)}% de ${t.symbol} por ${s.outSol.toFixed(4)} SOL (tx ${s.sig.slice(0, 8)}...)`);
    await avisar({ titulo: `Robô realizou lucro: ${t.symbol}`, texto: `Vendeu ${Math.round(frac * 100)}% do que sobrou por ${s.outSol.toFixed(4)} SOL. Motivo: ${why}`, mint: t.mint, chave: `parcial-${s.sig}` });
  } catch (e) { log(`Venda parcial de ${t.symbol} falhou: ${e.message}`, true); }
}
function ladderStep(t, px, gainPx, weak, fromPeak) {
  if (!ESCADA.ligado || gainPx == null) return null;
  const buyAt = (t.position?.lastBuyAt || t.heldSince || 0) + (t.staleCost ? 1 : 0); // compra nova depois da rodada: escada recomeça
  let L0 = mem.ladder[t.mint];
  if (!L0 || L0.buyAt !== buyAt) L0 = mem.ladder[t.mint] = { buyAt, sold: 0 };
  const faixa = [...ESCADA.faixas].reverse().find((f) => gainPx >= f.lucroPct);
  if (!faixa || L0.sold >= faixa.vendido - 1e-6) return null;
  const forte = weak.length === 0 && fromPeak < 8;
  if (forte) { if (L0.holdLog !== faixa.lucroPct) { L0.holdLog = faixa.lucroPct; log(`${t.symbol}: +${gainPx.toFixed(0)}% e a alta segue forte. Segurando a faixa de +${faixa.lucroPct}% para a próxima.`); } return null; }
  const worth = (t.heldAmount || 0) * px;
  if (L0.sold === 0 && worth < (ESCADA.minimoDividirUsd ?? 1.5)) return { frac: 1, faixa, all: true };
  const frac = faixa.vendido >= 1 ? 1 : (faixa.vendido - L0.sold) / (1 - L0.sold);
  return { frac, faixa, target: faixa.vendido };
}
async function sell(t, why, kind, px) {
  // Posição que vale menos de US$ 1 agora: não vende sozinho (a taxa não compensa e ela pode ter um bump). Se passar a valer US$ 1+, as proteções voltam
  const worth = (t.heldAmount || 0) * px, cost = t.position?.known ? t.position.costOpenUsd || 0 : 0;
  // Resto sem valor (menos de US$ 0,05, ex.: AI e ANGSTIPAN em 16/11): nem avisa, só volta a olhar daqui a 6h
  if (worth < dustUsd) { mem.sold[t.mint] = { skipped: true, dust: true, at: Date.now(), why, worth, kind }; return; }
  if (worth < (PROTECT.has(kind) ? minProtect : minUsd)) { mem.sold[t.mint] = { skipped: true, at: Date.now(), why, worth, kind }; log(`${t.symbol}: ${why}, mas a operação é pequena (investido US$ ${cost.toFixed(2)}, vale US$ ${worth.toFixed(2)}). Não vendi.`); return; }
  log(`${t.symbol}: ${why}. Vendendo 100%...`);
  try {
    const s = await trader.sellAll(t.mint);
    // Nada na carteira: alguém vendeu antes (16/11: SENT saiu 7 s antes). Não é "Robô vendeu"
    if (s.nada) { mem.sold[t.mint] = { nada: true, at: Date.now(), why, kind }; log(`${t.symbol}: ia vender (${why}), mas a moeda já tinha saído da carteira.`); return; }
    mem.sold[t.mint] = { ok: true, at: Date.now(), sig: s.sig, outSol: s.outSol, why, kind };
    log(`VENDEU 100% de ${t.symbol} por ${s.outSol.toFixed(4)} SOL (tx ${s.sig.slice(0, 8)}...)`);
    await avisar({ titulo: `Robô vendeu: ${t.symbol}`, texto: `Vendeu 100% por ${s.outSol.toFixed(4)} SOL. Motivo: ${why}`, mint: t.mint, chave: `venda-${s.sig}`, urgente: kind === 'golpe' });
  } catch (e) {
    const tries = ((mem.retry || {})[t.mint] || 0) + 1;
    log(`Venda de ${t.symbol} falhou (${tries}/3): ${e.message}`, true);
    mem.retry = { ...(mem.retry || {}), [t.mint]: tries };
    if (tries >= 3) {
      mem.sold[t.mint] = { ok: false, at: Date.now(), why, erro: e.message, kind };
      await avisar({ titulo: `Venda falhou: ${t.symbol}`, texto: `O robô tentou vender (${why}) e não conseguiu: ${e.message}. Venda manualmente!`, mint: t.mint, chave: `falha-${t.mint}-${Math.floor(Date.now() / 3600000)}`, urgente: true });
    }
  }
}
// O pico é de cada operação: comprou de novo depois de zerar, o pico antigo some
// (18/11, Pussy: recomprou às 11:14 e a vigia vendeu por "caiu 70% do pico", que era o pico da operação das 10:37)
const peakKey = (t) => Math.max(t.position?.lastBuyAt || 0, t.heldSince || 0);
mem.peakKey = mem.peakKey || {};
const resetPeak = (t, base) => { const k = peakKey(t); if (mem.peakKey[t.mint] !== k) { mem.peakKey[t.mint] = k; mem.peak[t.mint] = base || 0; } };
for (const t of held) {
  const since = Math.max(t.position?.lastBuyAt || 0, t.heldSince || 0, t.reboughtAt || 0);
  resetPeak(t, 0);
  const candleTop = Math.max(0, ...(t.candles || []).filter((c) => c[0] >= since - 300000).map((c) => c[2]));
  mem.peak[t.mint] = Math.max(mem.peak[t.mint] || 0, t.position?.avgPriceUsd || 0, candleTop, t.priceUsd || 0);
}
await refreshHoldings(); await refreshEntries(); lastHoldings = Date.now();
if (!held.length && !wallet) { await idle(); process.exit(0); }
log(`vigiando ${held.map((t) => t.symbol).join(', ') || '(carteira vazia)'}: golpe ${golpeOn ? 'sim' : 'não'}, queda -${dropPct}% do pico com confirmação (ou -${hardDrop}% sem), liquidez -${liqPct}% em ${liqWin / 60000} min, lucro ${lucroOn ? `+${L.alvoPct}%` : 'não'}, stop móvel ${trailOn ? `a partir de +${SM.ativarPct ?? 30}%` : 'não'}, realizar ${realizeOn ? 'com +50%/+80% se perder força' : 'não'}`);

while (Date.now() < until) {
  if (Date.now() - lastHoldings >= 30000) { lastHoldings = Date.now(); await refreshHoldings(); await refreshEntries(); }
  const live = held.filter((t) => !done(t));
  if (!live.length) { await sleep(Math.min(10000, Math.max(0, until - Date.now()))); continue; }
  try {
    const scam = await contractCheck(Date.now());
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${live.map((t) => t.mint).join(',')}`, { signal: AbortSignal.timeout(8000) });
    const pairs = r.ok ? await r.json() : [];
    const now = Date.now();
    for (const t of live) {
      // Mesmo par que o robô usa; se não houver, o mais líquido
      const ps = (pairs || []).filter((p) => p?.baseToken?.address === t.mint);
      const p = ps.find((x) => x.pairAddress === t.pairAddress) || ps.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
      const px = Number(p?.priceUsd), liq = Number(p?.liquidity?.usd);
      if (!(px > 0)) continue;
      if (done(t)) continue;
      resetPeak(t, px);
      mem.peak[t.mint] = Math.max(mem.peak[t.mint] || 0, t.position?.avgPriceUsd || 0, px);
      const w = (mem.liq[t.mint] = (mem.liq[t.mint] || []).filter((x) => now - x[0] <= liqWin));
      if (liq > 0) w.push([now, liq]);
      const liqTop = Math.max(0, ...w.map((x) => x[1]));
      const fromPeak = (1 - px / mem.peak[t.mint]) * 100;
      const liqDrop = liqTop > 0 && liq > 0 ? (1 - liq / liqTop) * 100 : 0;
      // 1. Golpe no contrato  2. Queda forte  3. Lucro em posição pequena
      const cost = t.position?.known && !t.staleCost ? t.position.costOpenUsd : 0;
      const pxSol = /^W?SOL$/i.test(p?.quoteToken?.symbol || '') ? Number(p?.priceNative) : 0;
      // Ganho pelo preço de entrada (17/11, JALU: a Kerah vendeu 75% e a conta "valor que sobrou / custo de tudo" deu -77%
      // e disparou o stop no resto). Venda parcial muda a quantidade, não o preço de entrada. Sem preço médio, o custo é
      // proporcional à quantidade que ainda está na carteira.
      const avgPx = t.position?.known && !t.staleCost ? Number(t.position.avgPriceUsd) || 0 : 0;
      const posAmt = Number(t.snapAmount || t.position?.amount) || 0;
      const costNow = cost > 0 && posAmt > 0 && t.heldAmount < posAmt ? cost * (t.heldAmount / posAmt) : cost;
      const gain = avgPx > 0 ? (px / avgPx - 1) * 100 : costNow > 0 ? ((t.heldAmount * px) / costNow - 1) * 100 : liveEntry[t.mint] && pxSol > 0 ? (pxSol / liveEntry[t.mint] - 1) * 100 : null;
      // Stop móvel: o da última rodada, subindo junto com o pico que a vigia vê ao vivo (nunca desce)
      // 18/11 (Pussy): a vigia viu +36% às 10:40, mas o stop só ligou na rodada das 10:42. Agora a vigia liga o stop
      // móvel na hora em que vê a moeda passar de +ativarPct (pico medido só desde a compra atual, nunca de uma operação antiga)
      const buyAtT = t.position?.lastBuyAt || t.heldSince || 0;
      let PR = (mem.peakRun = mem.peakRun || {})[t.mint];
      if (!PR || PR.buyAt !== buyAtT) PR = mem.peakRun[t.mint] = { buyAt: buyAtT, pk: 0 };
      PR.pk = Math.max(PR.pk, px);
      let trailPx = 0;
      if (trailOn && !t.staleCost && t.position?.avgPriceUsd > 0) {
        const entry = t.position.avgPriceUsd;
        const liveOn = !t.trail?.ativo && (PR.pk / entry - 1) * 100 >= (SM.ativarPct ?? 30);
        if (t.trail?.ativo || liveOn) {
          if (liveOn && PR.logged !== true) { PR.logged = true; log(`${t.symbol}: STOP MÓVEL ligado pela vigia (chegou a +${((PR.pk / entry - 1) * 100).toFixed(0)}%)`); }
          const pk = liveOn ? PR.pk : mem.peak[t.mint];
          const follow = (pk / entry - 1) * 100 >= (SM.seguirAPartirPct ?? 60) ? Math.min(pk * (1 - (SM.distanciaPct ?? 25) / 100), pk * 0.88) : 0;
          trailPx = Math.max(t.trail?.ativo ? t.trail.stop : 0, follow, entry * (1 + (SM.minimoTravadoPct ?? 5) / 100));
        }
      }
      const cost0 = t.position?.known ? t.position.costOpenUsd : 0;
      const gain0 = gain;
      if (mem.below?.[t.mint] && !(trailPx && px < trailPx) && !(lossOn && gain0 != null && gain0 <= -lossPct)) delete mem.below[t.mint]; // voltou acima: zera a confirmação
      // LP destravada só vende se a liquidez estiver saindo de verdade (15%+ na janela); os outros sinais de golpe vendem direto
      let golpe = scam[t.mint];
      if (golpe && /^liquidez destravada/.test(golpe) && !golpe.includes(';') && liqDrop < confLiq) {
        if (!mem.lpIgn?.[t.mint]) { (mem.lpIgn = mem.lpIgn || {})[t.mint] = now; log(`${t.symbol}: RugCheck diz liquidez destravada, mas a liquidez no mercado não caiu (${liqDrop.toFixed(0)}%). Segurando.`); }
        golpe = null;
      }
      if (golpe) await sell(t, `golpe no contrato: ${golpe}`, 'golpe', px);
      // Filtro de pavio: só vende se ficar abaixo do stop por confirmarSegundos seguidos.
      // Se já passou vendaDiretaAbaixoPct (5%) abaixo do stop, não espera (queda de verdade, cada segundo conta)
      else if (trailPx && px < trailPx && px >= trailPx * (1 - (SM.vendaDiretaAbaixoPct ?? 5) / 100) && !confirmBelow(t, now, SM.confirmarSegundos ?? 10, 'stop móvel')) { /* aguardando confirmação */ }
      else if (trailPx && px < trailPx) await sell(t, `stop móvel: caiu abaixo de US$ ${trailPx.toPrecision(4)} (garantindo +${((trailPx / t.position.avgPriceUsd - 1) * 100).toFixed(0)}%)`, 'stop-movel', px);
      // Stop de perda: a posição ainda no prejuízo caiu stopPerda% desde a entrada (antes não existia: só o -40% do topo)
      else if (lossOn && gain != null && gain <= -lossPct && gain > -(lossPct + 5) && !confirmBelow(t, now, SP.confirmarSegundos ?? 20, 'stop de perda')) { /* aguardando confirmação */ }
      else if (lossOn && gain != null && gain <= -lossPct) await sell(t, `stop de perda: caiu ${Math.abs(gain).toFixed(0)}% desde a entrada (limite -${lossPct}%)`, 'stop-perda', px);
      else if ((() => {
        // Escada de realização: ganho pelo preço de entrada (a venda parcial muda a quantidade, não o preço médio)
        const avg = t.position?.avgPriceUsd > 0 && !t.staleCost ? t.position.avgPriceUsd : 0;
        const gainPx = avg ? (px / avg - 1) * 100 : gain;
        if (gainPx == null || gainPx >= (L.alvoPct ?? 100)) return false;
        const weak = weakSignals({ candles: t.candles, entryAt: t.position?.lastBuyAt || t.heldSince || 0, buys5: Number(p?.txns?.m5?.buys) || 0, sells5: Number(p?.txns?.m5?.sells) || 0, vol5: Number(p?.volume?.m5), volH1: Number(p?.volume?.h1), fromPeak });
        const st = ladderStep(t, px, gainPx, weak, fromPeak); if (!st) return false;
        t._ladder = { ...st, gainPx, weak };
        return true;
      })()) {
        const st = t._ladder, w = st.weak.length ? ` e a alta perdendo força (${st.weak.map((x) => x.msg).join(', ')})` : ' e recuando do topo';
        if (st.frac >= 1) await sell(t, `lucro de +${st.gainPx.toFixed(0)}% (faixa de +${st.faixa.lucroPct}%)${w}${st.all ? '; posição pequena, vende tudo' : ''}`, 'realizar', px);
        else await sellPart(t, st.frac, `lucro de +${st.gainPx.toFixed(0)}% na faixa de +${st.faixa.lucroPct}%${w}`, px, st.target);
      }
      else if (realizeOn && gain != null && gain >= 50 && gain < (L.alvoPct ?? 100) && (() => {
        const weak = weakSignals({ candles: t.candles, entryAt: t.position?.lastBuyAt || t.heldSince || 0, buys5: Number(p?.txns?.m5?.buys) || 0, sells5: Number(p?.txns?.m5?.sells) || 0, vol5: Number(p?.volume?.m5), volH1: Number(p?.volume?.h1), fromPeak });
        const r = realizeCheck(gain, weak, RZ); t._rz = r.sell ? `lucro de +${gain.toFixed(0)}% e a alta perdendo força: ${weak.map((w) => w.msg).join(', ')}` : null; return r.sell;
      })()) await sell(t, t._rz, 'realizar', px);
      else if (fromPeak >= dropPct) {
        // Correção saudável x despejo: na queda de 40% só vende com confirmação (liquidez saindo ou vendas dominando);
        // sem confirmação, só a partir da queda maior (60%)
        const b5 = Number(p?.txns?.m5?.buys) || 0, s5 = Number(p?.txns?.m5?.sells) || 0;
        const sellsPct = b5 + s5 >= 10 ? (s5 / (b5 + s5)) * 100 : 0;
        const confirm = liqDrop >= confLiq ? `liquidez saindo (-${liqDrop.toFixed(0)}%)` : sellsPct >= confSells ? `vendas dominando (${sellsPct.toFixed(0)}% nos últimos 5 min)` : null;
        if (confirm) await sell(t, `preço caiu ${fromPeak.toFixed(0)}% do pico e ${confirm}`, 'vigia', px);
        else if (fromPeak >= hardDrop) await sell(t, `preço caiu ${fromPeak.toFixed(0)}% do pico desde a compra`, 'vigia', px);
        else if (!mem.calm?.[t.mint]) { (mem.calm = mem.calm || {})[t.mint] = now; log(`${t.symbol}: caiu ${fromPeak.toFixed(0)}% do pico, mas sem sinal de despejo (liquidez estável, compras ativas). Segurando.`); }
      }
      else if (liqDrop >= liqPct) await sell(t, `liquidez caiu ${liqDrop.toFixed(0)}% em poucos minutos`, 'vigia', px);
      else if (lucroOn && cost > 0 && cost < (L.ateUsd ?? 10) && gain >= (L.alvoPct ?? 100)) await sell(t, `lucro de +${gain.toFixed(0)}% (investido US$ ${cost.toFixed(2)})`, 'lucro', px);
    }
    await save();
  } catch (e) { log(`consulta falhou: ${e.message}`, true); }
  await sleep(Math.min(10000, Math.max(0, until - Date.now())));
}
await save();
