// Servidor do painel no servidor da Hostinger.
// Entrega a pasta docs/ (o painel) e o data.enc.json que o robô grava a cada rodada.
// Escuta só em 127.0.0.1: ninguém de fora chega aqui direto. Quem entrega para a internet é o
// túnel do Cloudflare (cloudflared), com o login do Cloudflare Access na frente.
// Só leitura: aceita GET e HEAD, nunca grava nada e não entrega nada fora de docs/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return responder(res, 405, 'Método não permitido', { Allow: 'GET, HEAD' });
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { return responder(res, 400, 'Endereço inválido'); }
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
