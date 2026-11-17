// Ponto de entrada: o GitHub roda este arquivo a cada 5 minutos.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as api from './api.mjs';
import { runOnce } from './run.mjs';
import { createTrader } from './trader.mjs';
import { encrypt, decrypt } from './vault.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = path.join(root, 'config.json');
const plainPath = path.join(root, 'docs', 'data.json');
const vaultPath = path.join(root, 'docs', 'data.enc.json');

const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
// O endereço da carteira vem dos Secrets do GitHub (FARO_WALLET), para não ficar público no config.json
const walletSecret = (process.env.FARO_WALLET || '').trim();
const password = process.env.FARO_SENHA || '';
// Trava de segurança: sem senha, a carteira não é usada (senão seus dados iriam para um arquivo público)
if (walletSecret && !password) console.error('Carteira configurada, mas falta o secret FARO_SENHA. A carteira será ignorada até a senha existir.');
if (walletSecret && password) cfg.carteira = { ...(cfg.carteira || {}), enderecoPublico: walletSecret };
else cfg.carteira = { enderecoPublico: '' };

// Estado da rodada anterior
let state = {};
let salt;
if (password) {
  try {
    const file = JSON.parse(await readFile(vaultPath, 'utf8'));
    state = decrypt(file, password);
    salt = file.salt;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Não consegui abrir o cofre com a senha atual (senha trocada?). Começando do zero.');
  }
}
if (!state.tokens) { try { state = JSON.parse(await readFile(plainPath, 'utf8')); } catch { /* primeira rodada */ } }

// 17/11: a releitura do histórico (v4) apagou as compras/vendas antigas (o RPC só devolve as ~100 últimas transações).
// Recupera as operações da última versão salva com o formato anterior (v3), guardada no histórico do git, e junta.
if (password && state.wallet?.v === 4 && !state.wallet.v3merged) {
  try {
    const { execSync } = await import('node:child_process');
    const commits = execSync('git log --format=%H -n 80 -- docs/data.enc.json', { cwd: root }).toString().trim().split('\n').filter(Boolean);
    for (const c of commits) {
      let old;
      try { old = decrypt(JSON.parse(execSync(`git show ${c}:docs/data.enc.json`, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString()), password); } catch { continue; }
      if (old?.wallet?.v !== 3 || !Array.isArray(old.wallet.ops) || old.wallet.address !== state.wallet.address) continue;
      const have = new Set(state.wallet.ops.map((o) => o.sig + o.mint));
      const add = old.wallet.ops.filter((o) => !have.has(o.sig + o.mint));
      state.wallet.ops = [...add, ...state.wallet.ops].sort((a, b) => a.at - b.at).slice(-1500);
      state.wallet.v3merged = true;
      console.log(`Carteira: recuperei ${add.length} compras/vendas antigas da versão salva ${c.slice(0, 7)}`);
      break;
    }
  } catch (e) { console.error(`Não consegui recuperar o histórico antigo: ${e.message}`); }
}

const trader = await createTrader(cfg, (m, e) => (e ? console.error : console.log)(m));
state = await runOnce({ api, cfg, state, trader });
// O painel mostra os limites usados; o endereço da carteira não vai junto
state.config = { ...cfg, carteira: { conectada: !!cfg.carteira?.enderecoPublico } };
// Caderno de lições (licoes.json): vai junto para o painel, criptografado como o resto
try { state.licoes = JSON.parse(await readFile(path.join(root, 'licoes.json'), 'utf8')).licoes || []; } catch { state.licoes = state.licoes || []; }

await mkdir(path.dirname(plainPath), { recursive: true });
if (password) {
  // A chave da Jupiter (secret JUPITER_API_KEY) vai junto, só dentro do arquivo criptografado:
  // o painel usa ela nas ordens limite sem você precisar colar em cada aparelho.
  const jup = (process.env.JUPITER_API_KEY || '').trim();
  const out = jup ? { ...state, jupKey: jup } : state;
  await writeFile(vaultPath, JSON.stringify(encrypt(out, password, salt)));
  delete state.jupKey;
  await rm(plainPath, { force: true }); // não deixa versão aberta publicada
  console.log('Dados salvos criptografados (data.enc.json).');
} else {
  if (cfg.carteira?.enderecoPublico) console.error('AVISO: carteira conectada sem FARO_SENHA. Os dados ficam públicos.');
  await writeFile(plainPath, JSON.stringify(state));
}
console.log(`Pronto: ${JSON.stringify(state.lastRun.counts)}`);
