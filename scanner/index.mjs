// Ponto de entrada: o GitHub roda este arquivo a cada 5 minutos.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as api from './api.mjs';
import { runOnce } from './run.mjs';
import { createTrader } from './trader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = path.join(root, 'config.json');
const dataPath = path.join(root, 'docs', 'data.json');

const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
let state = {};
try { state = JSON.parse(await readFile(dataPath, 'utf8')); } catch { /* primeira rodada */ }

const trader = await createTrader(cfg, (m, e) => (e ? console.error : console.log)(m));
state = await runOnce({ api, cfg, state, trader });
state.config = cfg; // o painel mostra os limites usados

await mkdir(path.dirname(dataPath), { recursive: true });
await writeFile(dataPath, JSON.stringify(state));
console.log(`Pronto: ${JSON.stringify(state.lastRun.counts)}`);
