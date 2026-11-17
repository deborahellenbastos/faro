// Cofre: criptografa os dados do painel com a sua senha (FARO_SENHA, guardada nos Secrets do GitHub).
// AES-256-GCM com chave derivada da senha por PBKDF2-SHA256. O painel descriptografa no navegador
// com a mesma senha (WebCrypto). Sem a senha, o arquivo publicado é ilegível.
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const ITERATIONS = 310000;

export function deriveKey(password, saltB64, iterations = ITERATIONS) {
  return pbkdf2Sync(String(password), Buffer.from(saltB64, 'base64'), iterations, 32, 'sha256');
}

// O sal fica fixo enquanto a senha for a mesma: assim o navegador pode lembrar a chave entre rodadas
export function encrypt(obj, password, saltB64 = randomBytes(16).toString('base64')) {
  const key = deriveKey(password, saltB64);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  // Compacta antes de cifrar (gzip): o arquivo cai para uma fração do tamanho e o painel abre mais rápido no celular
  const body = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 })), c.final()]);
  const tag = c.getAuthTag();
  return {
    faro: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    z: 'gzip',
    salt: saltB64,
    iv: iv.toString('base64'),
    // Formato do WebCrypto: texto cifrado seguido da etiqueta de autenticação
    data: Buffer.concat([body, tag]).toString('base64'),
  };
}

export function decrypt(file, password) {
  const key = deriveKey(password, file.salt, file.iterations || ITERATIONS);
  const all = Buffer.from(file.data, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  d.setAuthTag(all.subarray(all.length - 16));
  const out = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
  return JSON.parse((file.z === 'gzip' ? gunzipSync(out) : out).toString('utf8'));
}
