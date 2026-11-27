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

// 21/11 (pedido da Kerah): alvo do modo Segurar escolhido moeda por moeda no painel (qualquer moeda na carteira,
// comprada por ela ou pelo robô). alvoPct 100/150/200/300/500 = segura até lá (999 = Infinito), sem stop; 0 = volta às regras normais.
const ARQ_SEG = () => path.join(DIR, 'segurar-manual.json');
// 27/11: 999 = Infinito (sem alvo; stop móvel a partir de +500%)
export const INFINITO = 999;
export const ALVOS_SEGURAR = [0, 100, 150, 200, 300, 500, INFINITO];
export async function lerSegurar() {
  try { const j = JSON.parse(await readFile(ARQ_SEG(), 'utf8')); return j && typeof j.mints === 'object' ? j.mints : {}; } catch { return {}; }
}
export async function definirSegurar(mint, alvoPct) {
  if (!MINT.test(String(mint))) throw new Error('Endereço de moeda inválido');
  const m = await lerSegurar();
  if (alvoPct == null) delete m[mint];
  else {
    const a = Number(alvoPct);
    if (!ALVOS_SEGURAR.includes(a)) throw new Error('Alvo inválido (use 0, 100, 150, 200, 300, 500 ou 999 = Infinito)');
    m[mint] = { alvoPct: a, at: Date.now() };
  }
  await mkdir(DIR, { recursive: true });
  const tmp = ARQ_SEG() + '.tmp';
  await writeFile(tmp, JSON.stringify({ mints: Object.fromEntries(Object.entries(m).sort((x, y) => y[1].at - x[1].at).slice(0, 200)) }, null, 2));
  await rename(tmp, ARQ_SEG());
}
// Junta a marca da compra (perfil Segurar) com a escolha do painel. Devolve o alvo em vigor ou null (regras normais)
export function segurarDe(t, escolhas) {
  const e = escolhas?.[t.mint];
  if (e && (!t.segurar || e.at >= (t.segurar.desde || 0) - 60000 || e.alvoPct === 0)) return e.alvoPct > 0 ? { ...(t.segurar || {}), alvoPct: e.alvoPct, manual: true } : null;
  return t.segurar || null;
}

// 26/11 (pedido da Kerah): carteiras que ela segue, editadas pelo painel (incluir, dar apelido, excluir).
// Enquanto o arquivo não existe, vale a lista do config.json
const ARQ_SEGUIR = () => path.join(DIR, 'carteiras-seguidas.json');
export async function lerSeguidas(padrao = []) {
  try { const j = JSON.parse(await readFile(ARQ_SEGUIR(), 'utf8')); if (Array.isArray(j.carteiras)) return j.carteiras; } catch { /* sem arquivo */ }
  return (padrao || []).filter((x) => x?.endereco);
}
async function gravarSeguidas(lista) {
  await mkdir(DIR, { recursive: true });
  const tmp = ARQ_SEGUIR() + '.tmp';
  await writeFile(tmp, JSON.stringify({ carteiras: lista }, null, 2));
  await rename(tmp, ARQ_SEGUIR());
}
export async function salvarSeguida(endereco, apelido, padrao = []) {
  endereco = String(endereco || '').trim();
  if (!MINT.test(endereco)) throw new Error('Endereço de carteira inválido');
  const nome = String(apelido || '').trim().slice(0, 30) || `${endereco.slice(0, 4)}...${endereco.slice(-4)}`;
  const lista = await lerSeguidas(padrao);
  const i = lista.findIndex((x) => x.endereco === endereco);
  if (i >= 0) lista[i] = { ...lista[i], apelido: nome };
  else { if (lista.length >= 30) throw new Error('Limite de 30 carteiras'); lista.push({ endereco, apelido: nome, desde: Date.now() }); }
  await gravarSeguidas(lista);
  return lista;
}
export async function removerSeguida(endereco, padrao = []) {
  const lista = (await lerSeguidas(padrao)).filter((x) => x.endereco !== String(endereco || '').trim());
  await gravarSeguidas(lista);
  return lista;
}
