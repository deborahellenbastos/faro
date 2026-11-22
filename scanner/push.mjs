// Avisos no celular com o app fechado (Web Push), enviados pelo robô no servidor.
// Só funciona no servidor próprio (meufaro.tech): lá ficam as chaves de envio (VAPID) e a lista de aparelhos
// que pediram para receber (o painel grava ao ligar "Notificações"). No GitHub Actions não há nada disso, e
// avisar() simplesmente não faz nada. Nunca trava nem derruba a rodada: qualquer erro vira silêncio.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createECDH } from 'node:crypto';
import path from 'node:path';

const DIR = process.env.FARO_PUSH_DIR || '/var/lib/faro';
const ARQ_CHAVES = path.join(DIR, 'push-chaves.json');
const ARQ_APARELHOS = path.join(DIR, 'push-aparelhos.json');
const ARQ_ENVIADOS = path.join(DIR, 'push-enviados.json');
const REPETIR_HORAS = 12; // o mesmo aviso (mesma chave) não sai de novo antes disso

const lerJson = async (arq, padrao) => { try { return JSON.parse(await readFile(arq, 'utf8')); } catch { return padrao; } };
async function gravarJson(arq, obj) {
  await mkdir(path.dirname(arq), { recursive: true });
  const tmp = `${arq}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
  await rename(tmp, arq);
}
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Par de chaves VAPID (P-256). Criado uma vez no servidor; a pública vai para o navegador, a privada nunca sai daqui.
export async function chaves({ criar = false } = {}) {
  const k = await lerJson(ARQ_CHAVES, null);
  if (k?.publicKey && k?.privateKey) return k;
  if (!criar) return null;
  const ec = createECDH('prime256v1'); ec.generateKeys();
  const nova = { publicKey: b64u(ec.getPublicKey()), privateKey: b64u(Buffer.concat([Buffer.alloc(32), ec.getPrivateKey()]).subarray(-32)), subject: 'https://meufaro.tech', criadaEm: Date.now() };
  await gravarJson(ARQ_CHAVES, nova);
  return nova;
}

export async function aparelhos() { return lerJson(ARQ_APARELHOS, []); }

export async function guardarAparelho(sub, ua = '') {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('assinatura inválida');
  const lista = (await aparelhos()).filter((a) => a.endpoint !== sub.endpoint);
  lista.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, ua: String(ua).slice(0, 160), at: Date.now() });
  await gravarJson(ARQ_APARELHOS, lista.slice(-10)); // no máximo 10 aparelhos
  return lista.length;
}

export async function tirarAparelho(endpoint) {
  const lista = (await aparelhos()).filter((a) => a.endpoint !== endpoint);
  await gravarJson(ARQ_APARELHOS, lista);
  return lista.length;
}

let webpush = null;
async function biblioteca() {
  if (webpush !== null) return webpush;
  try { webpush = (await import('web-push')).default; } catch { webpush = false; }
  return webpush;
}

// avisar({ titulo, texto, mint, chave, urgente })
//   chave: identifica o aviso para não repetir (ex.: "venda-<assinatura da transação>").
// 21/11 (pedido da Kerah): tudo que vai para o celular também fica num histórico, que o painel puxa para dentro das
// notificações dele (antes, avisos que só o servidor manda, como reentrada e perigo, não apareciam no sino do painel)
const ARQ_HIST = path.join(DIR, 'push-historico.json');
export async function historico(desde = 0) {
  const h = await lerJson(ARQ_HIST, []);
  return (Array.isArray(h) ? h : []).filter((x) => x.at > desde);
}
export async function avisar({ titulo, texto = '', mint = '', chave = '', urgente = false } = {}) {
  try {
    if (process.env.FARO_PUSH === 'off' || !titulo) return 0;
    const agora = Date.now();
    const enviados = await lerJson(ARQ_ENVIADOS, {});
    for (const [c, at] of Object.entries(enviados)) if (agora - at > REPETIR_HORAS * 3600000) delete enviados[c];
    if (chave && enviados[chave]) return 0;
    if (chave) { enviados[chave] = agora; await gravarJson(ARQ_ENVIADOS, enviados); }
    try {
      const h = await lerJson(ARQ_HIST, []);
      const novo = { at: agora, titulo: String(titulo).slice(0, 80), texto: String(texto).slice(0, 240), mint, chave: chave || `${agora}`, urgente: !!urgente };
      await gravarJson(ARQ_HIST, [...(Array.isArray(h) ? h : []), novo].slice(-200));
    } catch { /* o histórico não pode atrapalhar o aviso */ }
    const lista = await aparelhos();
    if (!lista.length) return 0;
    const k = await chaves();
    const wp = k && (await biblioteca());
    if (!wp) return 0;
    const corpo = JSON.stringify({ title: String(titulo).slice(0, 80), body: String(texto).slice(0, 240), tag: chave ? chave.slice(0, 60) : undefined, mint });
    const opcoes = { vapidDetails: { subject: k.subject || 'https://meufaro.tech', publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 3600, urgency: urgente ? 'high' : 'normal', timeout: 10000 };
    let ok = 0; const mortos = [];
    await Promise.all(lista.map(async (a) => {
      try { await wp.sendNotification({ endpoint: a.endpoint, keys: a.keys }, corpo, opcoes); ok++; }
      catch (e) { if (e?.statusCode === 404 || e?.statusCode === 410) mortos.push(a.endpoint); }
    }));
    if (mortos.length) await gravarJson(ARQ_APARELHOS, lista.filter((a) => !mortos.includes(a.endpoint)));
    return ok;
  } catch { return 0; }
}
