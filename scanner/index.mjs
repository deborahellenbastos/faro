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

const trader = await createTrader(cfg, (m, e) => (e ? console.error : console.log)(m));
state = await runOnce({ api, cfg, state, trader });
// O painel mostra os limites usados; o endereço da carteira não vai junto
state.config = { ...cfg, carteira: { conectada: !!cfg.carteira?.enderecoPublico } };

await mkdir(path.dirname(plainPath), { recursive: true });
if (password) {
  await writeFile(vaultPath, JSON.stringify(encrypt(state, password, salt)));
  await rm(plainPath, { force: true }); // não deixa versão aberta publicada
  console.log('Dados salvos criptografados (data.enc.json).');
} else {
  if (cfg.carteira?.enderecoPublico) console.error('AVISO: carteira conectada sem FARO_SENHA. Os dados ficam públicos.');
  await writeFile(plainPath, JSON.stringify(state));
}
console.log(`Pronto: ${JSON.stringify(state.lastRun.counts)}`);
