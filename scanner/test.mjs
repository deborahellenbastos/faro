// Teste com dados simulados (sem internet). Rode: node scanner/test.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runOnce, dumpReason, lpFalseAlarm } from './run.mjs';
import { buyScoreOk, entryCandidates as ecTest, profileCfg, readProfile } from './autobuy.mjs';
import { shallowEntry, baseBreakout } from './signals.mjs';
import { crazyEntry, simCrazy, marketTide, skepticOn, volumeFade } from './sim.mjs';
import { parseOps } from './api.mjs';
import { scamSignals } from './analyze.mjs';
import { entrySignal, exitSignal, trailStop, weakSignals, realizeCheck, breakoutSignal } from './signals.mjs';

const cfg = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const now = Date.UTC(2026, 10, 15, 21, 0, 0);
const min = 60000;

const pair = (mint, sym, o = {}) => ({
  chainId: 'solana', dexId: 'pumpswap', url: `https://dexscreener.com/solana/${mint}pair`, pairAddress: `${mint}pair`,
  baseToken: { address: mint, symbol: sym, name: `${sym} Coin` },
  priceUsd: String(o.price ?? 0.0012), priceNative: String((o.price ?? 0.0012) / 140), liquidity: { usd: o.liq ?? 60000 }, marketCap: o.mcap ?? 400000, fdv: o.mcap ?? 400000,
  pairCreatedAt: now - (o.ageMin ?? 180) * min,
  volume: { m5: 9000, h1: o.volH1 ?? 90000, h6: 210000, h24: 300000 },
  txns: { m5: { buys: 80, sells: 41 }, h1: { buys: o.buys ?? 700, sells: o.sells ?? 300 }, h6: { buys: 2900, sells: 2100 }, h24: { buys: 5200, sells: 4300 } },
  priceChange: { m5: 1.3, h1: o.ch1 ?? 22, h6: 64, h24: 140 },
  quoteToken: { symbol: 'SOL' }, boosts: { active: o.boosts ?? 100 },
  info: { imageUrl: null, websites: [{ label: 'Website', url: 'https://example.com' }], socials: [{ type: 'twitter', url: 'https://x.com/example' }] },
});

const holders = (pcts, extra = {}) => pcts.map((p, i) => ({ address: `acc${i}`, owner: `own${i}`, pct: p, insider: false, ...extra[i] }));

const report = (o = {}) => ({
  mintAuthority: o.mint ?? null, freezeAuthority: o.freeze ?? null,
  markets: [{ pubkey: 'POOL', liquidityAAccount: 'acc0', liquidityBAccount: 'vaultB', lp: { lpLockedPct: o.lp ?? 100 } }],
  topHolders: o.holders ?? holders([22, 3.1, 2.8, 2.5, 2.2, 2.0, 1.8, 1.6, 1.5, 1.4, 1.3]),
  knownAccounts: { own1: { name: 'Creator', type: 'CREATOR' } },
  creator: 'own1', creatorTokens: o.creatorTokens ?? [{}, {}],
  graphInsidersDetected: o.insiders ?? 0, totalHolders: o.totalHolders ?? 1800,
  score_normalised: o.score ?? 12, transferFee: { pct: o.fee ?? 0 }, tokenMeta: { mutable: false },
  rugged: false, risks: o.risks ?? [{ name: 'Low amount of LP Providers', level: 'warn' }],
});

// Cenários
const market = {
  GOOD1: [pair('GOOD1', 'GATO', {})],
  GOOD2: [pair('GOOD2', 'LUA', { volH1: 40000, buys: 520, sells: 480, ch1: 5, liq: 30000, mcap: 250000 })],
  MINTX: [pair('MINTX', 'GOLPE', {})],
  YOUNG: [pair('YOUNG', 'BEBE', { ageMin: 3 })],
  THIN: [pair('THIN', 'MAGRO', { liq: 4000, mcap: 90000 })],
  WHALE: [pair('WHALE', 'BALEIA', {})],
  SERIAL: [pair('SERIAL', 'REPETE', {})],
  FEE: [pair('FEE', 'TAXA', {})],
  NOLOCK: [pair('NOLOCK', 'SOLTA', {})],
  NOINFO: [pair('NOINFO', 'SEMINFO', {})],
};
const reports = {
  GOOD1: report(),
  GOOD2: report({ score: 30, totalHolders: 600 }),
  MINTX: report({ mint: 'SomeAuthority111' }),
  WHALE: report({ holders: holders([22, 18, 6, 5, 4, 3, 2, 2, 2, 1]), insiders: 4 }),
  SERIAL: report({ creatorTokens: new Array(14).fill({}) }),
  FEE: report({ fee: 5, risks: [{ name: 'Transfer fee', level: 'danger' }] }),
  NOLOCK: report({ lp: 0 }),
  NOINFO: { ...report(), markets: [] },
};

let rugCalls = 0;
let wallet = [];
const api = {
  getWalletHoldings: async () => wallet,
  getSolBalance: async () => 1.84,
  getWalletOps: async (owner, lastSig) => lastSig ? { ops: [], lastSig } : {
    lastSig: 'sig4',
    ops: [
      // GATO: comprou 2x (0.5 SOL e 0.3 SOL) e vendeu um pouco
      { sig: 'sig1', at: now + 6 * min, mint: 'GOOD1', tokens: 62000, sol: -0.5 },
      { sig: 'sig2', at: now + 12 * min, mint: 'GOOD1', tokens: 33000, sol: -0.3 },
      { sig: 'sig3', at: now + 20 * min, mint: 'GOOD1', tokens: -5000, sol: 0.05 },
      // EXTRA: uma compra
      { sig: 'sig4', at: now + 25 * min, mint: 'EXTRA', tokens: 30, sol: -0.12 },
    ],
  },
  sleep: async () => {},
  SOL_POOL: 'SOLPOOL',
  getPriceAt: async (pool) => (pool === 'SOLPOOL' ? 150 : 0.002),
  getSolanaCandidates: async () => Object.keys(market).map((mint) => ({ mint, source: 'perfis novos', icon: null, description: '', links: [] })),
  getMarketData: async (mints) => new Map(mints.filter((m) => market[m]).map((m) => [m, market[m]])),
  getRugReport: async (mint) => { rugCalls++; return reports[mint]; },
  getCandles: async (pair) => {
    // 72 velas de 5 min simuladas (passeio aleatório determinístico)
    let p = 0.0009, seed = pair.length * 7919;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: 72 }, (_, i) => {
      const o = p; const c = Math.max(1e-7, o * (1 + (rnd() - 0.46) * 0.08));
      const h = Math.max(o, c) * (1 + rnd() * 0.03), l = Math.min(o, c) * (1 - rnd() * 0.03);
      p = c; return [now - (72 - i) * 5 * min, o, h, l, c, Math.round(2000 + rnd() * 20000)];
    });
  },
};

// Rodada 1
let state = await runOnce({ api, cfg, state: {}, now });
const s = (m) => state.tokens[m];
assert.equal(s('GOOD1').status, 'aprovada', 'GOOD1 deveria ser aprovada');
assert.equal(s('GOOD2').status, 'aprovada', 'GOOD2 deveria ser aprovada');
assert.ok(s('GOOD1').score > s('GOOD2').score, 'GOOD1 tem mais força que GOOD2');
assert.equal(s('MINTX').status, 'reprovada');
assert.match(s('MINTX').reasons.join(), /emitir tokens/);
assert.equal(s('YOUNG').status, 'aguardando');
assert.match(s('YOUNG').reasons.join(), /Muito nova/);
assert.equal(s('THIN').status, 'aguardando');
assert.equal(s('WHALE').status, 'aguardando');
assert.match(s('WHALE').reasons.join(), /insiders/);
assert.equal(s('SERIAL').status, 'aguardando');
assert.match(s('SERIAL').reasons.join(), /já criou 14/);
assert.equal(s('FEE').status, 'reprovada');
// Liquidez não travada, ou sem informação: nunca aprova
assert.notEqual(s('NOLOCK').status, 'aprovada');
assert.match(s('NOLOCK').reasons.join(), /travada/);
assert.notEqual(s('NOINFO').status, 'aprovada');
assert.match(s('NOINFO').reasons.join(), /Sem confirmação/);
// A pool (acc0 com 22%) não pode contar como holder
assert.ok(s('GOOD1').rug.top10Pct < 25, `top10 sem a pool: ${s('GOOD1').rug.top10Pct}`);
const callsR1 = rugCalls;

// Rodada 2: 5 min depois, GATO sobe 40%, LUA perde a liquidez
market.GOOD1 = [pair('GOOD1', 'GATO', { price: 0.0012 * 1.4 })];
market.GOOD2 = [pair('GOOD2', 'LUA', { price: 0.0002, liq: 3000, mcap: 40000 })];
state = await runOnce({ api, cfg, state, now: now + 5 * min });
assert.equal(Math.round(s('GOOD1').changePct), 40);
assert.ok(s('GOOD2').safety.alerts.some((a) => a.id === 'liq-sumiu'));
assert.ok(rugCalls - callsR1 <= 2, `cache do RugCheck deveria evitar consultas repetidas (${rugCalls - callsR1})`);

