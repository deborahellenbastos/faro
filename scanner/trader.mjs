// Módulo de compra automática via Jupiter. VEM DESLIGADO.
// Compra no sinal de "Boa entrada" e só com as TRÊS travas ligadas:
//   1. config.json -> "compra": { "ativada": true }
//   2. No GitHub: variável AUTO_BUY = true (Settings > Secrets and variables > Actions > Variables)
//   3. O interruptor do painel (memo "faro:compra=on" assinado pela sua carteira na Phantom)
// E dos segredos: SOLANA_PRIVATE_KEY (carteira SÓ do robô), JUPITER_API_KEY, SOLANA_RPC_URL (opcional).
//
// Venda automática (golpe no contrato): também VEM DESLIGADA. Precisa de
//   1. config.json -> "venda": { "automatica": true }
//   2. No GitHub: variável AUTO_SELL = true
// E do segredo SOLANA_PRIVATE_KEY da MESMA carteira do FARO_WALLET (o robô confere antes de vender).

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP = 'https://api.jup.ag/swap/v1';

export async function createTrader(cfg, log) {
  const buyOn = cfg?.compra?.ativada === true && process.env.AUTO_BUY === 'true';
  const sellOn = cfg?.venda?.automatica === true && process.env.AUTO_SELL === 'true';
  // Venda no lucro (posições pequenas): liga/desliga pela variável LUCRO_AUTO do GitHub
  const profitOn = cfg?.venda?.lucro?.ligado === true && process.env.LUCRO_AUTO !== 'false';
  // Vigia rápida (queda forte de preço ou liquidez): liga/desliga pela variável VIGIA do GitHub
  const watchOn = cfg?.venda?.vigia?.ligado === true && process.env.VIGIA !== 'false';
  if (!buyOn && !sellOn && !profitOn && !watchOn) return null;
  const key = process.env.SOLANA_PRIVATE_KEY;
  const jupKey = process.env.JUPITER_API_KEY;
  if (!key || !jupKey) {
    log('Compra/venda automática ligada, mas faltam os segredos SOLANA_PRIVATE_KEY ou JUPITER_API_KEY. Nada foi feito.', true);
    return null;
  }
  // Bibliotecas só são carregadas quando a compra está ligada
  const { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const wallet = Keypair.fromSecretKey(bs58.decode(key.trim()));
  const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const headers = { 'x-api-key': jupKey, 'Content-Type': 'application/json' };
  const me = wallet.publicKey.toBase58();
  // Venda só na carteira vigiada pelo Faro: se a chave for de outra carteira, não vende nada
  const watched = (cfg?.carteira?.enderecoPublico || '').trim();
  const mine = !!watched && watched === me;
  const canSell = sellOn && mine;
  const canTakeProfit = profitOn && mine;
  const canWatch = watchOn && mine;
  if ((sellOn || profitOn || watchOn) && !mine) log('Venda automática NÃO ativada: a chave SOLANA_PRIVATE_KEY não é da carteira vigiada (FARO_WALLET).', true);
  if (canTakeProfit) log(`Venda no lucro LIGADA (posições abaixo de US$ ${cfg.venda.lucro.ateUsd}, vende 100% com +${cfg.venda.lucro.alvoPct}%)`);
  if (buyOn) log(`Compra automática LIGADA (carteira ${me.slice(0, 6)}...)`);
  if (canSell) log(`Venda automática por golpe LIGADA (carteira ${me.slice(0, 6)}...)`);

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

  // Vende TUDO o que a carteira tem dessa moeda, por qualquer preço que a Jupiter conseguir (em golpe, sair é o que importa)
  async function sellAll(mint) {
    let raw = 0n;
    for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
      const r = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new (await import('@solana/web3.js')).PublicKey(programId) });
      for (const a of r.value) { const i = a.account.data.parsed.info; if (i.mint === mint) raw += BigInt(i.tokenAmount.amount); }
    }
    if (raw === 0n) return { sig: null, nada: true };
    const slip = Math.round((cfg?.venda?.slippageMaxPct ?? 30) * 100);
    const quote = await (await fetch(`${JUP}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${raw}&slippageBps=${slip}`, { headers })).json();
    if (!quote?.outAmount) throw new Error(`Jupiter sem rota para vender: ${JSON.stringify(quote).slice(0, 160)}`);
    const swap = await (await fetch(`${JUP}/swap`, {
      method: 'POST', headers,
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: me, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 3_000_000, priorityLevel: 'veryHigh' } } }),
    })).json();
    if (!swap?.swapTransaction) throw new Error(`Jupiter não montou a venda: ${JSON.stringify(swap).slice(0, 160)}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([wallet]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const conf = await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight }, 'confirmed');
    if (conf?.value?.err) throw new Error(`Venda falhou na blockchain: ${JSON.stringify(conf.value.err)}`);
    return { sig, outSol: Number(quote.outAmount) / LAMPORTS_PER_SOL };
  }

  return {
    canBuy: buyOn,
    canSell,
    canTakeProfit,
    canWatch,
    sellAll,
    // Compra no sinal de boa entrada. limits vem de buyLimits(): posições abertas, compras do dia e perda do dia
    async maybeBuy(candidates, state, cfg2, log2, limits) {
      if (!buyOn || !mine) return [];
      const c = cfg2.compra;
      const out = [];
      if (limits.stopped) { log2('Compra automática: perda máxima do dia atingida, sem novas compras hoje'); return out; }
      let room = limits.room;
      for (const t of candidates) {
        if (room <= 0) { log2(`Compra automática: limite atingido (${limits.open} abertas de ${limits.maxOpen}, ${limits.today} compras hoje de ${limits.maxDay})`); break; }
        if (limits.bought.has(t.mint)) continue;
        try {
          const r = await buy(t.mint);
          room--;
          out.push({ at: Date.now(), mint: t.mint, symbol: t.symbol, sol: c.solPorCompra, priceUsd: t.priceUsd, sig: r.sig, ok: true, auto: true, sinal: t.sinal?.msg });
          log2(`COMPROU ${t.symbol} no sinal de boa entrada: ${c.solPorCompra} SOL (tx ${r.sig.slice(0, 8)}...)`);
        } catch (e) {
          out.push({ at: Date.now(), mint: t.mint, symbol: t.symbol, sol: c.solPorCompra, ok: false, auto: true, erro: e.message });
          log2(`Compra de ${t.symbol} falhou: ${e.message}`, true);
        }
      }
      return out;
    },
  };
}
