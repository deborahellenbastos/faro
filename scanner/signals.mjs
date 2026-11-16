// Sinais de entrada e saída, a partir das velas de 5 min.
// A mesma lógica roda no robô (para avisar quando você não está olhando) e no painel (ao vivo).
// Ideia, tirada dos vídeos: não perseguir vela verde no topo; esperar a correção até a zona de
// 50% a 61,8% do último movimento; só entrar quando o fundo segurar e aparecer reação com compra;
// stop abaixo de 78,6% (se passar disso, a alta acabou); alvo no topo anterior; risco/retorno >= 2.

const pctTxt = (v) => `${Math.round(v)}%`;

// c = [[ms, open, high, low, close, volume], ...] do mais antigo para o mais novo
export function swingOf(c) {
  if (!Array.isArray(c) || c.length < 12) return null;
  let iHi = 0; c.forEach((x, i) => { if (x[2] >= c[iHi][2]) iHi = i; });
  let iLo = 0; for (let i = 0; i <= iHi; i++) if (c[i][3] <= c[iLo][3]) iLo = i;
  const hi = c[iHi][2], lo = c[iLo][3];
  if (!(lo > 0) || hi < lo * 1.3) return null;
  return { hi, lo, iHi, iLo, at: c[iHi][0] };
}

const fibPx = (s, r) => s.hi - (s.hi - s.lo) * r;

// ctx: { px (preço agora), buys5, sells5 (transações nos últimos 5 min), safety ('ok'|'info'|'warn'|'danger'), shape, rrMin }
export function entrySignal(c, ctx = {}) {
  const s = swingOf(c);
  if (!s) return { fase: 'sem-movimento', titulo: 'Sem movimento para medir', msg: 'Ainda não houve uma alta de pelo menos 30% para medir a correção.', boa: false };
  const n = c.length;
  const px = ctx.px > 0 ? ctx.px : c[n - 1][4];
  const r = (s.hi - px) / (s.hi - s.lo);
  const z50 = fibPx(s, 0.5), z618 = fibPx(s, 0.618), z786 = fibPx(s, 0.786);
  const after = c.slice(s.iHi + 1);
  const low = Math.min(px, ...after.map((x) => x[3]));
  const stop = Math.min(z786, low) * 0.97;
  const alvo = s.hi;
  const rr = px > stop ? (alvo - px) / (px - stop) : 0;
  const rrMin = ctx.rrMin || 2;
  const base = { zona: [z618, z50], stop, alvo, rr, retr: r, key: `${s.at}` };
  if (ctx.safety === 'danger') return { ...base, fase: 'perigo', titulo: 'Não entrar', msg: 'A moeda está com sinal de perigo.', boa: false };
  if (ctx.shape === 'morta' || ctx.shape === 'reta') return { ...base, fase: 'evitar', titulo: 'Evitar', msg: ctx.shape === 'morta' ? 'Já passou do auge.' : 'Subida reta, sem correção: cara de rug.', boa: false };
  if (r > 0.786) return { ...base, fase: 'quebrou', titulo: 'Perdeu a estrutura', msg: `Devolveu ${pctTxt(r * 100)} da alta (passou de 78,6%). A alta acabou, evite.`, boa: false };
  if (r < 0.236 && s.iHi >= n - 3) return { ...base, fase: 'esticada', titulo: 'Esticada, no topo', msg: 'Comprar agora é perseguir preço. Espere corrigir até a zona de 50% a 61,8%.', boa: false };
  if (r < 0.382) return { ...base, fase: 'esperar', titulo: 'Esperar a correção', msg: `Corrigiu ${pctTxt(r * 100)} da alta. A zona de compra começa ${pctTxt((px / z50 - 1) * 100)} abaixo.`, boa: false };
  if (r < 0.5) return { ...base, fase: 'perto', titulo: 'Chegando na zona', msg: `Corrigiu ${pctTxt(r * 100)} da alta. Falta ${pctTxt((px / z50 - 1) * 100)} para a zona de 50% a 61,8%.`, boa: false };
  // Na zona (50% a 78,6%): precisa o fundo segurar e aparecer reação
  const deep = r > 0.65;
  const last = c[n - 1], prev = c[n - 2];
  // fundo segurou: a vela atual não fez mínima nova
  const held = after.length >= 3 && last[3] >= Math.min(...after.slice(0, -1).map((x) => x[3])) * 0.995;
  const green = px > last[1] && px > prev[4];
  const vols = after.slice(-7, -1).map((x) => x[5]).filter((v) => v > 0);
  const avgVol = vols.length ? vols.reduce((a, v) => a + v, 0) / vols.length : 0;
  const volOk = !avgVol || last[5] >= avgVol * 0.8 || prev[5] >= avgVol;
  const buyOk = ctx.buys5 == null || (ctx.buys5 + ctx.sells5 === 0) || ctx.buys5 >= ctx.sells5;
  const confirmed = held && green && (volOk || buyOk) && buyOk;
  const where = deep ? 'na parte funda da zona (61,8% a 78,6%)' : 'na zona de 50% a 61,8%';
  if (confirmed && rr >= rrMin && ctx.safety !== 'warn') {
    return { ...base, fase: 'entrada', titulo: 'Boa entrada', msg: `Segurou ${where} e reagiu com compra. Stop abaixo do fundo, alvo no topo anterior.`, boa: true };
  }
  if (confirmed) return { ...base, fase: 'zona', titulo: 'Na zona, com reação', msg: ctx.safety === 'warn' ? 'Reagiu na zona, mas há um alerta de atenção na moeda.' : `Reagiu ${where}, mas o alvo paga menos de ${rrMin}x o risco.`, boa: false };
  return { ...base, fase: 'zona', titulo: 'Na zona de compra', msg: !held ? `Está ${where}, mas ainda fazendo fundos mais baixos. Espere segurar.` : `Está ${where}. Espere uma vela verde fechar acima da anterior, com compra.`, boa: false };
}