// Rodada 3: você comprou GATO e tem uma moeda que o robô não aprovou (EXTRA).
// 35 min depois do alerta, o dev vende e a liquidez é destravada.
cfg.carteira.enderecoPublico = 'MinhaCarteiraPublica111';
wallet = [{ mint: 'GOOD1', amount: 90000, decimals: 6 }, { mint: 'EXTRA', amount: 30, decimals: 6 }];
market.EXTRA = [pair('EXTRA', 'EXTRA', { price: 0.5 })];
reports.EXTRA = report();
reports.GOOD1 = report({ lp: 20, holders: holders([22, 0.5, 2.8, 2.5, 2.2, 2.0, 1.8, 1.6, 1.5, 1.4, 1.3]) });
market.GOOD1 = [pair('GOOD1', 'GATO', { price: 0.0012 * 1.1, liq: 25000, buys: 100, sells: 400 })];
state = await runOnce({ api, cfg, state, now: now + 35 * min });
const g = s('GOOD1');
assert.equal(g.held, true);
assert.equal(g.safety.level, 'danger', JSON.stringify(g.safety));
const ids = g.safety.alerts.map((a) => a.id);
for (const id of ['lp', 'dev-vendendo', 'liq-caiu', 'vendas']) assert.ok(ids.includes(id), `faltou alerta ${id}: ${ids}`);
assert.equal(s('EXTRA').status, 'carteira');
assert.equal(s('EXTRA').safety.level, 'ok', JSON.stringify(s('EXTRA').safety));
assert.ok(s('EXTRA').checks.length > 0, 'moeda da carteira deveria ter análise');
const firstAt = g.safety.alerts[0].at;
// Sua operação
assert.equal(state.wallet.solBalance, 1.84);
assert.ok(g.position.known, 'posição do GATO deveria ser conhecida');
assert.ok(Math.abs(g.position.spentSol - 0.8) < 1e-9);
assert.equal(g.position.buys, 2);
assert.equal(g.position.sells, 1);
assert.ok(Math.abs(g.position.avgPriceSol - 0.8 / 95000) < 1e-12);
assert.ok(g.position.minPriceUsd < g.position.maxPriceUsd);
assert.ok(Number.isFinite(g.position.pnlPct));
assert.ok(s('EXTRA').position.known);
// realizado: vendeu 5000 por 0.05 SOL, custo médio 0.8/95000 por token
assert.ok(Math.abs(g.position.realizedSol - (0.05 - 5000 * 0.8 / 95000)) < 1e-12);
assert.equal(g.history.length, 3);
assert.ok(g.history[0].tokens < 0, 'histórico começa pela mais recente (a venda)');

// Rodada 4: alerta continua com o mesmo horário (não "pisca" como novo)
state = await runOnce({ api, cfg, state, now: now + 40 * min });
assert.equal(s('GOOD1').safety.alerts.find((a) => a.id === g.safety.alerts[0].id).at, firstAt);
cfg.carteira.enderecoPublico = '';

// Dados visuais para os cards
assert.equal(s('GOOD1').periods.m5.buys, 80);
assert.equal(s('GOOD1').boosts, 100);
assert.equal(s('GOOD1').quoteSymbol, 'SOL');
assert.ok(s('GOOD1').priceNative > 0);
assert.equal(s('GOOD1').candles.length, 72);
assert.ok(s('GOOD1').hist.length >= 3);
assert.equal(s('MINTX').candles, undefined, 'reprovada não precisa de velas');

// Leitura de uma transação real simplificada: comprou 1000 TOKEN pagando 0.25 SOL
const fakeTx = {
  blockTime: 1763240000,
  transaction: { message: { accountKeys: [{ pubkey: 'ME' }, { pubkey: 'POOL' }] } },
  meta: { err: null, preBalances: [2_000_000_000, 0], postBalances: [1_750_000_000, 0],
    preTokenBalances: [], postTokenBalances: [{ owner: 'ME', mint: 'TOKEN', uiTokenAmount: { uiAmount: 1000 } }] },
};
const ops = parseOps(fakeTx, 'ME', 'abc');
assert.equal(ops.length, 1);
assert.equal(ops[0].tokens, 1000);
// a taxa de criação da conta (~0,002 SOL) não conta como custo
assert.ok(Math.abs(ops[0].sol - (-0.25 + 0.00203928)) < 1e-9);

