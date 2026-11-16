// Teste com dados simulados (sem internet). Rode: node scanner/test.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runOnce } from './run.mjs';
import { parseOps } from './api.mjs';
import { scamSignals } from './analyze.mjs';

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
  YOUNG: [pair('YOUNG', 'BEBE', { ageMin: 5 })],
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
assert.equal(scamSignals(base0, { lpLockedPct: 100, devPct: 1, mintAuthority: 'X', freezeAuthority: null }, cfgT).length, 2);
assert.equal(scamSignals(base0, { rugged: true, lpLockedPct: 100, devPct: 4 }, cfgT).length, 1);
// moeda comprada já sem liquidez travada não dispara venda
assert.equal(scamSignals({ lpLockedPct: 0, devPct: 0 }, { lpLockedPct: 0, devPct: 0 }, cfgT).length, 0);

// Simulação: abre com plano (risco/retorno >= 2) e fecha no alvo ou no stop
{
  const { simStep } = await import('./sim.mjs');
  const cfgS = { compra: { solPorCompra: 0.05, scoreMinimo: 70, maxComprasPorDia: 5 }, simulacao: { ligado: true } };
  const st = {}; const logs = [];
  const tk = { A: { mint: 'A', symbol: 'AAA', priceUsd: 1, score: 80, candles: [] }, B: { mint: 'B', symbol: 'BBB', priceUsd: 1, score: 50, candles: [] } };
  simStep({ state: st, tokens: tk, newlyApproved: [tk.A, tk.B], cfg: cfgS, now: 1000, log: (m) => logs.push(m) });
  assert.equal(st.sim.open.length, 1); // B tem nota baixa
  tk.A.priceUsd = 2.1; // passou do alvo (+100%)
  simStep({ state: st, tokens: tk, newlyApproved: [], cfg: cfgS, now: 2000, log: (m) => logs.push(m) });
  assert.equal(st.sim.closed[0].why, 'alvo');
  assert.ok(st.sim.closed[0].pnlPct > 85 && st.sim.closed[0].pnlPct < 100); // descontados os custos
  tk.C = { mint: 'C', symbol: 'CCC', priceUsd: 1, score: 90, candles: [] };
  simStep({ state: st, tokens: tk, newlyApproved: [tk.C], cfg: cfgS, now: 3000, log: (m) => logs.push(m) });
  tk.C.priceUsd = 0.7;
  simStep({ state: st, tokens: tk, newlyApproved: [], cfg: cfgS, now: 4000, log: (m) => logs.push(m) });
  assert.equal(st.sim.closed[0].why, 'stop');
  assert.ok(st.sim.closed[0].pnlPct < -25);
  assert.equal(st.sim.stats.ops, 2);
}

// Compra desligada por padrão
assert.equal(state.lastRun.autoBuy, false);
assert.equal(cfg.compra.ativada, false);

console.log('\nTodos os testes passaram.');
console.log(JSON.stringify(state.lastRun.counts));

// Gera um exemplo para visualizar o painel sem internet
if (process.argv.includes('--demo')) {
  state.config = cfg;
  await writeFile(new URL('../docs/demo.json', import.meta.url), JSON.stringify(state));
  console.log('docs/demo.json gerado');
}
