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
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

const RPC = () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
async function rpc(method, params) {
  const res = await fetch(RPC(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (res.status === 429) { const e = new Error('RPC pediu pausa (429)'); e.rateLimited = true; throw e; }
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'erro no RPC');
  return j.result;
}

export async function getWalletHoldings(owner) {
  const out = new Map();
  for (const programId of TOKEN_PROGRAMS) {
    const r = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
    for (const acc of r?.value || []) {
      const info = acc.account?.data?.parsed?.info;
      const amount = Number(info?.tokenAmount?.uiAmount || 0);
      if (!info?.mint || amount <= 0 || IGNORE.has(info.mint)) continue;
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
export async function getWalletOps(owner, lastSig, maxTx = 40) {
  const sigs = await rpc('getSignaturesForAddress', [owner, { limit: 100, ...(lastSig ? { until: lastSig } : {}) }]);
  const fresh = (sigs || []).filter((x) => !x.err);
  const batch = fresh.slice(-maxTx).reverse(); // as mais antigas das novas, em ordem cronológica
  const ops = [];
  for (const x of batch) {
    const tx = await getTx(x.signature);
    if (tx && !tx.meta?.err) ops.push(...parseOps(tx, owner, x.signature));
    await sleep(150);
  }
  const newest = batch.length ? batch[batch.length - 1].signature : (sigs?.[0]?.signature || lastSig || null);
  return { ops, lastSig: newest, pending: Math.max(0, fresh.length - batch.length) };
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
  const deltas = [];
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const d = (post.get(mint) || 0) - (pre.get(mint) || 0);
    if (Math.abs(d) < 1e-12) continue;
    if (mint === 'So11111111111111111111111111111111111111112') sol += d; // SOL embrulhado conta como SOL
    else if (!IGNORE.has(mint)) deltas.push([mint, d]);
  }
  // Só registramos troca simples (1 moeda contra SOL), que é o caso de compra/venda de memecoin
  return deltas.length === 1 ? [{ sig, at: (tx.blockTime || 0) * 1000, mint: deltas[0][0], tokens: deltas[0][1], sol }] : [];
}

// Velas de 5 minutos das últimas ~6h (GeckoTerminal, grátis, sem chave)
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
