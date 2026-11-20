// Confere os segredos do servidor sem mostrar nenhum deles na tela.
// Rode no servidor (como root), do mesmo jeito que o serviço do robô lê os segredos:
//   cd /opt/faro/repo && sudo -u faro git pull -q; systemd-run --quiet --pipe --wait -p User=faro -p EnvironmentFile=/etc/faro/faro.env -p WorkingDirectory=/opt/faro/repo /usr/bin/node infra/conferir.mjs
import { readFile } from 'node:fs/promises';
import { decrypt } from '../scanner/vault.mjs';

const ok = (m) => console.log('OK    ' + m);
const ruim = (m) => { console.log('ERRO  ' + m); falhas++; };
let falhas = 0;
const env = (k) => (process.env[k] || '').trim();

// 1. Senha do painel: precisa abrir o arquivo que o GitHub gravou. Senha errada faz o histórico recomeçar do zero.
try {
  const file = JSON.parse(await readFile(new URL('../docs/data.enc.json', import.meta.url), 'utf8'));
  const st = decrypt(file, env('FARO_SENHA'));
  ok(`FARO_SENHA abre os dados do painel (${Object.keys(st.tokens || {}).length} moedas no histórico)`);
} catch {
  ruim('FARO_SENHA não abre os dados do painel. Rode bash instalar.sh de novo e digite a mesma senha do painel.');
}

// 2. Carteira: endereço público e chave privada precisam ser da mesma conta
const wallet = env('FARO_WALLET');
if (!wallet) ruim('FARO_WALLET está vazio.');
const pk = env('SOLANA_PRIVATE_KEY');
if (!pk) ruim('SOLANA_PRIVATE_KEY está vazia: o robô não vai conseguir comprar nem vender.');
else {
  try {
    const { Keypair } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    const pub = Keypair.fromSecretKey(bs58.decode(pk)).publicKey.toBase58();
    if (pub === wallet) ok(`SOLANA_PRIVATE_KEY é da carteira ${wallet.slice(0, 6)}...`);
    else ruim(`SOLANA_PRIVATE_KEY é de outra conta (${pub.slice(0, 6)}...), e não da FARO_WALLET (${wallet.slice(0, 6)}...).`);
  } catch {
    ruim('SOLANA_PRIVATE_KEY não está no formato certo (copie de novo em Phantom > Mostrar chave privada).');
  }
}

// 3. Jupiter: pede uma cotação de teste (0,001 SOL para USDC), sem comprar nada
const jup = env('JUPITER_API_KEY');
if (!jup) ruim('JUPITER_API_KEY está vazia: o robô não vai conseguir comprar nem vender.');
else {
  try {
    const u = 'https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWJd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50';
    const r = await fetch(u, { headers: { 'x-api-key': jup }, signal: AbortSignal.timeout(15000) });
    // 401/403 = chave recusada. Qualquer outra resposta quer dizer que a Jupiter aceitou a chave
    // (um 400 aqui é sobre a cotação de teste, não sobre a chave).
    if (r.ok || (r.status !== 401 && r.status !== 403 && r.status < 500)) ok('JUPITER_API_KEY aceita pela Jupiter');
    else {
      // A resposta de erro da Jupiter não tem segredo nenhum e ajuda a saber o motivo
      const txt = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      ruim(`JUPITER_API_KEY recusada pela Jupiter (HTTP ${r.status}${r.status === 401 ? ', chave errada ou incompleta' : ''}). Resposta: ${txt}`);
    }
  } catch {
    ruim('Não consegui falar com a Jupiter agora (internet do servidor?). Tente de novo em 1 min.');
  }
}

// 4. RPC (opcional): se SOLANA_RPC_URL estiver preenchido (ex.: Helius), pede o saldo da carteira, sem mostrar o endereço do RPC
const rpc = env('SOLANA_RPC_URL');
if (!rpc) ok('SOLANA_RPC_URL vazio: usando o RPC público (mais lento)');
else if (!/^https:\/\//.test(rpc)) ruim('SOLANA_RPC_URL precisa começar com https:// (copie a URL inteira do painel da Helius, com o ?api-key=...)');
else {
  try {
    const t0 = Date.now();
    const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [wallet || '11111111111111111111111111111111'] }) });
    const j = await r.json().catch(() => null);
    const host = (() => { try { return new URL(rpc).hostname; } catch { return '?'; } })();
    if (r.ok && j?.result) ok(`SOLANA_RPC_URL responde (${host}, ${Date.now() - t0} ms${wallet ? `, saldo ${(j.result.value / 1e9).toFixed(4)} SOL` : ''})`);
    else ruim(`SOLANA_RPC_URL recusado (${host}, HTTP ${r.status}${r.status === 401 ? ': chave errada ou incompleta' : ''}). Deixe vazio para voltar ao público.`);
  } catch {
    ruim('Não consegui falar com o SOLANA_RPC_URL agora. Confira a URL ou deixe vazio para voltar ao público.');
  }
}

console.log(falhas ? `\n${falhas} problema(s). Corrija antes de virar o robô para o servidor.` : '\nTudo certo. O robô pode comprar e vender com esses segredos.');
process.exit(falhas ? 1 : 0);
