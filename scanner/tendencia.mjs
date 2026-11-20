// Tendência de baixa (20/11, regra em teste, pedido da Kerah): "as velas estão fechando cada vez mais baixo e quebrando
// zonas de suporte". Só MARCA as entradas da simulação para medir o que a trava teria evitado. Não bloqueia nada ainda.
// Velas: [início, abre, máx, mín, fecha, volume] (5 min).
//
// Marca quando, nas últimas velas:
//  - escada de queda: 4 dos 5 últimos fechamentos abaixo do anterior, ou 3 dos 5 passos com topo E fundo mais baixos; ou
//  - suporte rompido: um nível tocado 2+ vezes antes (fundos a até 2% um do outro) e o preço fechou 2%+ abaixo dele
//    nas últimas 3 velas, depois de estar acima.
// Libera (não marca) quando a queda parou: a última vela fechou acima das máximas das 2 anteriores e não fez fundo novo.
export function downtrend(c, o = {}) {
  const n = (c || []).length;
  if (n < 8) return null;
  const last = c[n - 1];
  // a queda parou: fechou acima do último topo e o fundo segurou
  const lastLows = c.slice(-4, -1).map((x) => x[3]);
  if (last[4] > Math.max(c[n - 2][2], c[n - 3][2]) && last[3] >= Math.min(...lastLows)) return null;
  const w = c.slice(-(o.velas ?? 6));
  let downCloses = 0, lowerHL = 0;
  for (let i = 1; i < w.length; i++) {
    if (w[i][4] < w[i - 1][4]) downCloses++;
    if (w[i][2] < w[i - 1][2] && w[i][3] < w[i - 1][3]) lowerHL++;
  }
  const passos = w.length - 1;
  const escada = downCloses >= passos - 1 || lowerHL >= Math.ceil(passos * 0.6);
  // suportes: fundos das velas antes das 6 últimas que se repetem (2+ toques a até 2%, com 3+ velas de distância)
  const prev = c.slice(Math.max(0, n - 40), n - 6);
  let suporte = null;
  for (let i = 0; i < prev.length && !suporte; i++) {
    const lv = prev[i][3];
    const toques = prev.filter((x, j) => Math.abs(j - i) >= 3 && Math.abs(x[3] / lv - 1) <= 0.02).length;
    if (toques < 1) continue;
    const recent = c.slice(-3);
    const before = c[n - 4];
    if (before && before[4] > lv && recent.some((x) => x[4] < lv * 0.98) && last[4] < lv) suporte = lv;
  }
  if (!escada && !suporte) return null;
  const partes = [];
  if (escada) partes.push(`${downCloses} de ${passos} velas fechando mais baixo`);
  if (suporte) partes.push(`rompeu o suporte de US$ ${suporte.toPrecision(4)}`);
  return { escada, suporte, msg: `Tendência de baixa: ${partes.join(' e ')}` };
}
