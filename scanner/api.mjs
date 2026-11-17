// Consultas às APIs públicas (DexScreener e RugCheck). Não precisam de chave.

const DEX = 'https://api.dexscreener.com';
const RUG = 'https://api.rugcheck.xyz/v1';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { timeoutMs = 15000, retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', ...headers } });
      if (res.status === 429) {
        const err = new Error(`429 limite de consultas em ${url}`);
        err.rateLimited = true;
        throw err;
      }
      if (!res.ok) throw new Error(`${res.status} em ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.rateLimited) throw e;
      await sleep(800 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// Moedas novas com perfil, boosts e takeovers (é de onde vêm os lançamentos "com profile" do seu filtro)
export async function getSolanaCandidates(log) {
  const sources = [
    ['perfis novos', '/token-profiles/latest/v1'],
    ['boosts recentes', '/token-boosts/latest/v1'],
    ['mais impulsionadas', '/token-boosts/top/v1'],
    ['community takeovers', '/community-takeovers/latest/v1'],
  ];
  const found = new Map();
  for (const [label, path] of sources) {
    try {
      const data = await getJson(DEX + path);
      const list = Array.isArray(data) ? data : [];
      let n = 0;
      for (const item of list) {
        if (item?.chainId !== 'solana' || !item?.tokenAddress) continue;
        if (!found.has(item.tokenAddress)) {
          found.set(item.tokenAddress, {
            mint: item.tokenAddress,
            source: label,
            icon: item.icon || null,
            description: item.description || '',
            links: (item.links || []).map((l) => ({ label: l.label || l.type || 'link', url: l.url })).filter((l) => l.url).slice(0, 4),
          });
          n++;
        }
      }
      log(`DexScreener ${label}: ${n} moedas Solana`);
    } catch (e) {
      log(`Falha em DexScreener ${label}: ${e.message}`, true);
    }
  }
  // Em alta no GeckoTerminal: pega moedas que estão subindo forte mesmo sem perfil pago no DexScreener
  // (casos FLOOR e MEOWL em 16/11: o robô só viu depois do pico)
  const SKIP = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
  // + pools novos na PumpSwap: a moeda acabou de sair da curva da pump.fun e ganhou liquidez de verdade (o robô vê na hora da migração)
  const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
  for (const [label, url, src] of [
    ['em alta (1h)', `${GT}/trending_pools?duration=1h&page=1`, 'em alta (GeckoTerminal)'],
    ['em alta (1h) 2', `${GT}/trending_pools?duration=1h&page=2`, 'em alta (GeckoTerminal)'],
    ['em alta (5min)', `${GT}/trending_pools?duration=5m&page=1`, 'em alta (GeckoTerminal)'],
    ['migradas para a PumpSwap', `${GT}/new_pools?page=1`, 'migrou para a PumpSwap'],
    ['migradas para a PumpSwap 2', `${GT}/new_pools?page=2`, 'migrou para a PumpSwap'],
  ]) {
    try {
      const j = await getJson(url, { headers: { accept: 'application/json;version=20230302' }, retries: 1 });
      let n = 0;
      for (const pool of j?.data || []) {
        const mint = String(pool?.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
        if (!mint || SKIP.has(mint) || found.has(mint)) continue;
        // pools da PumpSwap com mais de 1h já foram vistos antes (ou não interessam): só os recém-migrados
        if (src === 'migrou para a PumpSwap' && (pool?.relationships?.dex?.data?.id !== 'pumpswap' || Date.now() - Date.parse(pool?.attributes?.pool_created_at || 0) > 3600000)) continue;
        found.set(mint, { mint, source: src, icon: null, description: '', links: [] });
        n++;
      }
      log(`GeckoTerminal ${label}: ${n} moedas novas`);
    } catch (e) {
      log(`Falha em GeckoTerminal ${label}: ${e.message}`, true);
      if (e.rateLimited) break;
    }
  }
  return [...found.values()];
}

// Dados de mercado de até 30 moedas por consulta
export async function getMarketData(mints, log) {
  const byMint = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const pairs = await getJson(`${DEX}/tokens/v1/solana/${chunk.join(',')}`);
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const mint = p?.baseToken?.address;
        if (!mint || !chunk.includes(mint)) continue;
        if (!byMint.has(mint)) byMint.set(mint, []);
        byMint.get(mint).push(p);
      }
    } catch (e) {
      log(`Falha ao buscar mercado (lote ${i / 30 + 1}): ${e.message}`, true);
    }
    await sleep(250);
  }
  return byMint;
}

export async function getRugReport(mint) {
  return getJson(`${RUG}/tokens/${mint}/report`, { timeoutMs: 20000, retries: 1 });
}

// Moedas que estão na sua carteira (lê só o endereço público; não precisa de chave)
const IGNORE = new Set([
  'So11111111111111111111111111111111111111112', // SOL embrulhado
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
const STABLE = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

const RPC = () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
async function rpc(method, params) {
  const res = await fetch(RPC(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (res.status === 429) { const e = new Error('RPC pediu pausa (429)'); e.rateLimited = true; throw e; }
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'erro no RPC');
  return j.result;
}

// Memos recentes da carteira (para o interruptor da compra automática) e quem assinou uma transação
export async function getMemos(owner) {
  const sigs = await rpc('getSignaturesForAddress', [owner, { limit: 40 }]);
  return (sigs || []).filter((x) => x.memo).map((x) => ({ sig: x.signature, memo: x.memo, at: (x.blockTime || 0) * 1000, err: x.err }));
}
export async function txSigner(sig) {
  const tx = await getTx(sig);
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.find((k) => k.signer)?.pubkey || null;
}

export async function getWalletHoldings(owner) {
  const out = new Map();
  for (const programId of TOKEN_PROGRAMS) {
    const r = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
    for (const acc of r?.value || []) {
      const info = acc.account?.data?.parsed?.info;
      const amount = Number(info?.tokenAmount?.uiAmount || 0);
      if (!info?.mint || amount < 1e-6 || IGNORE.has(info.mint)) continue; // poeira (ex.: sobra de rota da Jupiter) não conta
      const cur = out.get(info.mint) || { mint: info.mint, amount: 0, decimals: info.tokenAmount.decimals };
      cur.amount += amount;
      out.set(info.mint, cur);
    }
  }
  return [...out.values()];
}

export async function getSolBalance(owner) {
  const r = await rpc('getBalance', [owner]);
  return Number(r?.value || 0) / 1e9;
}

// Compras e vendas da carteira, lidas das transações (só leitura).
// Processa das mais antigas para as mais novas, no máximo maxTx por rodada, continuando de onde parou.
export async function getWalletIncoming(owner, limit = 60) {
  const sigs = await rpc('getSignaturesForAddress', [owner, { limit }]);
  const ins = [];
  for (const x of (sigs || []).filter((y) => !y.err)) {
    const tx = await getTx(x.signature);
    if (tx && !tx.meta?.err) { const r = parseIncoming(tx, owner, x.signature); if (r) ins.push(r); }
    await sleep(150);
  }
  return ins;
}
export async function getWalletOps(owner, lastSig, maxTx = 40) {
  const sigs = await rpc('getSignaturesForAddress', [owner, { limit: 100, ...(lastSig ? { until: lastSig } : {}) }]);
  const fresh = (sigs || []).filter((x) => !x.err);
  const batch = fresh.slice(-maxTx).reverse(); // as mais antigas das novas, em ordem cronológica
  const ops = [], ins = [];
  for (const x of batch) {
    const tx = await getTx(x.signature);
    if (tx && !tx.meta?.err) { ops.push(...parseOps(tx, owner, x.signature)); const r = parseIncoming(tx, owner, x.signature); if (r) ins.push(r); }
    await sleep(150);
  }
  const newest = batch.length ? batch[batch.length - 1].signature : (sigs?.[0]?.signature || lastSig || null);
  return { ops, ins, lastSig: newest, pending: Math.max(0, fresh.length - batch.length) };
}

// Transações novas da Solana podem vir em versões mais recentes; pedimos a maior que o RPC aceitar
let txVersion = 1;
async function getTx(signature) {
  try {
    return await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: txVersion, commitment: 'confirmed' }]);
  } catch (e) {
    const m = /version \((\d+)\)/i.exec(e.message || '');
    if (m && Number(m[1]) > txVersion) { txVersion = Number(m[1]); return getTx(signature); }
    throw e;
  }
}

// Quanto SOL entrou ou saiu da TROCA em si (o mesmo número que a Phantom usa como custo):
// soma o que passou pela sua conta de SOL embrulhado, sem taxa de rede, gorjeta nem criação de contas.
export function swapSol(tx, owner) {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const meta = tx.meta || {};
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const mine = new Set();
  for (const b of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) if (b.owner === owner && b.mint === WSOL && keys[b.accountIndex]) mine.add(keys[b.accountIndex]);
  const all = [...(tx.transaction?.message?.instructions || []), ...(meta.innerInstructions || []).flatMap((x) => x.instructions || [])];
  for (const ins of all) { const p = ins.parsed; if (p && /^initializeAccount/.test(p.type || '') && p.info?.mint === WSOL && p.info?.owner === owner) mine.add(p.info.account); }
  if (!mine.size) return null;
  let net = 0, moved = false;
  for (const ins of all) {
    const p = ins.parsed;
    if (!p || ins.program !== 'spl-token' || (p.type !== 'transfer' && p.type !== 'transferChecked')) continue;
    const amt = Number(p.info?.amount ?? p.info?.tokenAmount?.amount);
    if (!(amt > 0)) continue;
    if (mine.has(p.info.source)) { net -= amt; moved = true; }
    if (mine.has(p.info.destination)) { net += amt; moved = true; }
  }
  return moved && net !== 0 ? net / 1e9 : null;
}

export function parseOps(tx, owner, sig) {
  const meta = tx.meta || {};
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(owner);
  let sol = i >= 0 ? (Number(meta.postBalances?.[i] || 0) - Number(meta.preBalances?.[i] || 0)) / 1e9 : 0;
  const bal = (arr) => {
    const m = new Map();
    for (const b of arr || []) if (b.owner === owner) m.set(b.mint, (m.get(b.mint) || 0) + Number(b.uiTokenAmount?.uiAmount || 0));
    return m;
  };
  const pre = bal(meta.preTokenBalances), post = bal(meta.postTokenBalances);
  // A conta da moeda criada na 1ª compra (ou fechada ao vender tudo) mexe ~0,002 SOL de "aluguel" que volta depois.
  // Não é custo da moeda, então tiramos da conta (a Phantom faz o mesmo).
  const RENT = 0.00203928;
  const owned = (arr, mint) => (arr || []).some((b) => b.owner === owner && b.mint === mint);
  const deltas = [];
  let stable = 0;
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const d = (post.get(mint) || 0) - (pre.get(mint) || 0);
    if (Math.abs(d) < 1e-12) continue;
    if (mint === 'So11111111111111111111111111111111111111112') sol += d; // SOL embrulhado conta como SOL
    else if (STABLE.has(mint)) stable += d; // compra/venda paga em dólar (USDC/USDT)
    else if (!IGNORE.has(mint)) deltas.push([mint, d]);
  }
  // Rotas da Jupiter às vezes deixam "poeira" de outra moeda (ex.: 0,000000005 de uma ação tokenizada): ignora
  if (deltas.length > 1) { const big = Math.max(...deltas.map(([, d]) => Math.abs(d))); deltas.splice(0, deltas.length, ...deltas.filter(([, d]) => Math.abs(d) >= 1e-4 && Math.abs(d) >= big * 1e-6)); }
  // Só registramos troca simples (1 moeda contra SOL), que é o caso de compra/venda de memecoin
  if (deltas.length !== 1) return [];
  const mint = deltas[0][0];
  if (!owned(meta.preTokenBalances, mint) && owned(meta.postTokenBalances, mint)) sol += RENT; // abriu a conta
  if (owned(meta.preTokenBalances, mint) && !owned(meta.postTokenBalances, mint)) sol -= RENT; // fechou a conta
  if (i === 0) sol += Number(meta.fee || 0) / 1e9; // taxa de rede não é custo da moeda
  const sw = swapSol(tx, owner);
  if (sw != null && Math.sign(sw) === -Math.sign(deltas[0][1])) sol = sw; // valor exato da troca, quando dá para ler
  const op = { sig, at: (tx.blockTime || 0) * 1000, mint, tokens: deltas[0][1], sol };
  if (Math.abs(stable) > 0.005) op.stable = stable; // vira SOL equivalente quando soubermos o preço do SOL daquele minuto
  return [op];
}

// SOL que entrou sem troca de moeda, numa transação assinada por OUTRA carteira. Acontece quando a Phantom vende por
// outra rota (ex.: OKX/CASH): a venda sai com ~0 SOL e o dinheiro chega minutos depois, noutra transação (17/11: Minnie).
export function parseIncoming(tx, owner, sig) {
  const meta = tx.meta || {};
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(owner); if (i < 0) return null;
  const moved = [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])].some((b) => {
    if (b.owner !== owner) return false;
    const pre = (meta.preTokenBalances || []).find((x) => x.accountIndex === b.accountIndex), post = (meta.postTokenBalances || []).find((x) => x.accountIndex === b.accountIndex);
    return Math.abs(Number(post?.uiTokenAmount?.uiAmount || 0) - Number(pre?.uiTokenAmount?.uiAmount || 0)) > 1e-9;
  });
  if (moved) return null;
  const sol = (Number(meta.postBalances?.[i] || 0) - Number(meta.preBalances?.[i] || 0)) / 1e9;
  if (Math.abs(sol) < 0.001) return null;
  return { sig, at: (tx.blockTime || 0) * 1000, sol, by: keys[0] || '' , self: keys[0] === owner };
}

// Liga a venda que saiu com ~0 SOL ao dinheiro que chegou depois (até 15 min), de outra carteira.
// Entradas e saídas da mesma carteira no mesmo minuto que se anulam (empréstimo de taxa) não contam.
export function linkDelayedProceeds(ops, ins) {
  const real = (ins || []).filter((r) => !r.self && r.sol > 0 && !(ins || []).some((x) => x !== r && x.by === r.by && Math.abs(x.at - r.at) < 90000 && Math.abs(x.sol + r.sol) < 0.004));
  const used = new Set((ops || []).filter((o) => o.linkSig).map((o) => o.linkSig));
  let n = 0;
  for (const o of [...(ops || [])].sort((a, b) => a.at - b.at)) {
    if (!(o.tokens < 0) || o.linkSig || Math.abs(o.sol) > 0.0005) continue;
    const r = real.filter((x) => !used.has(x.sig) && x.at >= o.at && x.at - o.at <= 15 * 60000).sort((a, b) => a.at - b.at)[0];
    if (!r) continue;
    o.sol = r.sol; o.linkSig = r.sig; used.add(r.sig); n++;
  }
  return n;
}

// Preço em dólar de um par num minuto exato do passado (GeckoTerminal). Para o SOL, use SOL_POOL.
export const SOL_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'; // SOL/USDC, o par mais líquido
export async function getPriceAt(pairAddress, atMs) {
  const before = Math.floor(atMs / 1000) + 60;
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=1&before_timestamp=${before}&limit=1&currency=usd`;
  const j = await getJson(url, { headers: { accept: 'application/json;version=20230302' }, retries: 1 });
  const c = j?.data?.attributes?.ohlcv_list?.[0];
  if (!c || Math.abs(c[0] * 1000 - atMs) > 3 * 3600000) return null; // sem vela perto daquele horário
  const v = Number(c[4]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Velas de 5 minutos das últimas ~6h (GeckoTerminal, grátis, sem chave)
// Velas de 5 min: primeiro a Jupiter (por moeda, junta todos os pools), depois o GeckoTerminal (por pool)
export async function getCandlesFor(mint, pairAddress) {
  try {
    const r = await fetch(`https://datapi.jup.ag/v2/charts/${mint}?interval=5_MINUTE&to=${Date.now()}&candles=72&type=price&quote=usd`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const list = ((await r.json())?.candles || []).map((c) => [c.time * 1000, +c.open, +c.high, +c.low, +c.close, Math.round(+c.volume || 0)]).filter((c) => c.every(Number.isFinite)).sort((a, b) => a[0] - b[0]);
      if (list.length && Date.now() - list[list.length - 1][0] < 40 * 60000) return list;
    }
  } catch {}
  return pairAddress ? getCandles(pairAddress) : [];
}

export async function getCandles(pairAddress) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=5&limit=72&currency=usd`;
  const j = await getJson(url, { headers: { accept: 'application/json;version=20230302' }, retries: 1 });
  const list = j?.data?.attributes?.ohlcv_list || [];
  // vem do mais novo para o mais antigo: [timestamp(s), open, high, low, close, volume]
  return list
    .map((c) => [c[0] * 1000, +c[1], +c[2], +c[3], +c[4], Math.round(+c[5])])
    .filter((c) => c.every(Number.isFinite))
    .sort((a, b) => a[0] - b[0]);
}

// Preço do SOL em dólar agora (para registrar o valor de cada compra no momento em que ela acontece)
export async function getSolUsd() {
  const pairs = await getJson(`${DEX}/tokens/v1/solana/So11111111111111111111111111111111111111112`);
  const usdc = (pairs || []).filter((p) => ['USDC', 'USDT'].includes(p?.quoteToken?.symbol) && p?.baseToken?.address === 'So11111111111111111111111111111111111111112');
  const best = (usdc.length ? usdc : pairs || []).sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
  const v = Number(best?.priceUsd);
  return Number.isFinite(v) && v > 0 ? v : null;
}
