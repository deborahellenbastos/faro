// Reprovação manual (21/11, pedido da Kerah): ela tira uma moeda do Radar pelo painel (meufaro.tech).
// O servidor do painel grava a lista aqui e o robô lê a cada rodada. Fica no servidor (pasta de estado),
// fora do git, como a lista de aparelhos do push.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const DIR = process.env.FARO_PUSH_DIR || '/var/lib/faro';
const ARQ = () => path.join(DIR, 'reprovadas-manual.json');
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function lerReprovadas() {
  try { const j = JSON.parse(await readFile(ARQ(), 'utf8')); return j && typeof j.mints === 'object' ? j.mints : {}; } catch { return {}; }
}
async function gravar(mints) {
  await mkdir(DIR, { recursive: true });
  const tmp = ARQ() + '.tmp';
  await writeFile(tmp, JSON.stringify({ mints }, null, 2));
  await rename(tmp, ARQ());
}
export async function reprovar(mint, simbolo = '') {
  if (!MINT.test(String(mint))) throw new Error('Endereço de moeda inválido');
  const m = await lerReprovadas();
  m[mint] = { at: Date.now(), simbolo: String(simbolo || '').slice(0, 24) };
  const ord = Object.entries(m).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
  await gravar(Object.fromEntries(ord));
  return ord.length;
}
export async function desfazer(mint) {
  const m = await lerReprovadas();
  delete m[String(mint)];
  await gravar(m);
  return Object.keys(m).length;
}

// 21/11: quando o código do servidor do painel muda (git), reinicia ele sozinho. Os dois rodam com o usuário faro;
// o systemd (Restart=always) sobe o painel de novo em 5 s, já com o código novo. Só no servidor, nunca no GitHub.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function atualizarPainel(log = () => {}) {
  if (process.env.GITHUB_ACTIONS) return false;
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const h = createHash('sha1');
  try { for (const f of ['infra/painel.mjs', 'scanner/push.mjs', 'scanner/manual.mjs']) h.update(await readFile(path.join(raiz, f))); } catch { return false; }
  const versao = h.digest('hex'), arq = path.join(DIR, 'painel-versao');
  let antiga = ''; try { antiga = (await readFile(arq, 'utf8')).trim(); } catch { /* primeira vez */ }
  if (antiga === versao) return false;
  try { await mkdir(DIR, { recursive: true }); await writeFile(arq, versao); } catch { return false; }
  await new Promise((ok) => execFile('pkill', ['-f', 'infra/painel.mjs'], () => ok()));
  log('Painel do servidor reiniciado com o código novo');
  return true;
}
