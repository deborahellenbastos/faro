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
try { state = decrypt(JSON.parse(await readFile(path.join(root, 'docs', 'data.enc.json'), 'utf8')), password); }
catch { log('Não consegui abrir os dados; só esperando.', true); await idle(); process.exit(0); }

cfg.carteira = { enderecoPublico: wallet };
const trader = await createTrader(cfg, log);
if (!trader?.canWatch) { await idle(); process.exit(0); }

let mem = {};
try { mem = JSON.parse(await readFile(MEM, 'utf8')); } catch {}
mem.peak = mem.peak || {}; mem.liq = mem.liq || {}; mem.sold = mem.sold || {};
const save = () => writeFile(MEM, JSON.stringify(mem)).catch(() => {});

const dropPct = V.quedaDoPicoPct ?? 40;
const liqPct = V.quedaLiquidezPct ?? 30;
const liqWin = (V.janelaLiquidezMin ?? 5) * 60000;
const minUsd = cfg.venda?.valorMinimoUsd ?? 1;

// Moedas que você tem agora, com o pico desde a compra (velas do robô + o que a vigia já viu)
// Uma venda feita antes de uma nova compra da mesma moeda não conta mais
const done = (t) => mem.sold[t.mint] && mem.sold[t.mint].at > (t.position?.lastBuyAt || 0);
const held = Object.values(state.tokens || {}).filter((t) => t.held && t.heldAmount > 0 && !done(t));
for (const t of held) {
  const since = t.position?.lastBuyAt || t.heldSince || 0;
  const candleTop = Math.max(0, ...(t.candles || []).filter((c) => c[0] >= since - 300000).map((c) => c[2]));
  mem.peak[t.mint] = Math.max(mem.peak[t.mint] || 0, t.position?.avgPriceUsd || 0, candleTop, t.priceUsd || 0);
}
if (!held.length) { await idle(); process.exit(0); }
log(`vigiando ${held.map((t) => t.symbol).join(', ')} (vende com -${dropPct}% do pico ou liquidez -${liqPct}% em ${liqWin / 60000} min)`);

while (Date.now() < until) {
  const live = held.filter((t) => !done(t));
  if (!live.length) break;
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${live.map((t) => t.mint).join(',')}`, { signal: AbortSignal.timeout(8000) });
    const pairs = r.ok ? await r.json() : [];
    const now = Date.now();
    for (const t of live) {
      // Mesmo par que o robô usa; se não houver, o mais líquido
      const ps = (pairs || []).filter((p) => p?.baseToken?.address === t.mint);
      const p = ps.find((x) => x.pairAddress === t.pairAddress) || ps.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
      const px = Number(p?.priceUsd), liq = Number(p?.liquidity?.usd);
      if (!(px > 0)) continue;
      mem.peak[t.mint] = Math.max(mem.peak[t.mint] || 0, px);
      const w = (mem.liq[t.mint] = (mem.liq[t.mint] || []).filter((x) => now - x[0] <= liqWin));
      if (liq > 0) w.push([now, liq]);
      const liqTop = Math.max(0, ...w.map((x) => x[1]));
      const fromPeak = (1 - px / mem.peak[t.mint]) * 100;
      const liqDrop = liqTop > 0 && liq > 0 ? (1 - liq / liqTop) * 100 : 0;
      let why = null;
      if (fromPeak >= dropPct) why = `preço caiu ${fromPeak.toFixed(0)}% do pico desde a compra`;
      else if (liqDrop >= liqPct) why = `liquidez caiu ${liqDrop.toFixed(0)}% em poucos minutos`;
      if (!why) continue;
      const worth = (t.heldAmount || 0) * px;
      if (worth < minUsd) { mem.sold[t.mint] = { skipped: true, at: now, why, worth }; log(`${t.symbol}: ${why}, mas vale só US$ ${worth.toFixed(2)}. Não vendi.`); continue; }
      log(`${t.symbol}: ${why}. Vendendo 100%...`);
      try {
        const s = await trader.sellAll(t.mint);
        mem.sold[t.mint] = { ok: true, at: Date.now(), sig: s.sig, outSol: s.outSol, why };
        log(s.nada ? `${t.symbol}: nada para vender.` : `VENDEU 100% de ${t.symbol} por ${s.outSol.toFixed(4)} SOL (tx ${s.sig.slice(0, 8)}...)`);
      } catch (e) {
        const tries = ((mem.retry || {})[t.mint] || 0) + 1;
        log(`Venda de ${t.symbol} falhou (${tries}/3): ${e.message}`, true);
        mem.retry = { ...(mem.retry || {}), [t.mint]: tries };
        if (tries >= 3) mem.sold[t.mint] = { ok: false, at: Date.now(), why, erro: e.message };
      }
    }
    await save();
  } catch (e) { log(`consulta falhou: ${e.message}`, true); }
  await sleep(Math.min(10000, Math.max(0, until - Date.now())));
}
await save();
