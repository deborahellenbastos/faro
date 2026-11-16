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

// Stop móvel: depois de subir ativarPct desde a compra, o stop sobe junto e nunca desce.
// Fica no último fundo da subida (ou a distanciaPct abaixo do topo, o que for mais alto),
// nunca colado demais no topo (memecoin oscila) e garantindo pelo menos minimoTravadoPct de lucro.
// pos: { entryPx, entryAt, peak? }; prev = stop da rodada anterior (só sobe)
export function trailStop(c, pos, o = {}, prev = 0) {
  if (!(pos?.entryPx > 0)) return null;
  const ativar = o.ativarPct ?? 30, dist = o.distanciaPct ?? 25, minLock = o.minimoTravadoPct ?? 5;
  const since = (c || []).filter((x) => x[0] >= pos.entryAt - 300000);
  const peak = Math.max(pos.entryPx, pos.peak || 0, ...since.map((x) => x[2]));
  const peakGain = (peak / pos.entryPx - 1) * 100;
  if (peakGain < ativar && !(prev > 0)) return { ativo: false, peak, ativarPx: pos.entryPx * (1 + ativar / 100), falta: ativar - peakGain };
  // Começo da alta (até seguirAPartirPct): o stop fica logo acima da entrada, só sai se devolver quase tudo.
  // Memecoin corrige 20-30% no meio da subida; seguir o topo cedo demais vende na correção normal.
  const seguir = o.seguirAPartirPct ?? 60;
  const floor = pos.entryPx * (1 + minLock / 100);
  let stop = floor;
  if (peakGain >= seguir) {
    let pivot = 0;
    for (let i = 2; i < since.length - 2; i++) {
      const l = since[i][3];
      if (l < since[i - 1][3] && l < since[i - 2][3] && l < since[i + 1][3] && l < since[i + 2][3]) pivot = l;
    }
    stop = Math.min(Math.max(pivot * 0.97, peak * (1 - dist / 100)), peak * 0.88);
  }
  stop = Math.max(stop, floor, prev || 0);
  return { ativo: true, stop, peak, travadoPct: (stop / pos.entryPx - 1) * 100 };
}

// Como está a alta de uma moeda que você tem: fundos subindo, compra x venda, distância do topo
export function trendHealth(c, pos, ctx = {}) {
  const since = (c || []).filter((x) => x[0] >= pos.entryAt - 300000);
  const px = ctx.px > 0 ? ctx.px : since.length ? since[since.length - 1][4] : 0;
  const lows = [];
  for (let i = 2; i < since.length - 2; i++) {
    const l = since[i][3];
    if (l < since[i - 1][3] && l < since[i - 2][3] && l < since[i + 1][3] && l < since[i + 2][3]) lows.push(l);
  }
  const last3 = lows.slice(-3);
  const rising = last3.length >= 2 && last3.every((l, i) => i === 0 || l > last3[i - 1]);
  const peak = Math.max(px, ...since.map((x) => x[2]));
  const fromTop = peak > 0 ? (1 - px / peak) * 100 : 0;
  const ratio = (b, s) => (b + s > 0 ? (b / (b + s)) * 100 : null);
  return { lows: last3, rising, fromTop, buy5: ratio(ctx.buys5 || 0, ctx.sells5 || 0), buy1h: ratio(ctx.buys1h || 0, ctx.sells1h || 0) };
}

// pos: { entryPx, entryAt (ms) }; ctx: { px, buys5, sells5, safety, trail }
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
  if (ctx.trail?.ativo) { base.stop = ctx.trail.stop; base.trail = ctx.trail; }
  if (ctx.trail?.ativo && px < ctx.trail.stop) return { ...base, fase: 'sair', titulo: 'Bateu o stop móvel', msg: `Caiu abaixo do stop móvel. Vendendo aí você garante +${Math.round(ctx.trail.travadoPct)}%.`, ruim: true };
  if (px < stop) return { ...base, fase: 'sair', titulo: 'Perdeu o fundo', msg: 'O preço passou do stop do plano (abaixo do fundo da correção). Pelo plano, é hora de sair.', ruim: true };
  if (px >= alvo * 0.97) return { ...base, fase: 'realizar', titulo: 'Chegou no alvo', msg: 'Bateu no topo anterior. Bom ponto para vender tudo ou parte e garantir o lucro.', bom: true };
  if (peakGain >= 30 && gain <= peakGain * 0.5) return { ...base, fase: 'proteger', titulo: 'Devolvendo o lucro', msg: `Chegou a +${pctTxt(peakGain)} e devolveu metade ou mais. Proteja o que sobrou.`, ruim: true };
  const last3 = c.slice(-3);
  const wicks = last3.filter((x) => (x[2] - Math.max(x[1], x[4])) > Math.abs(x[4] - x[1]) * 1.5).length;
  const sells = ctx.buys5 != null && ctx.sells5 > ctx.buys5 * 1.5;
  if (gain >= 40 && wicks >= 2 && sells) return { ...base, fase: 'exaustao', titulo: 'Sinais de exaustão', msg: 'Velas com pavio longo em cima e mais venda que compra. Considere realizar parte.', ruim: true };
  return { ...base, fase: 'segurar', titulo: 'Dentro do plano', msg: ctx.trail?.ativo ? `Nada a fazer. O stop móvel já garante +${Math.round(ctx.trail.travadoPct)}% e sobe junto se ela subir.` : 'Nada a fazer: o preço está entre o stop e o alvo.' };
}

// Sinais de que a alta está perdendo força (usados para realizar o lucro antes do +100%)
// m: { candles, entryAt, buys5, sells5, vol5, volH1, fromPeak }
export function weakSignals(m) {
  const out = [];
  const b = m.buys5 || 0, s = m.sells5 || 0;
  if (b + s >= 10 && s / (b + s) >= 0.55) out.push({ id: 'vendas', forte: true, msg: `vendas dominando (${Math.round((s / (b + s)) * 100)}% nos últimos 5 min)` });
  if (m.volH1 > 0 && m.vol5 != null && m.vol5 < (m.volH1 / 12) * 0.4) out.push({ id: 'volume', forte: true, msg: 'volume secando (5 min bem abaixo da média da hora)' });
  const h = trendHealth(m.candles || [], { entryAt: m.entryAt || 0 }, {});
  if (h.lows.length >= 2 && !h.rising) out.push({ id: 'fundo', forte: true, msg: 'fez um fundo mais baixo' });
  if (m.fromPeak >= 10) out.push({ id: 'recuo', forte: m.fromPeak >= 15, msg: `recuou ${Math.round(m.fromPeak)}% do topo` });
  return out;
}
// Realização em faixas: com +50% vende se 2 sinais de fraqueza; com +80%, basta 1 sinal forte; senão segura até o +100%
export function realizeCheck(gain, weak, o = {}) {
  const faixas = [...(o.faixas || [{ lucroPct: 50, sinais: 2 }, { lucroPct: 80, sinais: 1 }])].sort((a, b) => b.lucroPct - a.lucroPct);
  const f = faixas.find((x) => gain >= x.lucroPct);
  if (!f) return { sell: false, faixa: null };
  const count = f.sinais <= 1 ? weak.filter((w) => w.forte).length : weak.length;
  return { sell: count >= f.sinais, faixa: f, count };
}