// pos: { entryPx, entryAt (ms) }; ctx: { px, buys5, sells5, safety }
export function exitSignal(c, pos, ctx = {}) {
  if (!Array.isArray(c) || c.length < 6 || !(pos?.entryPx > 0)) return null;
  const n = c.length;
  const px = ctx.px > 0 ? ctx.px : c[n - 1][4];
  const before = c.filter((x) => x[0] < pos.entryAt);
  const since = c.filter((x) => x[0] >= pos.entryAt - 5 * 60000);
  const sw = swingOf(before);
  const preLow = before.length ? Math.min(...before.slice(-6).map((x) => x[3])) : pos.entryPx * 0.8;
  let stop = sw ? Math.min(fibPx(sw, 0.786), preLow) * 0.97 : Math.min(preLow * 0.97, pos.entryPx * 0.8);
  stop = Math.max(stop, pos.entryPx * 0.65);
  const alvo = sw && sw.hi > pos.entryPx * 1.1 ? sw.hi : pos.entryPx * 2;
  const peak = Math.max(px, ...since.map((x) => x[2]));
  const gain = (px / pos.entryPx - 1) * 100, peakGain = (peak / pos.entryPx - 1) * 100;
  const base = { stop, alvo, gain, peakGain, key: `${pos.entryAt}` };
  if (ctx.safety === 'danger') return { ...base, fase: 'sair', titulo: 'Sair', msg: 'Apareceu sinal de perigo na moeda.', ruim: true };
  if (px < stop) return { ...base, fase: 'sair', titulo: 'Perdeu o fundo', msg: 'O preço passou do stop do plano (abaixo do fundo da correção). Pelo plano, é hora de sair.', ruim: true };
  if (px >= alvo * 0.97) return { ...base, fase: 'realizar', titulo: 'Chegou no alvo', msg: 'Bateu no topo anterior. Bom ponto para vender tudo ou parte e garantir o lucro.', bom: true };
  if (peakGain >= 30 && gain <= peakGain * 0.5) return { ...base, fase: 'proteger', titulo: 'Devolvendo o lucro', msg: `Chegou a +${pctTxt(peakGain)} e devolveu metade ou mais. Proteja o que sobrou.`, ruim: true };
  const last3 = c.slice(-3);
  const wicks = last3.filter((x) => (x[2] - Math.max(x[1], x[4])) > Math.abs(x[4] - x[1]) * 1.5).length;
  const sells = ctx.buys5 != null && ctx.sells5 > ctx.buys5 * 1.5;
  if (gain >= 40 && wicks >= 2 && sells) return { ...base, fase: 'exaustao', titulo: 'Sinais de exaustão', msg: 'Velas com pavio longo em cima e mais venda que compra. Considere realizar parte.', ruim: true };
  return { ...base, fase: 'segurar', titulo: 'Dentro do plano', msg: 'Nada a fazer: o preço está entre o stop e o alvo.' };
}