// Compra paga em USDC: o valor em dólar fica guardado para virar SOL equivalente
const usdcTx = { blockTime: 1700000000, transaction: { message: { accountKeys: ['ME'] } }, meta: { preBalances: [1e9], postBalances: [1e9 - 5000],
  preTokenBalances: [{ owner: 'ME', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', uiTokenAmount: { uiAmount: 100 } }, { owner: 'ME', mint: 'TOK', uiTokenAmount: { uiAmount: 5 } }],
  postTokenBalances: [{ owner: 'ME', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', uiTokenAmount: { uiAmount: 70 } }, { owner: 'ME', mint: 'TOK', uiTokenAmount: { uiAmount: 505 } }] } };
const uops = parseOps(usdcTx, 'ME', 'u1');
assert.equal(uops.length, 1);
assert.equal(uops[0].tokens, 500);
assert.equal(uops[0].stable, -30);
// Preço do SOL do minuto exato gravado em cada transação da carteira
assert.ok(state.wallet.ops.every((o) => o.px === 1 && o.solUsd === 150));

// Custo igual ao da Phantom: só o SOL que entrou na troca (taxas de rede e de contas ficam de fora)
const jupTx = { blockTime: 1700000000, transaction: { message: { accountKeys: ['ME', 'TMP', 'ATA'], instructions: [] } }, meta: { fee: 145000,
  preBalances: [20000000, 0, 0], postBalances: [5047527, 0, 1513840],
  preTokenBalances: [], postTokenBalances: [{ accountIndex: 2, owner: 'ME', mint: 'TOK', uiTokenAmount: { uiAmount: 5214.8 } }],
  innerInstructions: [{ instructions: [
    { program: 'spl-token', parsed: { type: 'initializeAccount3', info: { account: 'TMP', mint: 'So11111111111111111111111111111111111111112', owner: 'ME' } } },
    { program: 'spl-token', parsed: { type: 'transferChecked', info: { source: 'TMP', destination: 'POOL', mint: 'So11111111111111111111111111111111111111112', tokenAmount: { amount: '11837005' } } } },
    { program: 'spl-token', parsed: { type: 'transferChecked', info: { source: 'TMP', destination: 'FEE1', mint: 'So11111111111111111111111111111111111111112', tokenAmount: { amount: '2926' } } } },
    { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'TMP', destination: 'FEE2', amount: '101502' } } },
    { program: 'spl-token', parsed: { type: 'transferChecked', info: { source: 'POOLTOK', destination: 'ATA', mint: 'TOK', tokenAmount: { amount: '5214804845' } } } },
  ] }] } };
const jops = parseOps(jupTx, 'ME', 'j1');
assert.equal(jops.length, 1);
assert.ok(Math.abs(jops[0].sol - -0.011941433) < 1e-12);

// Venda automática: só o que MUDOU para golpe depois da compra
const cfgT = { filtros: { lpTravadaMinPct: 90 } };
const base0 = { lpLockedPct: 100, devPct: 4, mint: false, freeze: false };
assert.equal(scamSignals(base0, { lpLockedPct: 100, devPct: 4, mintAuthority: null, freezeAuthority: null }, cfgT).length, 0);
assert.equal(scamSignals(base0, { lpLockedPct: 20, devPct: 4, mintAuthority: null, freezeAuthority: null }, cfgT).length, 1);
assert.equal(scamSignals(base0, { lpLockedPct: 100, devPct: 1, mintAuthority: 'X', freezeAuthority: null }, cfgT).length, 1, 'dev com 4% vendendo não é golpe (26/11)');
assert.equal(scamSignals({ ...base0, devPct: 8 }, { lpLockedPct: 100, devPct: 1, mintAuthority: 'X', freezeAuthority: null }, cfgT).length, 2, 'dev com 8% vendendo é golpe');
assert.equal(scamSignals(base0, { rugged: true, lpLockedPct: 100, devPct: 4 }, cfgT).length, 1);
// moeda comprada já sem liquidez travada não dispara venda
{ const { rugAlerts } = await import('./analyze.mjs');
  const sumZ = { devPct: 0, top10Pct: 20, insiders: 0, lpLockedPct: 100, dangerRisks: [], mintAuthority: null, freezeAuthority: null };
  const a = rugAlerts({ devPct: 12, top10Pct: 20, insiders: 0, dangerNames: [] }, sumZ, cfgT).find((x) => x.id === 'dev-vendendo');
  assert.equal(a.level, 'info', 'dev que zerou não é perigo (27/11)');
  const b = rugAlerts({ devPct: 12, top10Pct: 20, insiders: 0, dangerNames: [] }, { ...sumZ, devPct: 5 }, cfgT).find((x) => x.id === 'dev-vendendo');
  assert.equal(b.level, 'danger', 'dev grande vendendo em parte continua perigo'); }
assert.equal(scamSignals({ lpLockedPct: 0, devPct: 0 }, { lpLockedPct: 0, devPct: 0 }, cfgT).length, 0);

// Simulação e compra automática: entram no sinal de boa entrada; saem no +100% ou no stop
{
  const { simStep } = await import('./sim.mjs');
  const { entryCandidates, readSwitch, buyLimits } = await import('./autobuy.mjs');
  const cfgS = { compra: { solPorCompra: 0.05, scoreMinimo: 70, maxComprasPorDia: 5 }, simulacao: { ligado: true }, venda: { lucro: { alvoPct: 100 } } };
  const sig = (at) => ({ tipo: 'entrada', fase: 'entrada', boa: true, stop: 0.8, alvo: 1.6, rr: 3, at, msg: 'ok' });
  const tk = {
    A: { mint: 'A', symbol: 'AAA', status: 'aprovada', priceUsd: 1, score: 80, candles: [], sinal: sig(1000) },
    B: { mint: 'B', symbol: 'BBB', status: 'aprovada', priceUsd: 1, score: 50, candles: [], sinal: sig(1000) },
    D: { mint: 'D', symbol: 'DDD', status: 'aprovada', priceUsd: 1, score: 90, candles: [], sinal: { ...sig(1000), boa: false, fase: 'zona' } },
    E: { mint: 'E', symbol: 'EEE', status: 'aprovada', priceUsd: 1, score: 90, candles: [], held: true, sinal: sig(1000) },
  };
  assert.deepEqual(entryCandidates(tk, cfgS, 1000).map((t) => t.mint), ['A'], 'só A: B nota baixa, D sem boa entrada, E já é sua');
  assert.equal(entryCandidates(tk, cfgS, 1000 + 11 * 60000).length, 0, 'sinal velho não compra');
  const st = {}; const logs = [];
  simStep({ state: st, tokens: tk, candidates: entryCandidates(tk, cfgS, 1000), cfg: cfgS, now: 1000, log: (m) => logs.push(m) });
  assert.equal(st.sim.open.length, 1);
  tk.A.priceUsd = 2.1; // passou do +100%
  simStep({ state: st, tokens: tk, candidates: [], cfg: cfgS, now: 2000, log: (m) => logs.push(m) });
  assert.equal(st.sim.closed[0].why, 'alvo');
  assert.ok(st.sim.closed[0].pnlPct > 85 && st.sim.closed[0].pnlPct < 100); // descontados os custos
  tk.C = { mint: 'C', symbol: 'CCC', status: 'aprovada', priceUsd: 1, score: 90, candles: [], sinal: sig(3000) };
  simStep({ state: st, tokens: tk, candidates: entryCandidates(tk, cfgS, 3000), cfg: cfgS, now: 3000, log: (m) => logs.push(m) });
  tk.C.priceUsd = 0.7;
  simStep({ state: st, tokens: tk, candidates: [], cfg: cfgS, now: 4000, log: (m) => logs.push(m) });
  assert.equal(st.sim.closed[0].why, 'stop');
  assert.ok(st.sim.closed[0].pnlPct < -25);
  assert.equal(st.sim.stats.ops, 2);

  // Interruptor: só vale memo assinado pela própria carteira; o mais recente manda
  const memos = [{ sig: 'x1', memo: '[18] faro:compra=on', at: 3 }, { sig: 'x2', memo: '[19] faro:compra=off', at: 2 }];
  assert.equal((await readSwitch(memos, async () => true)).on, true);
  assert.equal((await readSwitch(memos, async (s) => s !== 'x1')).on, false, 'memo de terceiro é ignorado');
  assert.equal(await readSwitch([{ sig: 'y', memo: 'oi', at: 1 }], async () => true), null);
  // Interruptor da venda (20/11): só memo da própria carteira, o mais recente manda, e não confunde com o da compra
  { const { readSellSwitch } = await import('./autobuy.mjs');
    const mv = [{ sig: 'v1', memo: 'faro:compra=on', at: 4 }, { sig: 'v2', memo: 'faro:venda=off', at: 3 }, { sig: 'v3', memo: 'faro:venda=on', at: 2 }];
    assert.equal((await readSellSwitch(mv, async () => true)).on, false);
    assert.equal((await readSellSwitch(mv, async (s) => s !== 'v2')).on, true, 'memo de terceiro é ignorado');
    assert.equal(await readSellSwitch([{ sig: 'z', memo: 'faro:compra=off', at: 1 }], async () => true), null); }

  // Travas: 2 abertas no máximo, perda do dia para tudo
  const now = Date.parse('2026-11-16T18:00:00Z');
  const stL = { trades: [{ ok: true, auto: true, mint: 'P', at: now - 3600e3 }, { ok: true, auto: true, mint: 'Q', at: now - 1800e3 }], wallet: { ops: [
    { mint: 'Q', at: now - 1800e3, sol: -0.05 }, { mint: 'Q', at: now - 600e3, sol: 0.02 }] } };
  const L1 = buyLimits(stL, { P: { held: true }, Q: {} }, cfgS, now);
  assert.equal(L1.open, 1); assert.equal(L1.room, 1); assert.equal(L1.stopped, false);
  stL.wallet.ops.push({ mint: 'Q', at: now - 500e3, sol: -0.2 });
  assert.equal(buyLimits(stL, { P: { held: true }, Q: {} }, cfgS, now).stopped, true);
}

// Compra real só com as travas: sem a variável AUTO_BUY e sem o interruptor, não compra
assert.equal(state.lastRun.autoBuy, false);
assert.equal(state.lastRun.autoCompra, null);

// Sinais de entrada e saída (alta, correção até 61,8%, reação com compra)
{
  const T0 = Date.now() - 80 * 300000; const c = [];
  const push = (o, h, l, cl, v = 100) => c.push([T0 + c.length * 300000, o, h, l, cl, v]);
  for (let i = 0; i < 20; i++) push(1, 1.02, 0.98, 1);
  for (let i = 0; i < 10; i++) { const a = 1 + i * 0.1; push(a, a + 0.12, a - 0.02, a + 0.1, 300); }
  assert.equal(entrySignal(c).fase, 'esticada', 'no topo: esperar');
  for (let i = 0; i < 8; i++) { const a = 2.1 - i * 0.09; push(a, a + 0.02, a - 0.09, a - 0.08, 80); }
  assert.equal(entrySignal(c, { buys5: 5, sells5: 9 }).fase, 'zona', 'caindo na zona: ainda não');
  push(1.38, 1.40, 1.37, 1.39, 60); push(1.39, 1.47, 1.385, 1.46, 150);
  const e = entrySignal(c, { buys5: 12, sells5: 6, safety: 'ok', shape: 'organica' });
  assert.equal(e.fase, 'entrada'); assert.ok(e.rr >= 2 && e.stop < 1.37 && e.alvo === 2.12);
  // 16/11: nota baixa não vira "Boa entrada" (mas fica marcada para o teste da nota da aprovação)
  const ok = { buys5: 12, sells5: 6, safety: 'ok', shape: 'organica' };
  const lowS = entrySignal(c, { ...ok, score: 38, notaMin: 60 });
  assert.ok(!lowS.boa && lowS.notaBaixa && /nota da moeda está em 38/.test(lowS.msg), 'nota 38: sem sinal');
  assert.equal(entrySignal(c, { ...ok, score: 65, notaMin: 60 }).boa, true, 'nota 65: sinal normal');
  // 16/11: não repete o sinal se o último "Boa entrada" da moeda não subiu 10%
  const nowS = Date.now();
  const rep = entrySignal(c, { ...ok, now: nowS, boaPrev: { at: nowS - 40 * 60000, px: 1.4, max: 1.48 } });
  assert.ok(!rep.boa && rep.fase === 'repetido' && /há 40 min/.test(rep.msg), 'GOAT: sinal repetido');
  assert.equal(entrySignal(c, { ...ok, now: nowS, boaPrev: { at: nowS - 40 * 60000, px: 1.4, max: 1.6 } }).boa, true, 'o anterior andou: pode repetir');
  assert.equal(entrySignal(c, { ...ok, now: nowS, boaPrev: { at: nowS - 5 * 60000, px: 1.4, max: 1.4 } }).boa, true, 'o mesmo sinal, ainda fresco');
  assert.equal(entrySignal(c, { ...ok, now: nowS, boaPrev: { at: nowS - 25 * 3600000, px: 1.4, max: 1.4 } }).boa, true, 'passou 24h: vale de novo');
  const at = c[c.length - 1][0];
  assert.equal(exitSignal(c, { entryPx: 1.45, entryAt: at }, { px: 2.1 }).fase, 'realizar');
  assert.equal(exitSignal(c, { entryPx: 1.45, entryAt: at }, { px: 1.0 }).fase, 'sair');
  assert.equal(exitSignal(c, { entryPx: 1.45, entryAt: at }, { px: 1.6 }).fase, 'segurar');
}

// Stop móvel: desligado antes de +30%, depois trava lucro e nunca desce
{
  const T0 = Date.now() - 40 * 300000; const c = [];
  const push = (o, h, l, cl) => c.push([T0 + c.length * 300000, o, h, l, cl, 100]);
  push(1, 1.02, 0.98, 1); push(1, 1.1, 0.99, 1.08);
  assert.equal(trailStop(c, { entryPx: 1, entryAt: T0 }).ativo, false);
  const seq = [1.15, 1.1, 1.25, 1.2, 1.18, 1.35, 1.3, 1.45, 1.4, 1.38, 1.5];
  for (const v of seq) push(v - 0.03, v + 0.03, v - 0.05, v);
  const tr = trailStop(c, { entryPx: 1, entryAt: T0 }, { ativarPct: 30, distanciaPct: 25, minimoTravadoPct: 5 });
  assert.ok(tr.ativo && tr.stop >= 1.05 && tr.stop <= 1.53 * 0.88 + 1e-9, 'stop entre +5% e 12% abaixo do topo');
  const lower = trailStop(c.slice(0, 6), { entryPx: 1, entryAt: T0 }, {}, tr.stop);
  assert.ok(lower.stop >= tr.stop, 'nunca desce');
  assert.equal(exitSignal(c, { entryPx: 1, entryAt: T0 }, { px: tr.stop * 0.98, trail: tr }).fase, 'sair');
}

// Realização: +50% com 2 sinais de fraqueza, +80% com 1 sinal forte, senão segura
{
  const forte = [{ id: 'vendas', forte: true }], fraco = [{ id: 'recuo', forte: false }];
  assert.equal(realizeCheck(40, [...forte, ...fraco]).sell, false);
  assert.equal(realizeCheck(60, forte).sell, false);
  assert.equal(realizeCheck(60, [...forte, ...fraco]).sell, true);
  assert.equal(realizeCheck(85, fraco).sell, false);
  assert.equal(realizeCheck(85, forte).sell, true);
  const w = weakSignals({ buys5: 4, sells5: 8, vol5: 10, volH1: 1200, fromPeak: 16 });
  assert.deepEqual(w.map((x) => x.id), ['vendas', 'volume', 'recuo']);
}

// VI (16/11): subiu +44%, corrigiu 27% sem voltar à entrada. O stop fica logo acima da entrada até +60%
{
  const T0 = Date.now() - 20 * 300000; const c = [];
  const push = (o, h, l, cl) => c.push([T0 + c.length * 300000, o, h, l, cl, 100]);
  push(0.0000392, 0.0000439, 0.0000365, 0.000039); push(0.000039, 0.0000406, 0.0000319, 0.0000383);
  push(0.0000383, 0.0000522, 0.0000378, 0.0000443); push(0.0000443, 0.0000578, 0.0000414, 0.0000517); push(0.0000517, 0.0000529, 0.0000422, 0.000045);
  const tr = trailStop(c, { entryPx: 0.00004, entryAt: T0 }, { ativarPct: 30, seguirAPartirPct: 60, distanciaPct: 25, minimoTravadoPct: 5 });
  assert.ok(tr.ativo && Math.abs(tr.stop - 0.000042) < 1e-12, 'stop na entrada +5%');
  assert.ok(0.0000422 > tr.stop, 'a mínima da correção não teria vendido');
}

// Bundle (GTAHUB 16/11): 16 carteiras com 1,0% a 1,5% cada, vendidas juntas. Top 10 só 23%, sem insiders.
{
  const { summarizeRug } = await import('./analyze.mjs');
  const bundle = [1.02, 1.49, 1.37, 1.53, 1.41, 1.2, 1.3, 1.45, 1.1, 1.25, 1.33, 1.18, 1.4, 1.22, 1.5, 1.28];
  const rep = (pcts) => ({ topHolders: pcts.map((p, i) => ({ address: 'A' + i, owner: 'O' + i, pct: p })), markets: [] });
  const b = summarizeRug(rep([4, 2.5, ...bundle, 0.3, 0.2]));
  assert.ok(b.twinCount >= 7 && b.twinPct >= 10, `bundle detectado (${b.twinCount} carteiras, ${b.twinPct.toFixed(1)}%)`);
  const normal = summarizeRug(rep([6, 4.1, 3.2, 2.4, 1.9, 1.5, 1.1, 0.9, 0.8, 0.7, 0.6, 0.55]));
  assert.ok(normal.twinCount < 7, `distribuição normal não é bundle (${normal.twinCount})`);
  // ROCCO (16/11): 17 carteiras pequenas, ~0,66% cada (11,2% juntas) = cauda normal de holders, não bundle
  const rocco = summarizeRug(rep([5, 3, 2.2, ...Array.from({ length: 17 }, (_, i) => 0.58 + (i % 5) * 0.035)]));
  assert.ok(rocco.twinCount < 7, `cauda de holders pequenos não é bundle (${rocco.twinCount})`);
}

// Dev com histórico de moedas mortas (SENT, 6STAR) e dev de golpe anterior: reprovados no item Dev
{
  const { summarizeRug, runChecks } = await import('./analyze.mjs');
  const cfgD = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const m = { liquidityUsd: 20000, mcapUsd: 90000, ageMin: 20, priceChangeH1: 10, volumeH1: 5000, buysH1: 100, sellsH1: 80, buyRatioH1: 55 };
  const base = { topHolders: [{ address: 'a', owner: 'o', pct: 3 }], markets: [{ lp: { lpLockedPct: 100 } }], creator: 'DEV1', score_normalised: 1, totalHolders: 900 };
  const dev = (rep, extra = {}) => runChecks(m, summarizeRug({ ...base, ...rep }), { ...cfgD, ...extra }).find((c) => c.id === 'dev');
  assert.equal(dev({ creatorTokens: [{ marketCap: 2033 }, { marketCap: 8101 }] }).ok, false);
  assert.equal(dev({ creatorTokens: [{ marketCap: 2033 }, { marketCap: 450000 }] }).ok, true, 'dev com uma moeda que deu certo passa');
  assert.equal(dev({}, { __badDevs: { DEV1: { symbol: 'PASSED' } } }).ok, false);
  assert.match(dev({}, { __badDevs: { DEV1: { symbol: 'PASSED' } } }).detail, /golpe anterior \(PASSED\)/);
}

// Reentrada: saiu no stop e a moeda segue viva -> volta a ser candidata; sem liquidez (golpe) não
{
  const { entryCandidates } = await import('./autobuy.mjs');
  const cfgR = { compra: { scoreMinimo: 70 }, simulacao: {} };
  const sig = { tipo: 'entrada', fase: 'entrada', boa: true, stop: 0.8, alvo: 1.6, rr: 3, at: 1000 };
  const tk = {
    R: { mint: 'R', symbol: 'REE', status: 'carteira', priceUsd: 1, score: 80, sinal: sig, reentry: { at: 500 }, liquidityUsd: 20000, entryLiquidityUsd: 22000 },
    G: { mint: 'G', symbol: 'GOL', status: 'carteira', priceUsd: 1, score: 80, sinal: sig, reentry: { at: 500 }, liquidityUsd: 2000, entryLiquidityUsd: 22000 },
  };
  assert.deepEqual(entryCandidates(tk, cfgR, 1000).map((t) => t.mint), ['R']);
}

// Modo curva é só simulação: a compra de verdade nunca entra numa moeda ainda na curva da pump.fun
{
  const { entryCandidates } = await import('./autobuy.mjs');
  const sig = { tipo: 'entrada', fase: 'entrada', boa: true, stop: 0.8, alvo: 1.6, rr: 3, at: 1000 };
  const tk = { C: { mint: 'C', status: 'aguardando', score: 90, dexId: 'pumpfun', sinal: sig, priceUsd: 1 }, P: { mint: 'P', status: 'aprovada', score: 90, dexId: 'pumpswap', sinal: sig, priceUsd: 1 } };
  assert.deepEqual(entryCandidates(tk, { compra: {}, simulacao: {} }, 1000).map((t) => t.mint), ['P']);
}

// Rompimento: pausa perto do topo e rompe a máxima com volume (sim); sem volume ou já esticada, não
{
  const T0 = Date.now() - 20 * 300000; const c = [];
  const push = (o, h, l, cl, v) => c.push([T0 + c.length * 300000, o, h, l, cl, v]);
  [[9, 10.2, 8.8, 10, 800], [10, 12, 9.5, 11.5, 900], [11.5, 14, 11, 13.6, 1500], [13.6, 16, 13, 15.5, 1800], [15.5, 16.2, 14.2, 14.8, 700], [14.8, 15.9, 14.3, 15.4, 600], [15.4, 16, 14.6, 15.2, 650]].forEach((x) => push(...x));
  push(15.2, 17.4, 15.1, 17.2, 1400);
  const b = breakoutSignal(c, { buys5: 70, sells5: 30 });
  assert.ok(b && b.fase === 'rompimento' && b.stop < 14.3 && b.rr === 2.5, 'rompimento com volume');
  c[c.length - 1][5] = 500; assert.equal(breakoutSignal(c, {}), null, 'sem volume não');
  c[c.length - 1][5] = 1400; assert.equal(breakoutSignal(c, { px: 19.5 }), null, 'já esticada não');
}

// O painel tem uma cópia da lógica dos sinais: as duas precisam ser iguais
{
  const norm = (x) => x.replace(/export /g, '').replace(/\s+/g, ' ').trim();
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const a = html.indexOf('</sinais>'), b = html.indexOf('// </fim-sinais>');
  const src = await readFile(new URL('./signals.mjs', import.meta.url), 'utf8');
  assert.equal(norm(html.slice(a + 9, b)), norm(src), 'copie scanner/signals.mjs para o painel (entre <sinais> e </fim-sinais>)');
}

console.log('\nTodos os testes passaram.');
console.log(JSON.stringify(state.lastRun.counts));

// Gera um exemplo para visualizar o painel sem internet

// Despejo (goldie 16/11): -70% em 2 min, ou estrutura quebrada + insiders novos -> sai do radar
{
  const now = Date.UTC(2026, 10, 16, 23, 45);
  const hist = [[now - 15 * 60000, 55e-6], [now - 10 * 60000, 57e-6], [now - 5 * 60000, 40e-6]];
  assert.match(dumpReason({ hist }, 17e-6, now), /Despejo: caiu 70%/);
  assert.equal(dumpReason({ hist }, 45e-6, now), null);
  const ins = { hist: [[now - 5 * 60000, 25e-6]], approvedAt: now - 3600e3, sinal: { fase: 'quebrou' }, safety: { alerts: [{ id: 'insiders', at: now - 60000, msg: 'Apareceram 4 carteiras ligadas entre si (insiders)' }] } };
  assert.match(dumpReason(ins, 20e-6, now), /Perdeu a estrutura.*insiders/);
  assert.equal(dumpReason({ ...ins, sinal: { fase: 'zona' } }, 20e-6, now), null);
  // GOAT/GIFT: "liquidez destravada" com a liquidez de pé = alarme falso, não fica perigo
  const a = { kind: 'golpe', why: 'golpe no contrato: liquidez destravada (era 100%, agora 0%)' };
  assert.equal(lpFalseAlarm({ entryLiquidityUsd: 16058, liquidityUsd: 15015 }, a), true);
  assert.equal(lpFalseAlarm({ entryLiquidityUsd: 16058, liquidityUsd: 3000 }, a), false);
  assert.equal(lpFalseAlarm({ entryLiquidityUsd: 16058, liquidityUsd: 15015 }, { kind: 'golpe', why: 'mint authority ativa' }), false);
}

// Nota da aprovação (só simulação): a correção que gera o sinal derruba a nota de agora (GOAT 16/11: 54)
{
  const cfgT = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const parts = (h, l, s2, d) => [{ label: 'Holders', pts: h }, { label: 'Tamanho da liquidez', pts: l }, { label: 'Segurança (RugCheck)', pts: s2 }, { label: 'Distribuição', pts: d }, { label: 'Força de compra', pts: 0 }];
  const base = { score: 54, approvalScore: 78, scoreParts: parts(10, 6, 12, 8), safety: { level: 'ok', alerts: [] } };
  assert.equal(buyScoreOk(base, cfgT, false), false);
  assert.equal(buyScoreOk(base, cfgT, true), true);
  assert.equal(buyScoreOk({ ...base, approvalScore: 65 }, cfgT, true), false);
  assert.equal(buyScoreOk({ ...base, scoreParts: parts(5, 5, 5, 5) }, cfgT, true), false);
  assert.equal(buyScoreOk({ ...base, safety: { level: 'warn', alerts: [{ id: 'insiders' }] } }, cfgT, true), false);
  assert.equal(buyScoreOk({ ...base, score: 75 }, cfgT, true), false); // já entra pela regra normal
  const now = Date.now();
  const tok = { mint: 'X', symbol: 'X', status: 'aprovada', approvedAt: now - 3600e3, dexId: 'pumpswap', liquidityUsd: 15000, entryLiquidityUsd: 16000, sinal: { tipo: 'entrada', boa: true, at: now, rr: 3 }, ...base };
  assert.equal(ecTest({ X: tok }, cfgT, now).length, 0);
  assert.equal(ecTest({ X: tok }, cfgT, now, { byApproval: true }).length, 1);
  // sinal com nota abaixo de 60 (notaBaixa) ainda serve só para o teste da nota da aprovação
  const tokNb = { ...tok, sinal: { tipo: 'entrada', boa: false, notaBaixa: true, at: now, rr: 3 } };
  assert.equal(ecTest({ X: tokNb }, cfgT, now, { byApproval: true }).length, 1);
  // 16/11: compra automática só depois de 15 min no Radar (PASSED, VI e SENT viraram rug comprados com 2 a 9 min)
  const fresh = { ...tok, score: 80, approvedAt: now - 9 * 60000 };
  assert.equal(ecTest({ X: fresh }, cfgT, now).length, 0, 'aprovada há 9 min: espera');
  assert.equal(ecTest({ X: { ...fresh, approvedAt: now - 16 * 60000 } }, cfgT, now).length, 1, 'aprovada há 16 min: pode');
}

// Perfis: Agressivo por cima da configuração, sem mexer na base
{
  const cfgT = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const A = profileCfg(cfgT, 'agressivo');
  assert.equal(A.compra.scoreMinimo, 60); assert.equal(A.simulacao.riscoRetornoMin, 1.5); assert.equal(A.compra.maxComprasPorDia, cfgT.perfis.agressivo.compra.maxComprasPorDia);
  assert.equal(cfgT.compra.scoreMinimo, 70); assert.equal(cfgT.simulacao.riscoRetornoMin, 2); // a base não muda
  assert.equal(A.filtros.bundlePctMin, cfgT.filtros.bundlePctMin); // travas de golpe iguais
  const memos = [{ sig: 'b', memo: 'faro:perfil=agressivo' }, { sig: 'a', memo: 'faro:perfil=conservador' }];
  assert.equal((await readProfile(memos, async () => true)).name, 'agressivo');
  assert.equal((await readProfile(memos, async (sg) => sg === 'a')).name, 'conservador'); // memo não assinado pela carteira não vale
  // Rompimento de base (GTA 16/11): 4h presa entre ~650 e ~830, depois fecha acima com volume
  const t0 = Date.UTC(2026, 10, 16, 20);
  const base = Array.from({ length: 48 }, (_, i) => { const m = 740 + 80 * Math.sin(i / 3); return [t0 + i * 3e5, m, m + 10, m - 10, m + 5, 100]; });
  const brk = [...base, [t0 + 48 * 3e5, 830, 905, 828, 900, 400]];
  const bb = baseBreakout(brk, { buys5: 80, sells5: 30, safety: 'ok' });
  assert.ok(bb && bb.base && bb.rr >= 1.5, 'rompimento de base detectado');
  assert.equal(baseBreakout([...base, [t0 + 48 * 3e5, 830, 905, 828, 900, 90]], { safety: 'ok' }), null); // sem volume não vale
  // Entrada rasa na 38,2% (LEOSTAR 16/11): alta forte, corrige ~40% e reage com compra
  const up = Array.from({ length: 20 }, (_, i) => { const p = 400 + i * 45; return [t0 + i * 3e5, p, p + 20, p - 5, p + 15, 100]; });
  const top = up[19][2]; const lo0 = up[0][3]; const r40 = top - (top - lo0) * 0.4;
  const dn = [[t0 + 20 * 3e5, top - 20, top - 10, r40 + 30, r40 + 40, 80], [t0 + 21 * 3e5, r40 + 40, r40 + 45, r40, r40 + 5, 80], [t0 + 22 * 3e5, r40 + 5, r40 + 10, r40 + 1, r40 + 2, 80], [t0 + 23 * 3e5, r40 + 2, r40 + 60, r40 + 1, r40 + 55, 150]];
  const se = shallowEntry([...up, ...dn], { shape: 'organica', buyRatioH1: 62, buys5: 40, sells5: 20, safety: 'ok' });
  assert.ok(se && se.raso && se.rr >= 1.5, 'entrada rasa detectada');
  assert.equal(shallowEntry([...up, ...dn], { shape: 'organica', buyRatioH1: 45, safety: 'ok' }), null); // sem compra dominando não vale
  // Candidatos do agressivo usam o sinal agressivo e a nota 60
  const now = Date.now();
  const tok = { mint: 'Y', symbol: 'Y', status: 'aprovada', approvedAt: Date.now() - 3600e3, dexId: 'pumpswap', score: 63, safety: { level: 'ok', alerts: [] }, sinal: { tipo: 'entrada', boa: false, at: now }, sinalAgr: { ...se, at: now } };
  assert.equal(ecTest({ Y: tok }, cfgT, now).length, 0);
  const ag = ecTest({ Y: tok }, A, now, { agr: true });
  assert.equal(ag.length, 1); assert.equal(ag[0]._agrTipo, '38,2%'); assert.equal(ag[0].sinal.raso, true);
  assert.equal(ecTest({ Y: { ...tok, dexId: 'pumpfun' } }, A, now, { agr: true }).length, 0); // nunca na curva
  assert.equal(ecTest({ Y: { ...tok, safety: { level: 'danger', alerts: [] } } }, A, now, { agr: true }).length, 0);
}

// Perfil Crazy (só simulação): primeira correção depois do Radar, US$ 3, +50%
{
  const cfgT = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const L = cfgT.perfis.enlouquecido;
  const t0 = Date.UTC(2026, 10, 16, 22), ap = t0;
  const cs = [[t0, 100, 110, 99, 108, 1], [t0 + 3e5, 108, 140, 107, 138, 1], [t0 + 6e5, 138, 139, 112, 115, 1], [t0 + 9e5, 115, 122, 114, 121, 1]];
  const tok = { mint: 'Z', symbol: 'Z', status: 'aprovada', approvedAt: ap, dexId: 'pumpswap', score: 62, safety: { level: 'ok' }, shape: { tipo: 'organica' }, candles: cs, priceUsd: 121, periods: { m5: { buys: 30, sells: 20 } } };
  const g = crazyEntry(tok, t0 + 9e5, L);
  assert.ok(g && g.recuo >= 15, 'entra na primeira correção com reação');
  assert.equal(crazyEntry({ ...tok, dexId: 'pumpfun' }, t0 + 9e5, L), null);
  assert.equal(crazyEntry({ ...tok, priceUsd: 113 }, t0 + 9e5, L), null); // sem reação ainda
  const st = {}; const logs = [];
  simCrazy({ state: st, tokens: { Z: tok }, cfg: cfgT, now: t0 + 9e5, log: (m) => logs.push(m), solUsd: 140 });
  assert.equal(st.simLouco.open.length, 1);
  // sobe 55% sem força -> vende no +50%
  const t2 = { ...tok, priceUsd: 190, buyRatioH1: 50, candles: [...cs, [t0 + 12e5, 121, 190, 120, 188, 1]] };
  simCrazy({ state: st, tokens: { Z: t2 }, cfg: cfgT, now: t0 + 12e5, log: (m) => logs.push(m), solUsd: 140 });
  assert.equal(st.simLouco.closed[0].why, 'alvo +50%');
  assert.ok(st.simLouco.closed[0].pnlPct > 40);
  // não entra de novo na mesma moeda (só a primeira correção)
  simCrazy({ state: st, tokens: { Z: tok }, cfg: cfgT, now: t0 + 15e5, log: () => {}, solUsd: 140 });
  assert.equal(st.simLouco.open.length, 0);
}

// Regras em teste: maré vermelha e cético (2 stops seguidos = pausa de 45 min)
{
  const now = Date.now();
  const mk = (n, red) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, { status: 'aprovada', approvedAt: now - 3600e3, priceChangeH24: i < red ? -20 : 15 }]));
  assert.equal(marketTide(mk(10, 8), now).vermelha, true);
  assert.equal(marketTide(mk(10, 5), now).vermelha, false);
  assert.equal(marketTide(mk(3, 3), now).vermelha, false); // poucas moedas: não decide
  assert.equal(skepticOn([{ why: 'stop', exitAt: now - 10 * 60000 }, { why: 'stop', exitAt: now - 20 * 60000 }], now), true);
  assert.equal(skepticOn([{ why: 'stop', exitAt: now - 60 * 60000 }, { why: 'stop', exitAt: now - 70 * 60000 }], now), false);
  assert.equal(skepticOn([{ why: 'alvo +50%', exitAt: now - 10 * 60000 }, { why: 'stop', exitAt: now - 20 * 60000 }], now), false);
}

// Volume sumiu (saída em teste): no lucro e volume das 2 últimas velas 60%+ abaixo do pico desde a entrada
{
  const t0 = Date.UTC(2026, 10, 16, 23);
  const o = { entry: 100, at: t0 };
  const cs = [[t0, 100, 110, 99, 108, 500], [t0 + 3e5, 108, 125, 107, 120, 900], [t0 + 6e5, 120, 124, 118, 121, 300], [t0 + 9e5, 121, 123, 119, 122, 250]];
  assert.equal(volumeFade({ candles: cs }, o, 122), true);
  assert.equal(volumeFade({ candles: cs }, o, 105), false); // ainda sem lucro de 10%
  assert.equal(volumeFade({ candles: cs.map((x) => [...x.slice(0, 5), 800]) }, o, 122), false); // volume firme
}
if (process.argv.includes('--demo')) {
  state.config = cfg;
  await writeFile(new URL('../docs/demo.json', import.meta.url), JSON.stringify(state));
  console.log('docs/demo.json gerado');
}

// 17/11: venda pela Phantom (rota OKX/CASH) sai com ~0 SOL e o dinheiro chega minutos depois, de outra carteira
{
  const { linkDelayedProceeds } = await import('./api.mjs');
  const t0 = 1_000_000;
  const ops = [{ sig: 'buy', at: t0 - 60000, mint: 'M', tokens: 100, sol: -0.05 }, { sig: 'sell', at: t0, mint: 'M', tokens: -100, sol: -0.00008 }];
  const ins = [
    { sig: 'loanIn', at: t0, sol: 0.05, by: 'FEE', self: false }, { sig: 'loanOut', at: t0, sol: -0.0485, by: 'FEE', self: false }, // empréstimo de taxa: não conta
    { sig: 'pay', at: t0 + 200000, sol: 0.0375, by: 'PAYER', self: false },
  ];
  assert.equal(linkDelayedProceeds(ops, ins), 1);
  assert.equal(ops[1].sol, 0.0375);
  assert.equal(ops[1].linkSig, 'pay');
  assert.equal(linkDelayedProceeds(ops, ins), 0); // não liga duas vezes
}
console.log('Teste do dinheiro de venda que chega depois: ok');

// 17/11: reentrada não barra por aviso de momento (robô vendeu, queda do topo), só por alerta de segurança
{
  const { securityOk } = await import('./autobuy.mjs');
  assert.equal(securityOk({ safety: { level: 'warn', alerts: [{ id: 'vigia', level: 'warn' }, { id: 'preco-topo', level: 'warn' }] } }), true);
  assert.equal(securityOk({ safety: { level: 'warn', alerts: [{ id: 'dev-vendendo', level: 'warn' }] } }), false);
  assert.equal(securityOk({ safety: { level: 'danger', alerts: [{ id: 'liq-caiu', level: 'danger' }] } }), false);
}
console.log('Teste da segurança na reentrada: ok');

// 17/11: entrada em subida saudável (Dow + médias 9/21 + volume), para moedas seguras que não corrigem até a zona (Acrux)
{
  const { trendEntry } = await import('./signals.mjs');
  const mk = (pullback = true) => {
    const c = []; let p = 1, t = 0;
    const push = (o, cl, v) => c.push([t += 300000, o, Math.max(o, cl) * 1.01, Math.min(o, cl) * 0.99, cl, v]);
    for (let w = 0; w < 3; w++) { for (let i = 0; i < 5; i++) { const o = p; p *= 1.04; push(o, p, 1000); } for (let i = 0; i < 3; i++) { const o = p; p *= 0.985; push(o, p, 300); } }
    if (pullback) for (let i = 0; i < 3; i++) { const o = p; p *= 0.99; push(o, p, 300); } else for (let i = 0; i < 3; i++) { const o = p; p *= 1.05; push(o, p, 1000); }
    { const o = p; p *= 1.03; push(o, p, 900); }
    return c;
  };
  assert.ok(trendEntry(mk(), { safety: 'ok', score: 75, rrMin: 2 })?.boa, 'subida saudável com correção até a média: entra');
  assert.equal(trendEntry(mk(), { safety: 'warn', score: 75, rrMin: 2 }), null, 'segurança com alerta: não');
  assert.equal(trendEntry(mk(), { safety: 'ok', score: 60, rrMin: 2 }), null, 'nota abaixo de 70: não');
  assert.equal(trendEntry(mk(false), { safety: 'ok', score: 75, rrMin: 2 }), null, 'sem correção até a média (perseguindo): não');
}
console.log('Teste da subida saudável: ok');

// 17/11: saiu e entrou de novo: preço médio e custo só da operação aberta (JALU)
{
  const { positionFrom } = await import('./analyze.mjs');
  const ops = [
    { at: 1, tokens: 100, sol: -1 }, { at: 2, tokens: -100, sol: 1.2 }, // 1ª operação, fechada
    { at: 3, tokens: 100, sol: -2 },                                      // operação aberta, a 0,02 SOL cada
  ];
  const p = positionFrom(ops, 100, 0.03, 0.03 * 100);
  assert.ok(Math.abs(p.avgPriceSol - 0.02) < 1e-9, 'entrada = só a compra aberta');
  assert.ok(Math.abs(p.openPnlPct - 50) < 1e-6, 'lucro aberto sobre a entrada atual (+50%)');
}
console.log('Teste da entrada por operação: ok');

// Compras falsas (caso Lucia): quase só compra na contagem e o preço caindo
{
  const { fakeBuys } = await import('./signals.mjs');
  assert.ok(fakeBuys({ h1: { buys: 10400, sells: 1387, chg: -18 } }), 'Lucia: 88% compras e -18% na hora');
  assert.equal(fakeBuys({ h1: { buys: 10400, sells: 1387, chg: 25 } }), null, 'compras dominando com o preço subindo é saudável');
  assert.equal(fakeBuys({ m5: { buys: 20, sells: 2, chg: -15 } }), null, 'poucas transações não contam');
  console.log('Teste das compras falsas: ok');
}
// (17/11, JALU) a regra do ganho pelo preço de entrada vive na vigia (watch.mjs): venda parcial não pode virar "caiu 77%"
{
  const src = await readFile(new URL('./watch.mjs', import.meta.url), 'utf8');
  assert.match(src, /avgPx > 0 \? \(px \/ avgPx - 1\) \* 100/, 'a vigia deve medir o ganho pelo preço de entrada');
  console.log('Teste da venda parcial: ok');
}
// (17/11) par novo com pouca liquidez espera 20 min antes de ir ao Radar
{
  const { prefilter } = await import('./analyze.mjs');
  const cfgT = { busca: { idadeMinimaMinutos: 5, idadePoucaLiquidezMin: 20, poucaLiquidezUsd: 20000 }, filtros: { liquidezMinimaUsd: 0, marketCapMinimoUsd: 0, marketCapMaximoUsd: 1e12, volumeH1MinUsd: 0, comprasSobreTotalH1MinPct: 0 } };
  const base = { mcapUsd: 90000, volumeH1: 5000, buyRatioH1: 60 };
  assert.match(prefilter({ ...base, ageMin: 10, liquidityUsd: 15000 }, cfgT).join(), /pouca liquidez/, 'nova e com pouca liquidez espera');
  assert.equal(prefilter({ ...base, ageMin: 25, liquidityUsd: 15000 }, cfgT).length, 0, 'depois de 20 min passa');
  assert.equal(prefilter({ ...base, ageMin: 10, liquidityUsd: 30000 }, cfgT).length, 0, 'com liquidez boa não espera');
  console.log('Teste da espera por pouca liquidez: ok');
}
// (18/11, Pussy) a vigia liga o stop móvel sozinha e confirma em 10 s
{
  const src = await readFile(new URL('./watch.mjs', import.meta.url), 'utf8');
  assert.match(src, /liveOn = !t\.trail\?\.ativo/, 'a vigia deve ligar o stop móvel ao ver +ativarPct');
  const cfgT = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(cfgT.venda.stopMovel.confirmarSegundos, 10);
  console.log('Teste do stop móvel na vigia: ok');
}
// (18/11, Pussy) o pico da vigia é de cada operação: recompra depois de zerar não herda o pico antigo
{
  const src = await readFile(new URL('./watch.mjs', import.meta.url), 'utf8');
  assert.match(src, /resetPeak\(t, px\)/, 'a vigia deve zerar o pico numa operação nova');
  console.log('Teste do pico por operação: ok');
}

// Regra A (19/11): stop móvel liga com +20% e fica 12% abaixo do maior FECHAMENTO (o pavio não conta)
{
  const T0 = Date.now() - 20 * 60000; const c = [];
  const push = (h, cl) => c.push([T0 + c.length * 60000, cl, h, cl * 0.98, cl, 100]);
  push(1.02, 1); push(1.1, 1.08); push(1.6, 1.15); // pavio até +60%, mas fechou +15%
  const o = { ativarPct: 20, seguirAPartirPct: 20, distanciaPct: 12, minimoTravadoPct: 5, pico: 'fechamento' };
  assert.equal(trailStop(c, { entryPx: 1, entryAt: T0 }, o).ativo, false, 'pavio sozinho não liga o stop');
  push(1.35, 1.3); push(1.32, 1.25);
  const tr = trailStop(c, { entryPx: 1, entryAt: T0 }, o);
  assert.ok(tr.ativo && Math.abs(tr.stop - 1.3 * 0.88) < 1e-9, 'stop 12% abaixo do maior fechamento');
  const cfgA = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(cfgA.venda.stopMovel.pico, 'fechamento');
  const src = await readFile(new URL('./watch.mjs', import.meta.url), 'utf8');
  assert.match(src, /PR\.cpk = Math\.max\(PR\.cpk \|\| 0, PR\.last \|\| 0\)/, 'a vigia deve guardar o maior fechamento de 1 min');
  console.log('Teste da regra A do stop móvel: ok');
}

// Trava "pico já passou" (19/11)
{
  const { peakPassed } = await import('./signals.mjs');
  const now = Date.now(), o = { abaixoPct: 30, minutos: 30 };
  assert.ok(peakPassed(0.6, { px: 1, at: now - 45 * 60000 }, now, o), '40% abaixo do pico de 45 min atrás: trava');
  assert.equal(peakPassed(0.8, { px: 1, at: now - 45 * 60000 }, now, o), null, '20% abaixo: libera');
  assert.equal(peakPassed(0.5, { px: 1, at: now - 10 * 60000 }, now, o), null, 'pico de 10 min atrás: ainda é a correção da alta');
  const cfgP = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(cfgP.sinais.picoPassou.ligado, true);
  const src = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(src, /fase: 'pico-passou'/, 'a rodada deve travar o sinal');
  console.log('Teste da trava pico já passou: ok');
}

// O que faltou para a Boa entrada (19/11)
{
  const src = await readFile(new URL('./signals.mjs', import.meta.url), 'utf8');
  assert.match(src, /faltou\.push\(`vendas dominando/, 'o sinal deve dizer o que faltou');
  const run = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(run, /NA ZONA SEM ENTRADA/, 'a rodada deve anotar o motivo');
  console.log('Teste do motivo sem entrada: ok');
}

// 20/11: ajustes da análise de 19/11
{
  const { preBuyBlock, jupOk } = await import('./autobuy.mjs');
  const { linkDelayedProceeds } = await import('./api.mjs');
  const cfgB = { filtros: { devMaxTokensAnteriores: 5, rugcheckScoreMax: 50 }, busca: { jupiter: { organicMin: 50 } } };
  // RugCheck novo antes da compra (caso GTE)
  assert.match(preBuyBlock({ risks: [{ name: 'Creator history of rugged tokens' }] }, cfgB), /histórico de golpes/);
  assert.match(preBuyBlock({ creatorTokens: new Array(31).fill({}) }, cfgB), /já criou 31/);
  assert.match(preBuyBlock({ score_normalised: 76 }, cfgB), /76\/100/);
  assert.equal(preBuyBlock({ creatorTokens: [{}], score_normalised: 20, risks: [{ name: 'Low Liquidity' }] }, cfgB), null);
  assert.equal(preBuyBlock(null, cfgB), null, 'sem relatório segue');
  // organic score mínimo só para quem veio só pela Jupiter
  assert.equal(jupOk({ soJupiter: true, jup: { organicMax: 43 } }, cfgB), false);
  assert.equal(jupOk({ soJupiter: true, jup: { organicMax: 61 } }, cfgB), true);
  assert.equal(jupOk({ jup: { organicMax: 10 } }, cfgB), true);
  // venda paga em CASH: aluguel negativo na venda e pagamento 53 min depois (GTA6IRL, OGTA)
  const t0 = 2_000_000;
  const ops = [{ sig: 'b1', at: t0 - 180000, mint: 'G', tokens: 100, sol: -0.0273 }, { sig: 's1', at: t0, mint: 'G', tokens: -100, sol: -0.0015 },
    { sig: 'b2', at: t0 + 3600000, mint: 'O', tokens: 50, sol: -0.0138 }, { sig: 's2', at: t0 + 5000000, mint: 'O', tokens: -50, sol: 0 }];
  const ins = [{ sig: 'p1', at: t0 + 660000, sol: 0.0201, by: 'PAY', self: false }, { sig: 'p2', at: t0 + 5000000 + 53 * 60000, sol: 0.0132, by: 'PAY', self: false }];
  assert.equal(linkDelayedProceeds(ops, ins), 2);
  assert.equal(ops[1].sol, 0.0201); assert.equal(ops[3].sol, 0.0132);
  // depósito grande da mesma carteira não vira pagamento de venda pequena
  const ops2 = [{ sig: 'b', at: t0 - 60000, mint: 'X', tokens: 10, sol: -0.027 }, { sig: 's', at: t0, mint: 'X', tokens: -10, sol: 0 }];
  assert.equal(linkDelayedProceeds(ops2, [{ sig: 'dep', at: t0 + 600000, sol: 0.203, by: 'PAY', self: false }]), 0);
}
console.log('Teste dos ajustes de 20/11 (RugCheck antes da compra, organic da Jupiter, CASH): ok');

// 20/11: entrada rápida (vigia de entrada, só simulação)
{
  const { addTick, addLiq, rapidSignal, rapidExit, moveOf } = await import('./rapida.mjs');
  const M = 60000, t0 = Math.floor(1_800_000_000_000 / M) * M;
  // subida de 100 para 200 nas velas de 5 min depois da aprovação
  const candles = [];
  for (let i = 0; i < 8; i++) { const p = 100 + i * 14; candles.push([t0 + i * 5 * M, p, p + 14, p - 2, p + 14, 1000]); }
  const tok = { mint: 'R', symbol: 'RAP', status: 'aprovada', score: 75, approvedAt: t0, candles, dexId: 'raydium' };
  // depois correção até ~150 (fundo) e reação no 1 min
  const base1 = t0 + 45 * M; const bars = [];
  const seq = [[170, 172, 165, 166], [166, 167, 152, 153], [153, 156, 150, 155], [155, 162, 154, 161]];
  seq.forEach((b, i) => bars.push([base1 + i * M, ...b]));
  const liq = []; for (let i = 0; i < 8; i++) liq.push([base1 - 4 * M + i * 30000, 30000]);
  const now = base1 + 4 * M + 5000;
  const mkt = { priceUsd: 161, liquidityUsd: 30000, periods: { m5: { buys: 60, sells: 40, chg: 3 } } };
  const mv = moveOf(tok, bars, now);
  assert.ok(mv.peak >= 200 && mv.base <= 100, 'mede a subida');
  const g = rapidSignal(tok, bars, liq, mkt, now, {}, {});
  assert.ok(g.ok, 'entra na correção de ~50% com reação: ' + g.motivo);
  assert.ok(g.recuo > 38 && g.recuo < 62);
  // sem reação (última vela vermelha) não entra
  const bars2 = bars.map((b) => [...b]); bars2[3] = [base1 + 3 * M, 155, 156, 151, 152];
  assert.equal(rapidSignal(tok, bars2, liq, { ...mkt, priceUsd: 152 }, now, {}, {}).ok, false);
  // liquidez saindo não entra
  const liq2 = liq.map(([t, v], i) => [t, i < 4 ? 30000 : 24000]);
  assert.match(rapidSignal(tok, bars, liq2, mkt, now, {}, {}).motivo, /liquidez caiu/);
  // vendas dominando não entra
  assert.match(rapidSignal(tok, bars, liq, { ...mkt, periods: { m5: { buys: 30, sells: 50, chg: 1 } } }, now, {}, {}).motivo, /vendas/);
  // correção funda (fundo em 110) não entra
  const bars3 = bars.map((b) => [...b]); bars3[1] = [base1 + M, 166, 167, 110, 120]; bars3[2] = [base1 + 2 * M, 120, 125, 118, 124]; bars3[3] = [base1 + 3 * M, 124, 132, 122, 131];
  assert.match(rapidSignal(tok, bars3, liq, { ...mkt, priceUsd: 131 }, now, {}, {}).motivo, /funda/);
  // saídas
  const o = { entry: 100, at: now };
  assert.equal(rapidExit({ ...o }, 84, [], liq, now + 60000, {}).why, 'stop');
  assert.equal(rapidExit({ ...o }, 201, [], liq, now + 60000, {}).why, 'alvo');
  const ob = { ...o }; const bb = [[Math.floor(now / M) * M + M, 100, 131, 100, 130]];
  assert.equal(rapidExit(ob, 125, bb, liq, Math.floor(now / M) * M + 2 * M + 1000, { stopMovel: { ativarPct: 20, distanciaPct: 12 } }), null);
  assert.equal(rapidExit(ob, 113, bb, liq, Math.floor(now / M) * M + 2 * M + 2000, { stopMovel: { ativarPct: 20, distanciaPct: 12 } }).why, 'stop móvel');
  // velas de 1 min a partir dos preços
  const b = []; addTick(b, 10, t0); addTick(b, 12, t0 + 20000); addTick(b, 9, t0 + 40000); addTick(b, 11, t0 + M + 1000);
  assert.deepEqual(b[0], [t0, 10, 12, 9, 9]); assert.equal(b.length, 2);
  assert.equal(addLiq([], 0, t0).length, 0);
}
console.log('Teste da entrada rápida: ok');

// 20/11: uma moeda com "limite de consultas" no GeckoTerminal não pode travar as velas das outras (caso ANGSTIPAN)
{
  const tNow = now + 300 * min;
  const st2 = JSON.parse(JSON.stringify(state));
  const toks = Object.values(st2.tokens).filter((t) => t.pairAddress);
  for (const t of toks) { t.status = 'aprovada'; t.candlesAt = tNow - 60 * min; t.held = false; }
  const bad = toks.find((t) => t.symbol === 'BEBE'); // continua aprovada depois da análise da rodada
  assert.ok(bad, 'moeda de teste BEBE');
  bad.candlesAt = tNow - 120 * min; // a mais velha: primeira da fila
  let calls = 0;
  const api2 = { ...api, getCandlesFor: async (mint) => {
    calls++;
    if (mint === bad.mint) { const e = new Error('429 limite de consultas'); e.rateLimited = true; throw e; }
    const c = await api.getCandles('x' + mint); c.src = 'jup'; return c;
  } };
  const out = await runOnce({ api: api2, cfg, state: st2, now: tNow });
  const after = Object.values(out.tokens);
  assert.ok(after.find((t) => t.mint === bad.mint)?.candlesFailAt === tNow, 'a moeda com 429 fica de castigo 30 min');
  assert.ok(after.some((t) => t.mint !== bad.mint && t.candlesAt === tNow), 'as outras moedas recebem velas novas na mesma rodada');
}
console.log('Teste das velas com limite de consultas: ok');

// 20/11: tendência de baixa (regra em teste, só marca)
{
  const { downtrend } = await import('./tendencia.mjs');
  const T0 = 1_800_000_000_000, V = 5 * 60000;
  const mk = (arr) => arr.map(([o, h, l, c], i) => [T0 + i * V, o, h, l, c, 100]);
  // subida e depois escada: cada vela fecha mais baixo
  const up = [[10, 11, 9.8, 11], [11, 12, 10.8, 12], [12, 13, 11.8, 13], [13, 14, 12.8, 14]];
  const escada = [[14, 14.2, 13.4, 13.5], [13.5, 13.6, 12.9, 13], [13, 13.1, 12.4, 12.5], [12.5, 12.6, 11.9, 12], [12, 12.1, 11.4, 11.5], [11.5, 11.6, 10.9, 11]];
  const d = downtrend(mk([...up, ...escada]));
  assert.ok(d?.escada, 'escada de queda marcada');
  // queda parou: vela fecha acima das 2 máximas anteriores sem fundo novo
  assert.equal(downtrend(mk([...up, ...escada, [11, 12.8, 11, 12.7]])), null, 'reversão libera');
  // correção lateral (sobe e desce) não marca
  const lateral = [[14, 14.2, 13.4, 13.6], [13.6, 14, 13.5, 13.9], [13.9, 14, 13.3, 13.4], [13.4, 13.9, 13.3, 13.8], [13.8, 13.9, 13.2, 13.3], [13.3, 13.8, 13.2, 13.7]];
  assert.equal(downtrend(mk([...up, ...lateral])), null, 'lateral não marca');
  // suporte em 12 tocado 2 vezes e rompido
  const base = [[12.5, 13, 12, 12.6], [12.6, 13, 12.3, 12.8], [12.8, 13, 12.4, 12.7], [12.7, 13, 12.5, 12.9], [12.9, 13.1, 12.02, 12.5], [12.5, 13, 12.4, 12.9], [12.9, 13.2, 12.6, 13], [13, 13.3, 12.7, 13.1], [13.1, 13.3, 12.8, 12.9], [12.9, 13.1, 12.5, 12.6], [12.6, 12.7, 11.6, 11.7]];
  const sp = downtrend(mk(base));
  assert.ok(sp?.suporte && Math.abs(sp.suporte - 12) < 0.1, 'suporte rompido marcado: ' + JSON.stringify(sp));
  // a simulação guarda a marca e conta em stats.regras
  const { simStep } = await import('./sim.mjs');
  assert.equal(typeof simStep, 'function');
}
console.log('Teste da tendência de baixa: ok');

// Reprovação manual pelo painel (21/11)
{
  const { mkdtemp } = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
  process.env.FARO_PUSH_DIR = await mkdtemp(path.join(os.tmpdir(), 'faro-man-'));
  const M = await import('./manual.mjs?t=' + Date.now());
  const mint = '7bCiddGLe5aM8HE2pigT9jsqkmC1HSPxyXN6GkHEpump';
  await M.reprovar(mint, 'OGTA');
  assert.ok((await M.lerReprovadas())[mint], 'grava a moeda reprovada');
  await assert.rejects(M.reprovar('../../etc/passwd'), /inválido/);
  await M.desfazer(mint);
  assert.equal((await M.lerReprovadas())[mint], undefined, 'desfazer tira da lista');
  const run = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(run, /Reprovada por você no painel/);
  console.log('Teste da reprovação manual: ok');
}

// Perfil Segurar (21/11)
{
  const { PROFILE_RE, profileCfg } = await import('./autobuy.mjs');
  assert.equal(PROFILE_RE.exec('faro:perfil=segurar')?.[1], 'segurar');
  const cfgS = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const seg = profileCfg(cfgS, 'segurar');
  assert.equal(seg.segurar.alvoPct, 150); assert.equal(seg.segurar.ligado, true);
  const { simStep } = await import('./sim.mjs');
  const now = Date.now(), st = { simSeg: { open: [{ mint: 'M', symbol: 'M', at: now - 3600000, entry: 1, stop: 0.85, sol: 0.05 }], closed: [], startedAt: now } };
  // caiu 60%: no Segurar não sai
  simStep({ state: st, key: 'simSeg', tokens: { M: { mint: 'M', priceUsd: 0.4, candles: [[now - 300000, 0.5, 0.5, 0.4, 0.4, 1]] } }, candidates: [], cfg: seg, now, log: () => {} });
  assert.equal(st.simSeg.open.length, 1, 'sem stop no Segurar');
  // chegou a +150%: sai no alvo
  simStep({ state: st, key: 'simSeg', tokens: { M: { mint: 'M', priceUsd: 2.6, candles: [[now, 2, 2.6, 2, 2.6, 1]] } }, candidates: [], cfg: seg, now: now + 60000, log: () => {} });
  assert.equal(st.simSeg.open.length, 0); assert.match(st.simSeg.closed[0].why, /alvo \+150%/);
  const w = await readFile(new URL('./watch.mjs', import.meta.url), 'utf8');
  assert.match(w, /if \(SEGt\) \{/, 'a vigia deve pular tudo nas posições do Segurar');
  console.log('Teste do perfil Segurar: ok');
}

// Alvo do Segurar moeda por moeda (21/11)
{
  const { mkdtemp } = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
  process.env.FARO_PUSH_DIR = await mkdtemp(path.join(os.tmpdir(), 'faro-seg-'));
  const M = await import('./manual.mjs?seg=' + Date.now());
  const mint = '7bCiddGLe5aM8HE2pigT9jsqkmC1HSPxyXN6GkHEpump';
  await M.definirSegurar(mint, 200);
  const esc = await M.lerSegurar();
  assert.equal(M.segurarDe({ mint, segurar: { desde: Date.now() - 60000, alvoPct: 150 } }, esc).alvoPct, 200, 'escolha do painel muda o alvo');
  assert.equal(M.segurarDe({ mint }, esc).alvoPct, 200, 'vale para compra manual');
  await M.definirSegurar(mint, 0);
  assert.equal(M.segurarDe({ mint, segurar: { desde: 1, alvoPct: 150 } }, await M.lerSegurar()), null, 'Normal volta às regras');
  await M.definirSegurar(mint, 500); assert.equal(M.segurarDe({ mint }, await M.lerSegurar()).alvoPct, 500, '+500% vale');
  await M.definirSegurar(mint, M.INFINITO); assert.equal(M.segurarDe({ mint }, await M.lerSegurar()).alvoPct, 999, 'Infinito vale');
  await assert.rejects(M.definirSegurar(mint, 250), /inválido/);
  console.log('Teste do alvo do Segurar por moeda: ok');
}

// Preço do SOL absurdo (par que não é contra SOL) não estraga o resultado (25/11, Zolana)
{
  const { positionFrom } = await import('./analyze.mjs');
  const ops = [{ at: 1, tokens: 1000, sol: -0.0015 }, { at: 2, tokens: -1000, sol: 0.0012 }];
  const p = positionFrom(ops, 0, 1e-12, 0.0002, 150); // par contra outra moeda: priceUsd/priceNative = 2e8
  assert.ok(Math.abs(p.receivedUsd - 0.18) < 1e-6, 'usa o preço de referência do SOL');
  assert.ok(p.pnlPct < 0, 'resultado negativo, não milhões de %');
  console.log('Teste do preço do SOL absurdo: ok');
}

// Carteiras seguidas editadas pelo painel (26/11)
{
  const { mkdtemp } = await import("node:fs/promises"); const os = await import("node:os"); const path = await import("node:path");
  process.env.FARO_PUSH_DIR = await mkdtemp(path.join(os.tmpdir(), 'faro-sg-'));
  const M = await import('./manual.mjs?sg=' + Date.now());
  const pad = [{ endereco: 'Agir746nCrbvqHCjpy4zSb1EmAHuh1Pbhzn4fSbtwz6a', apelido: 'Carteira 1' }];
  assert.equal((await M.lerSeguidas(pad)).length, 1, 'sem arquivo usa o config');
  await M.salvarSeguida('Agir746nCrbvqHCjpy4zSb1EmAHuh1Pbhzn4fSbtwz6a', 'Baleia', pad);
  await M.salvarSeguida('7bCiddGLe5aM8HE2pigT9jsqkmC1HSPxyXN6GkHEpump', 'Outra', pad);
  let l = await M.lerSeguidas(pad);
  assert.equal(l.length, 2); assert.equal(l[0].apelido, 'Baleia');
  l = await M.removerSeguida('Agir746nCrbvqHCjpy4zSb1EmAHuh1Pbhzn4fSbtwz6a', pad);
  assert.equal(l.length, 1);
  await assert.rejects(M.salvarSeguida('x', 'y', pad), /inválido/);
  console.log('Teste das carteiras seguidas: ok');
}
