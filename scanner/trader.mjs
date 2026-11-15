// Módulo de compra automática via Jupiter. VEM DESLIGADO.
// Para funcionar precisa das DUAS travas ligadas:
//   1. config.json -> "compra": { "ativada": true }
//   2. No GitHub: variável AUTO_BUY = true (Settings > Secrets and variables > Actions > Variables)
// E dos segredos: SOLANA_PRIVATE_KEY (carteira SÓ do robô), JUPITER_API_KEY, SOLANA_RPC_URL (opcional).
// Ainda não vende sozinho: a venda continua manual por enquanto.

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP = 'https://api.jup.ag/swap/v1';

export async function createTrader(cfg, log) {
  const on = cfg?.compra?.ativada === true && process.env.AUTO_BUY === 'true';
  if (!on) return null;
  const key = process.env.SOLANA_PRIVATE_KEY;
  const jupKey = process.env.JUPITER_API_KEY;
  if (!key || !jupKey) {
    log('Compra ligada, mas faltam os segredos SOLANA_PRIVATE_KEY ou JUPITER_API_KEY. Nada foi comprado.', true);
    return null;
  }
  // Bibliotecas só são carregadas quando a compra está ligada
  const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const wallet = Keypair.fromSecretKey(bs58.decode(key.trim()));
  const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const headers = { 'x-api-key': jupKey, 'Content-Type': 'application/json' };
  log(`Compra automática LIGADA (carteira ${wallet.publicKey.toBase58().slice(0, 6)}...)`);

  async function buy(mint) {
    const c = cfg.compra;
    const lamports = Math.round(c.solPorCompra * LAMPORTS_PER_SOL);
    const balance = await conn.getBalance(wallet.publicKey);
    if (balance < lamports + 0.01 * LAMPORTS_PER_SOL) throw new Error('Saldo de SOL insuficiente na carteira do robô');

    const qUrl = `${JUP}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${Math.round(c.slippagePct * 100)}`;
    const quote = await (await fetch(qUrl, { headers })).json();
    if (!quote?.outAmount) throw new Error(`Jupiter sem rota: ${JSON.stringify(quote).slice(0, 200)}`);
    const impact = Number(quote.priceImpactPct || 0) * 100;
    if (impact > c.impactoPrecoMaxPct) throw new Error(`Impacto no preço alto demais (${impact.toFixed(1)}%)`);

    const swap = await (await fetch(`${JUP}/swap`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: 'high' } },
      }),
    })).json();
    if (!swap?.swapTransaction) throw new Error(`Jupiter não montou a transação: ${JSON.stringify(swap).slice(0, 200)}`);

    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([wallet]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const conf = await conn.confirmTransaction(
      { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight },
      'confirmed');
    if (conf?.value?.err) throw new Error(`Transação falhou: ${JSON.stringify(conf.value.err)}`);
    return { sig, outAmount: quote.outAmount, impact };
  }

  return {
    async maybeBuy(approved, state, cfg2, log2) {
      const c = cfg2.compra;
      const dayAgo = Date.now() - 86400000;
      const today = (state.trades || []).filter((t) => t.ok && t.at > dayAgo).length;
      const bought = new Set((state.trades || []).filter((t) => t.ok).map((t) => t.mint));
      const out = [];
      const ranked = approved.filter((t) => (t.score || 0) >= c.scoreMinimo && !bought.has(t.mint)).sort((a, b) => b.score - a.score);
      for (const t of ranked) {
        if (today + out.filter((o) => o.ok).length >= c.maxComprasPorDia) { log2('Limite diário de compras atingido'); break; }
        try {
          const r = await buy(t.mint);
          out.push({ at: Date.now(), mint: t.mint, symbol: t.symbol, sol: c.solPorCompra, priceUsd: t.priceUsd, sig: r.sig, ok: true });
          log2(`COMPROU ${t.symbol}: ${c.solPorCompra} SOL (tx ${r.sig.slice(0, 8)}...)`);
        } catch (e) {
          out.push({ at: Date.now(), mint: t.mint, symbol: t.symbol, sol: c.solPorCompra, ok: false, erro: e.message });
          log2(`Compra de ${t.symbol} falhou: ${e.message}`, true);
        }
      }
      return out;
    },
  };
}
