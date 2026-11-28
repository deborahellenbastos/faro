// Servidor do painel no servidor da Hostinger.
// Entrega a pasta docs/ (o painel) e o data.enc.json que o robô grava a cada rodada.
// Escuta só em 127.0.0.1: ninguém de fora chega aqui direto. Quem entrega para a internet é o
// túnel do Cloudflare (cloudflared), com o login do Cloudflare Access na frente.
// Só leitura nos arquivos: entrega só o que está em docs/. A única escrita é a lista de aparelhos que recebem
// avisos no celular (push), pelas rotas /push/..., e a lista de moedas que ela reprovou à mão (/radar/...),
// tudo atrás do mesmo login do Cloudflare.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chaves, guardarAparelho, tirarAparelho, avisar, historico } from '../scanner/push.mjs';
import { reprovar, desfazer, definirSegurar, lerSeguidas, salvarSeguida, removerSeguida, lerFavs, salvarFavs } from '../scanner/manual.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = Number(process.env.FARO_PAINEL_PORTA || 8080);
const HOST = '127.0.0.1';

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// O robô regrava o data.enc.json a cada rodada (e o git troca o arquivo ao alinhar com o GitHub).
// Se pegarmos o arquivo no meio da troca, entregamos a última versão boa em vez de um JSON quebrado.
let ultimoDados = null;
async function dados() {
  try {
    const buf = await readFile(path.join(ROOT, 'data.enc.json'));
    JSON.parse(buf.toString('utf8'));
    ultimoDados = buf;
  } catch { /* usa a última versão boa */ }
  return ultimoDados;
}

const seguranca = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
};

function responder(res, status, corpo, headers = {}) {
  res.writeHead(status, { ...seguranca, ...headers });
  res.end(corpo);
}

const json = (res, status, obj) => responder(res, status, JSON.stringify(obj), { 'Content-Type': TIPOS['.json'], 'Cache-Control': 'no-store' });
function lerCorpo(req, max = 8192) {
  return new Promise((ok, falha) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > max) { falha(new Error('grande demais')); req.destroy(); } else partes.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); } catch { falha(new Error('JSON inválido')); } });
    req.on('error', falha);
  });
}
// Avisos no celular. Só aceita pedidos vindos da própria página (mesma origem), contra outro site tentar usar a sessão.
// Lista inicial das carteiras seguidas: a do config.json (até a primeira mudança pelo painel)
async function seguirPadrao() {
  try { return JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8')).seguir?.carteiras || []; } catch { return []; }
}
async function rotaPush(req, res, rota) {
  if (rota === '/push/chave' && req.method === 'GET') {
    const k = await chaves({ criar: true });
    return json(res, 200, { publicKey: k.publicKey });
  }
  if (rota === '/radar/favs' && req.method === 'GET') return json(res, 200, await lerFavs());
  if (rota === '/radar/seguidas' && req.method === 'GET') return json(res, 200, { carteiras: await lerSeguidas(await seguirPadrao()) });
  if (rota === '/push/historico' && req.method === 'GET') {
    const desde = Number(new URL(req.url, 'http://x').searchParams.get('desde')) || 0;
    return json(res, 200, { itens: (await historico(desde)).slice(-100) });
  }
  if (req.method !== 'POST') return responder(res, 405, 'Método não permitido', { Allow: 'POST' });
  const origem = req.headers.origin || '';
  const permitidas = [process.env.FARO_PAINEL_ORIGEM || 'https://meufaro.tech', `https://${req.headers.host}`];
  if (!origem || !permitidas.includes(origem)) return responder(res, 403, 'Origem não permitida');
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return responder(res, 415, 'Use JSON');
  let corpo;
  try { corpo = await lerCorpo(req); } catch (e) { return responder(res, 400, e.message); }
  try {
    if (rota === '/push/assinar') {
      const n = await guardarAparelho(corpo, req.headers['user-agent'] || '');
      return json(res, 200, { ok: true, aparelhos: n });
    }
    if (rota === '/push/sair') return json(res, 200, { ok: true, aparelhos: await tirarAparelho(String(corpo.endpoint || '')) });
    // 21/11: reprovar uma moeda do Radar à mão (o robô aplica na próxima rodada)
    if (rota === '/radar/reprovar') return json(res, 200, { ok: true, total: await reprovar(String(corpo.mint || ''), corpo.simbolo) });
    // 21/11: alvo do modo Segurar só para uma moeda (0 = regras normais)
    if (rota === '/radar/segurar') { await definirSegurar(String(corpo.mint || ''), Number(corpo.alvo)); return json(res, 200, { ok: true }); }
    // 26/11: carteiras que ela segue (incluir ou renomear, e excluir)
    if (rota === '/radar/seguir') return json(res, 200, { ok: true, carteiras: await salvarSeguida(corpo.endereco, corpo.apelido, await seguirPadrao()) });
    if (rota === '/radar/seguir-remover') return json(res, 200, { ok: true, carteiras: await removerSeguida(corpo.endereco, await seguirPadrao()) });
    // 28/11: favoritas no servidor (mesma lista em todos os aparelhos; o robô lê na próxima rodada)
    if (rota === '/radar/favs') return json(res, 200, { ok: true, ...(await salvarFavs(corpo.mints)) });
    if (rota === '/radar/desfazer') return json(res, 200, { ok: true, total: await desfazer(String(corpo.mint || '')) });
    if (rota === '/push/teste') {
      const n = await avisar({ titulo: 'Faro: avisos ligados', texto: 'Pronto! Agora o robô te avisa mesmo com o app fechado.', chave: `teste-${Date.now()}` });
      return json(res, 200, { ok: n > 0, enviados: n });
    }
  } catch (e) { return responder(res, 400, e.message); }
  return responder(res, 404, 'Não encontrado');
}

const server = createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { return responder(res, 400, 'Endereço inválido'); }
  if (url.pathname.startsWith('/push/') || url.pathname.startsWith('/radar/')) return rotaPush(req, res, url.pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return responder(res, 405, 'Método não permitido', { Allow: 'GET, HEAD' });
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const arquivo = path.resolve(ROOT, '.' + rel);
  if (!arquivo.startsWith(ROOT + path.sep)) return responder(res, 403, 'Proibido');
  const nome = path.basename(arquivo);
  if (nome.startsWith('.')) return responder(res, 404, 'Não encontrado');

  try {
    if (nome === 'data.enc.json') {
      const buf = await dados();
      if (!buf) return responder(res, 503, 'Dados ainda não disponíveis', { 'Retry-After': '10' });
      return responder(res, 200, req.method === 'HEAD' ? undefined : buf, { 'Content-Type': TIPOS['.json'], 'Cache-Control': 'no-store' });
    }
    const st = await stat(arquivo);
    if (!st.isFile()) return responder(res, 404, 'Não encontrado');
    const buf = await readFile(arquivo);
    const tipo = TIPOS[path.extname(arquivo)] || 'application/octet-stream';
    // Painel e service worker sem cache, para as atualizações aparecerem na hora; ícones podem ficar 1 dia
    const cache = /\.(png|svg|ico)$/.test(arquivo) ? 'public, max-age=86400' : 'no-cache';
    return responder(res, 200, req.method === 'HEAD' ? undefined : buf, { 'Content-Type': tipo, 'Cache-Control': cache });
  } catch {
    return responder(res, 404, 'Não encontrado');
  }
});

server.listen(PORT, HOST, () => console.log(`Painel do Faro em http://${HOST}:${PORT} (pasta ${ROOT})`));
