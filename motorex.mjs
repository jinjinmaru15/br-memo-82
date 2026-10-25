// モーターの「展示の速さ」
// データ攻め（https://funanote-k7q2xm.pages.dev/・運営 あべけんさん）のモーターカルテ
// （公式の直前情報の展示タイムをモーターごとに並べたもの）から作る。運営の方の許可を得て使っている。
//
// 展示タイムが同じレースのほかの艇の平均より何秒速かったかを、モーターごとに直近60走で平均し、
// 走った数が少ないうちは0に寄せて（合計÷(走数＋5)）、10倍したもの。プラスほど速いモーター。
// モーターを新しくした場（新替）は、その日より前の記録を使わない。
// 7/15〜9/10で決めて9/11〜10/16で確かめた（逆向きでも確認）：
//   アプリの1着の当たり具合 +3.2‰、オッズに足しても +2.4‰（オッズも織り込みきれていない）
export const MEX = {W: 60, K: 5};

// karte：motorKarte.json、renew：{"02": "20260806", ...}（場ごとの新替日）
export function motorIndex(karte, renew = {}){
  const recs = (karte && karte.records) || {};
  const raceEx = new Map();
  for (const [key, list] of Object.entries(recs)){
    const v = key.split("_")[0];
    for (const r of list || []){
      const ex = +r[7];
      if (!(ex > 6 && ex < 7.6)) continue;
      const k = v + "|" + r[0] + "|" + r[1];
      if (!raceEx.has(k)) raceEx.set(k, []);
      raceEx.get(k).push(ex);
    }
  }
  const hist = new Map();
  let last = "";
  for (const [key, list] of Object.entries(recs)){
    const v = key.split("_")[0], out = [];
    for (const r of list || []){
      const ex = +r[7], g = raceEx.get(v + "|" + r[0] + "|" + r[1]);
      if (!(ex > 6 && ex < 7.6) || !g || g.length < 5) continue;
      out.push([String(r[0]), +r[1] || 0, ex - g.reduce((a, b) => a + b, 0) / g.length]);
      if (String(r[0]) > last) last = String(r[0]);
    }
    out.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
    hist.set(key, out);
  }
  return {hist, renew: renew || {}, last};
}

// date（"YYYYMMDD"）より前の記録だけで、その日のモーターの展示の速さを出す
export function motorEx(idx, stadium, motor, date){
  if (!idx || motor == null) return {mx: 0, n: 0};
  const v = String(stadium).padStart(2, "0");
  const h = idx.hist.get(v + "_" + motor);
  if (!h || !h.length) return {mx: 0, n: 0};
  const rn = idx.renew[v];
  const lo = rn && rn <= date ? rn : "";
  let end = h.length;
  while (end > 0 && h[end - 1][0] >= date) end--;
  let st = end;
  while (st > 0 && end - st < MEX.W && h[st - 1][0] >= lo) st--;
  const n = end - st;
  if (!n) return {mx: 0, n: 0};
  let s = 0;
  for (let i = st; i < end; i++) s += h[i][2];
  return {mx: -s / (n + MEX.K) * 10, n};
}

// 場ごとの新替日：motorReplace.json（記録された新替日）と motorUsage.json（推定した新替日）の新しいほう
export function renewMap(replace, usage){
  const out = {};
  for (const [v, x] of Object.entries((usage && usage.venues) || {})) if (x && x.coverageFrom) out[v] = String(x.coverageFrom);
  for (const [v, x] of Object.entries(replace || {})){
    const d = x && x["新替日"] ? String(x["新替日"]) : "";
    if (d && (!out[v] || d > out[v])) out[v] = d;
  }
  return out;
}

// アプリ用：today（"YYYY-MM-DD"）から使える全モーターの値 {"01_17": [速さ, 走数], ...}
export function motorSnapshot(idx, today){
  const date = today.replace(/-/g, "");
  const m = {};
  for (const key of idx.hist.keys()){
    const i = key.indexOf("_");
    const x = motorEx(idx, key.slice(0, i), key.slice(i + 1), date);
    if (x.n) m[key] = [+x.mx.toFixed(3), x.n];
  }
  return m;
}
