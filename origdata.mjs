// オリジナル展示データ（オリテン）：各場の公式サイトが出している、展示航走の一周・まわり足・直線のタイム
// orig.mjs で、2026年1〜6月で効き方を決めて7〜10月で確かめた（7場・約1.3万レース）：
//   アプリの1着の当たり具合 +3.5‰（一周と直線が効く。まわり足はほとんど効かない）
// 読めることを確かめた7場だけ（桐生は艇の並びが合わず、児島はサイトに届かなかった）。
// 見張り（notify.mjs）が展示のあとに1レース1ページだけ読む（場ごとに1秒に1回まで・1日に多くて約80ページ）。
// 自分の予想に使うだけで、読んだデータは公開のリポジトリには置かない（合言葉のトピックでアプリに送る）。
const ymd = d => d.replace(/-/g, "");
export const ORIG_SITES = {
  5:  {name: "多摩川", url: (d, r) => `https://boatrace-tamagawa.com/modules/yosou/oriten.php?day=${ymd(d)}&race=${r}`, cols: {ex: 6, lap: 7, turn: 8, straight: 9}},
  6:  {name: "浜名湖", url: (d, r) => `https://www.boatrace-hamanako.jp/modules/yosou/group-cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  10: {name: "三国", url: (d, r) => `https://www.boatrace-mikuni.jp/modules/yosou/group-cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  11: {name: "びわこ", url: (d, r) => `https://www.boatrace-biwako.jp/modules/yosou/cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  13: {name: "尼崎", url: (d, r) => `https://boatrace-amagasaki.jp/modules/yosou/group-cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  18: {name: "徳山", url: (d, r) => `https://www.boatrace-tokuyama.jp/modules/yosou/tenji.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 10, lap: 11, turn: 12}},
  22: {name: "福岡", url: (d, r) => `https://www.boatrace-fukuoka.com/modules/yosou/tenji_info.php?day=${ymd(d)}&race=${r}`, cols: {ex: 6, lap: 7, turn: 8, straight: 9}}
};

const textOf = s => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").replace(/\s+/g, "").trim();
// class に colN を持つ td/th の数字を順に（見出しの文字は数字でないので落ちる）。class は ' と " の両方に対応
function colNums(page, k){
  return [...page.matchAll(new RegExp(`<(td|th)\\b[^>]*class\\s*=\\s*(["'])[^"']*\\bcol${k}\\b[^"']*\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "g"))]
    .map(m => parseFloat(textOf(m[3]))).filter(v => v > 0);
}
const last6 = a => a.length >= 6 ? a.slice(-6) : null;

// 1〜6号艇の {ex: 展示タイム, lap: 一周, turn: まわり足, straight: 直線}（ないものは null）
export function parseOrig(page, v){
  if (!page) return null;
  const ex = last6(colNums(page, v.cols.ex));
  if (!ex) return null;
  const get = k => v.cols[k] ? last6(colNums(page, v.cols[k])) : null;
  const lap = get("lap"), turn = get("turn"), straight = get("straight");
  if (!lap && !turn && !straight) return null;
  return [0, 1, 2, 3, 4, 5].map(i => ({ex: ex[i], lap: lap ? lap[i] : null, turn: turn ? turn[i] : null, straight: straight ? straight[i] : null}));
}

// アプリに送る形：{"1": [一周, まわり足, 直線], ...}。公式の展示タイムと合わないとき（まだ前のレースの表など）は null
export function compactOrig(o, boats){
  if (!o) return null;
  const ok = boats.every(b => b.exTime == null || (o[b.no - 1] && Math.abs(o[b.no - 1].ex - b.exTime) < 0.006));
  if (!ok || !boats.some(b => b.exTime != null)) return null;
  const out = {};
  for (const b of boats){ const x = o[b.no - 1]; if (x) out[b.no] = [x.lap, x.turn, x.straight]; }
  return out;
}
