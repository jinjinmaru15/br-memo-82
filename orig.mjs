// 各場の公式サイトが出している「オリジナル展示データ」（一周・まわり足・直線タイム）が
// 予想に効くかを、2026年の過去レースで確かめる（GitHub Actions で手動で動かす）。
//
// 1. 9場の公式サイトから、各レースの一周（桐生は半周）・まわり足・直線タイムを読む
//    （場ごとに1秒に1回まで。場どうしは同時に読む）
// 2. 同じレースを turnmark（確定オッズ付き）で読み、今のアプリの予想に足したら良くなるかを見る
//    1〜6月で効き方を決めて、7月以降で確かめる（答えを先に見ない）
// 3. 結果の集計だけを orig.json に書く。読んだページは GitHub のキャッシュ（origcache/）にだけ置く
import fs from "node:fs";
import zlib from "node:zlib";

const START = "2026-01-01";
const CACHE = "origcache";
const TM = d => `https://turnmark.github.io/api/v1/${d.slice(0, 4)}/${d.replace(/-/g, "")}.json`;
const FEATS = ["lap", "turn", "straight"];
const NAMES = {lap: "一周", turn: "まわり足", straight: "直線"};
const ymd = d => d.replace(/-/g, "");
// 場ごとのページと、どの欄に何があるか（公開されている読み取りライブラリを参考にした）
const VENUES = {
  1:  {name: "桐生", url: (d, r) => `http://www.kiryu-kyotei.com/modules/yosou/cyokuzen.php?day=${ymd(d)}&race=${r}`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  5:  {name: "多摩川", url: (d, r) => `https://boatrace-tamagawa.com/modules/yosou/oriten.php?day=${ymd(d)}&race=${r}`, cols: {ex: 6, lap: 7, turn: 8, straight: 9}},
  6:  {name: "浜名湖", url: (d, r) => `https://www.boatrace-hamanako.jp/modules/yosou/group-cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  10: {name: "三国", url: (d, r) => `https://www.boatrace-mikuni.jp/modules/yosou/group-cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  11: {name: "びわこ", url: (d, r) => `https://www.boatrace-biwako.jp/modules/yosou/cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  13: {name: "尼崎", url: (d, r) => `https://boatrace-amagasaki.jp/modules/yosou/group-cyokuzen.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 5, lap: 6, turn: 7, straight: 8}},
  16: {name: "児島", url: (d, r) => `https://hj.kojima-yosou.com/hjpc/index/${ymd(d)}/${String(r).padStart(2, "0")}`, kojima: true},
  18: {name: "徳山", url: (d, r) => `https://www.boatrace-tokuyama.jp/modules/yosou/tenji.php?day=${ymd(d)}&race=${r}&kind=2`, cols: {ex: 10, lap: 11, turn: 12}},
  22: {name: "福岡", url: (d, r) => `https://www.boatrace-fukuoka.com/modules/yosou/tenji_info.php?day=${ymd(d)}&race=${r}`, cols: {ex: 6, lap: 7, turn: 8, straight: 9}}
};
const ONLY = process.env.ORIG_VENUES ? process.env.ORIG_VENUES.split(",").map(Number) : null;
// GitHub は2時間で打ち切るので、95分たったら新しいページは読まずに、そこまでの分で集計して保存する
// （読んだページはキャッシュに残るので、もう一度動かすと続きから読む）
const T0 = Date.now(), LIMIT = (+process.env.ORIG_MINUTES || 95) * 60e3;
const overTime = () => Date.now() - T0 > LIMIT;

const html = fs.readFileSync("index.html", "utf8");
const ia = html.indexOf("/* ---------- 定数 ---------- */"), ib = html.indexOf("/* ---------- 状態 ---------- */");
const M = new Function(html.slice(ia, ib) + "\nreturn {parseV1, predict, slitAlerts, prepStats, oddsOf, DEFAULTS};")();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

const textOf = s => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").replace(/\s+/g, "").trim();
// class に colN を持つ td/th の数字を順に（見出しの文字は数字でないので落ちる）。class は ' と " の両方に対応
function colNums(page, k){
  return [...page.matchAll(new RegExp(`<(td|th)\\b[^>]*class\\s*=\\s*(["'])[^"']*\\bcol${k}\\b[^"']*\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "g"))]
    .map(m => parseFloat(textOf(m[3]))).filter(v => v > 0);
}
function classTexts(page, cls){
  return [...page.matchAll(new RegExp(`<([a-z0-9]+)\\b[^>]*class\\s*=\\s*(["'])[^"']*\\b${cls}\\b[^"']*\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "g"))].map(m => textOf(m[3]));
}
const last6 = a => a.length >= 6 ? a.slice(-6) : null;

export function parseOrig(page, v){
  if (v.kojima){
    const ex = classTexts(page, "ren-tenji").map(parseFloat).filter(x => x > 0).slice(0, 6);
    const ctl = classTexts(page, "control");
    if (ex.length < 6 || ctl.length < 30) return null;
    return [0, 1, 2, 3, 4, 5].map(i => ({ex: ex[i], lap: parseFloat(ctl[i * 5 + 2]) || null, turn: parseFloat(ctl[i * 5 + 3]) || null, straight: parseFloat(ctl[i * 5 + 4]) || null}));
  }
  const ex = last6(colNums(page, v.cols.ex));
  if (!ex) return null;
  const get = k => v.cols[k] ? last6(colNums(page, v.cols[k])) : null;
  const lap = get("lap"), turn = get("turn"), straight = get("straight");
  if (!lap && !turn && !straight) return null;
  return [0, 1, 2, 3, 4, 5].map(i => ({ex: ex[i], lap: lap ? lap[i] : null, turn: turn ? turn[i] : null, straight: straight ? straight[i] : null}));
}

const lastFetch = {};
async function getText(host, url){
  const wait = (lastFetch[host] || 0) + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch[host] = Date.now();
  // 応答がないサイトで止まらないように、1回20秒で打ち切る
  for (let a = 0; a < 2; a++){
    try {
      const r = await fetch(url, {headers: {"Accept-Language": "ja"}, signal: AbortSignal.timeout(20000)});
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (e) {}
    if (a === 0) await sleep(3000);
  }
  return null;
}

async function dayRaces(d, keys){
  const f = `${CACHE}/tm2-${d}.json.gz`;
  if (fs.existsSync(f)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
  let out = {};
  try {
    const r = await fetch(TM(d));
    if (r.ok){
      const j = await r.json();
      const st = (j && j.programs && j.programs.stadiums) || {};
      for (const sk of keys){
        if (!st[sk]) continue;
        out[sk] = M.parseV1({programs: {stadiums: {[sk]: st[sk]}}}, d).filter(x => x.hasPreview && x.result && x.result.order.length);
      }
    } else if (r.status !== 404) out = null;
  } catch (e) { out = null; }
  if (out) fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(out)));
  return out || {};
}

async function pageOf(sk, d, rno, c){
  const v = VENUES[sk];
  const f = `${CACHE}/h${sk}-${d}-${rno}.html.gz`;
  // 前の版（三国だけ）のキャッシュも使う
  const old = `${CACHE}/h-${d}-${rno}.html.gz`;
  if (fs.existsSync(f)) return zlib.gunzipSync(fs.readFileSync(f)).toString("utf8");
  if (+sk === 10 && fs.existsSync(old)) return zlib.gunzipSync(fs.readFileSync(old)).toString("utf8");
  if (c.stop){ c.left++; return null; }
  if (overTime()){ c.stop = "時間切れ（もう一度動かすと続きから）"; c.left++; return null; }
  const url = v.url(d, rno);
  const page = await getText(new URL(url).host, url);
  c.fetched++;
  if (page){ fs.writeFileSync(f, zlib.gzipSync(page)); c.fails = 0; }
  else if (++c.fails >= 40) c.stop = c.pages ? "途中から読めなくなった" : "サイトに届かない";
  return page;
}

// 条件付きロジット（各レースで1着になる確率）：u0（今のアプリの予想）＋ β・x
function fit(rows, keys, lam = 1){
  const k = keys.length, beta = new Array(k).fill(0);
  for (let it = 0; it < 30; it++){
    const g = new Array(k).fill(0), H = Array.from({length: k}, () => new Array(k).fill(0));
    for (const r of rows){
      const s = r.u0.map((u, i) => u + keys.reduce((a, key, j) => a + beta[j] * r.x[i][key], 0));
      const mx = Math.max(...s), e = s.map(v => Math.exp(v - mx)), Z = e.reduce((a, b) => a + b, 0), p = e.map(v => v / Z);
      const mean = keys.map(key => r.x.reduce((a, x, i) => a + p[i] * x[key], 0));
      keys.forEach((key, j) => { g[j] += r.x[r.wi][key] - mean[j]; });
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++){
        H[a][b] -= r.x.reduce((acc, x, i) => acc + p[i] * (x[keys[a]] - mean[a]) * (x[keys[b]] - mean[b]), 0);
      }
    }
    for (let j = 0; j < k; j++){ g[j] -= 2 * lam * beta[j]; H[j][j] -= 2 * lam; }
    const A = H.map((row, i) => [...row.map(v => -v), g[i]]);
    for (let i = 0; i < k; i++){
      let piv = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      [A[i], A[piv]] = [A[piv], A[i]];
      for (let r = 0; r < k; r++){ if (r === i) continue; const f = A[r][i] / A[i][i]; for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c]; }
    }
    const step = A.map((row, i) => row[k] / row[i]);
    step.forEach((v, j) => { beta[j] += v; });
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return Object.fromEntries(keys.map((key, j) => [key, +beta[j].toFixed(4)]));
}

function evaluate(rows, beta){
  let ll = 0, hit = 0, bets = 0, ret = 0;
  for (const r of rows){
    const s = r.u0.map((u, i) => u + Object.entries(beta).reduce((a, [key, b]) => a + b * r.x[i][key], 0));
    const mx = Math.max(...s), e = s.map(v => Math.exp(v - mx)), Z = e.reduce((a, b) => a + b, 0), p = e.map(v => v / Z);
    ll += -Math.log(Math.max(p[r.wi], 1e-9));
    if (p.indexOf(Math.max(...p)) === r.wi) hit++;
    p.forEach((q, i) => { const od = r.od[i]; if (od && q >= 0.10 && q * od >= 2.0){ bets++; if (i === r.wi) ret += r.pay; } });
  }
  const n = rows.length;
  return {n, ll: n ? +(ll / n).toFixed(4) : null, hit: n ? +(hit / n).toFixed(4) : null, bets, roi: bets ? +(ret / (100 * bets)).toFixed(4) : null};
}

export async function main(){
  fs.mkdirSync(CACHE, {recursive: true});
  const stats = M.prepStats(JSON.parse(fs.readFileSync("stats-bt.json", "utf8")));
  const s = {...M.DEFAULTS, w: {...M.DEFAULTS.w}};
  const keys = Object.keys(VENUES).filter(k => !ONLY || ONLY.includes(+k));
  // まず全日の turnmark をそろえる
  const days = [];
  for (let d = START; d < today; d = addDays(d, 1)) days.push(d);
  const byDay = new Map();
  for (const d of days) byDay.set(d, await dayRaces(d, keys));
  console.log(`turnmark ${days.length}日 そろった（${((Date.now() - T0) / 60e3).toFixed(1)}分）`);
  // 途中で打ち切っても1〜6月と7月以降の両方が残るように、両端から交互に読む
  const order = [];
  for (let i = 0, j = days.length - 1; i <= j; i++, j--){ order.push(days[i]); if (i !== j) order.push(days[j]); }
  const counts = Object.fromEntries(keys.map(k => [k, {name: VENUES[k].name, races: 0, pages: 0, parsed: 0, matched: 0, fetched: 0, fails: 0, left: 0, stop: null}]));
  const debug = {};
  const rows = [];
  // 場ごとに同時に読む（各場は1秒に1回まで）
  await Promise.all(keys.map(async sk => {
    const v = VENUES[sk], c = counts[sk];
    for (const d of order){
      for (const r of (byDay.get(d)[sk] || [])){
        c.races++;
        const page = await pageOf(sk, d, r.no, c);
        if (!page) continue;
        c.pages++;
        if (c.pages % 200 === 0) console.log(`${v.name} ${c.pages}ページ（新しく読んだ ${c.fetched}・${((Date.now() - T0) / 60e3).toFixed(0)}分）`);
        const o = parseOrig(page, v);
        if (!o){ if (!debug[sk]){ const i = page.indexOf("col"); debug[sk] = page.slice(Math.max(0, i - 800), i + 2200); } continue; }
        c.parsed++;
        const ok = r.boats.every(b => b.exTime == null || (o[b.no - 1] && Math.abs(o[b.no - 1].ex - b.exTime) < 0.006));
        if (!ok){ if (!debug[sk + "x"]) debug[sk + "x"] = JSON.stringify({d, r: r.no, page: o.map(x => x.ex), tm: r.boats.map(b => b.exTime)}); continue; }
        c.matched++;
        const pr = M.predict(r, s, M.slitAlerts(r, s), true, stats);
        const wi = pr.F.findIndex(f => f.b.no === r.result.order[0]);
        if (wi < 0) continue;
        const vals = pr.F.map(f => o[f.b.no - 1]);
        // 速いほどプラス。場ごとに測り方が違う（桐生は半周）ので、そのレースの中でのばらつきで割って比べる
        const x = vals.map(() => ({}));
        for (const k of FEATS){
          const vs = vals.map(q => q[k]).filter(q => q > 0);
          if (vs.length < 6){ x.forEach(o2 => { o2[k] = 0; }); continue; }
          const mean = vs.reduce((a, b) => a + b, 0) / 6, sd = Math.max(Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / 6), 0.02);
          vals.forEach((q, i) => { x[i][k] = Math.max(-3, Math.min(3, (mean - q[k]) / sd)); });
        }
        const pay = (r.result.payouts.win || []).find(y => String(y.combination) === String(r.result.order[0]));
        rows.push({sk, d, wi, u0: pr.F.map(f => Math.log(f.raw)), x, od: pr.F.map(f => M.oddsOf(r.odds, "win", [f.b.no]) || 0), pay: pay ? +pay.amount : 0});
      }
    }
    console.log(v.name, JSON.stringify(c));
  }));
  const train = rows.filter(r => r.d < "2026-07-01"), test = rows.filter(r => r.d >= "2026-07-01");
  const base = {train: evaluate(train, {}), test: evaluate(test, {})};
  const feats = {};
  for (const k of FEATS){ const b = fit(train, [k]); feats[k] = {name: NAMES[k], beta: b[k], test: evaluate(test, b)}; }
  const bAll = fit(train, FEATS);
  const perVenue = Object.fromEntries(keys.map(sk => {
    const te = test.filter(r => r.sk === sk);
    return [sk, {name: VENUES[sk].name, test: te.length, base: evaluate(te, {}), all: evaluate(te, bAll)}];
  }));
  const out = {
    v: 2, built: new Date().toISOString(), from: START, to: addDays(today, -1),
    minutes: +((Date.now() - T0) / 60e3).toFixed(1), partial: Object.values(counts).some(c => c.left > 0),
    counts, used: rows.length, train: train.length, test: test.length,
    base, feats, all: {beta: bAll, test: evaluate(test, bAll), train: evaluate(train, bAll)},
    perVenue, fullBeta: fit(rows, FEATS),
    debug: Object.keys(debug).length ? debug : undefined
  };
  fs.writeFileSync("orig.json", JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("orig.mjs")) await main();
