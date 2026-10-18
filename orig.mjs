// 三国のオリジナル展示データ（一周・まわり足・直線タイム）が予想に効くかを、
// 2026年の過去レースで確かめる（GitHub Actions で手動で1回動かす）。
//
// 1. 三国の公式サイトの直前情報ページから、各レースの一周・まわり足・直線タイムを読む（1秒に1回まで）
// 2. 同じレースを turnmark（確定オッズ付き）で読み、今のアプリの予想に足したら良くなるかを見る
//    1〜6月で効き方を決めて、7月以降で確かめる（答えを先に見ない）
// 3. 結果の集計だけを orig.json に書く。読んだタイムは GitHub のキャッシュ（origcache/）にだけ置く
import fs from "node:fs";
import zlib from "node:zlib";

const STADIUM = 10;   // 三国
const START = "2026-01-01";
const CACHE = "origcache";
const URL = (d, r) => `https://www.boatrace-mikuni.jp/modules/yosou/group-cyokuzen.php?day=${d.replace(/-/g, "")}&race=${r}&kind=2`;
const TM = d => `https://turnmark.github.io/api/v1/${d.slice(0, 4)}/${d.replace(/-/g, "")}.json`;
const FEATS = ["lap", "turn", "straight"];
const NAMES = {lap: "一周", turn: "まわり足", straight: "直線"};

const html = fs.readFileSync("index.html", "utf8");
const ia = html.indexOf("/* ---------- 定数 ---------- */"), ib = html.indexOf("/* ---------- 状態 ---------- */");
const M = new Function(html.slice(ia, ib) + "\nreturn {parseV1, predict, slitAlerts, prepStats, oddsOf, DEFAULTS};")();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 三国のページから、class に col5〜col8 を持つ欄の数字を順に取り出す（col5=展示 col6=一周 col7=まわり足 col8=直線）
export function parseOrig(page){
  // class は ' と " の両方で書かれている（例：<td rowspan='2' class='col5 '>6.81</td>、<td class="col6 rank_1" rowspan="2">36.68</td>）
  const col = k => [...page.matchAll(new RegExp(`<(td|th)\\b[^>]*class\\s*=\\s*(["'])[^"']*\\bcol${k}\\b[^"']*\\2[^>]*>([\\s\\S]*?)<\\/\\1>`, "g"))]
    .map(m => m[3].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim())
    .map(t => parseFloat(t)).filter(v => v > 0);
  const ex = col(5), lap = col(6), turn = col(7), straight = col(8);
  if (ex.length < 6 || lap.length < 6 || turn.length < 6 || straight.length < 6) return null;
  return [0, 1, 2, 3, 4, 5].map(i => ({ex: ex[i], lap: lap[i], turn: turn[i], straight: straight[i]}));
}

let lastFetch = 0;
async function getText(url){
  const wait = lastFetch + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetch = Date.now();
  for (let a = 0; a < 3; a++){
    try {
      const r = await fetch(url, {headers: {"Accept-Language": "ja"}});
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (e) {}
    await sleep(3000 * (a + 1));
  }
  return null;
}

async function dayRaces(d){
  const f = `${CACHE}/tm-${d}.json.gz`;
  if (fs.existsSync(f)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
  let out = [];
  try {
    const r = await fetch(TM(d));
    if (r.ok){
      const j = await r.json();
      const S = j && j.programs && j.programs.stadiums && j.programs.stadiums[STADIUM];
      out = S ? M.parseV1({programs: {stadiums: {[STADIUM]: S}}}, d).filter(x => x.hasPreview && x.result && x.result.order.length) : [];
    }
  } catch (e) { out = null; }
  if (out) fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(out)));
  return out || [];
}

// ページはそのまま（圧縮して）キャッシュに置き、読み方を直しても取り直さずに済むようにする
async function origOf(d, rno, debug){
  const f = `${CACHE}/h-${d}-${rno}.html.gz`;
  let page = fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString("utf8") : null;
  if (page == null){
    page = await getText(URL(d, rno));
    if (page) fs.writeFileSync(f, zlib.gzipSync(page));
  }
  const v = page ? parseOrig(page) : null;
  if (!v && page && !debug.html) debug.html = page.slice(Math.max(0, page.indexOf("col6") - 1500), page.indexOf("col6") + 1500).slice(0, 3000);
  return v;
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
    // H δ = -g を解く（ガウスの消去法）
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
  const rows = [], debug = {};
  let races = 0, parsed = 0, matched = 0;
  for (let d = START; d < today; d = addDays(d, 1)){
    const list = await dayRaces(d);
    for (const r of list){
      races++;
      const o = await origOf(d, r.no, debug);
      if (!o) continue;
      parsed++;
      // 展示タイムが turnmark と一致するか（読み違いを防ぐ）
      const ok = r.boats.every(b => b.exTime == null || (o[b.no - 1] && Math.abs(o[b.no - 1].ex - b.exTime) < 0.006));
      if (!ok) continue;
      matched++;
      const pr = M.predict(r, s, M.slitAlerts(r, s), true, stats);
      const wi = pr.F.findIndex(f => f.b.no === r.result.order[0]);
      if (wi < 0) continue;
      const vals = pr.F.map(f => o[f.b.no - 1]);
      const mean = Object.fromEntries(FEATS.map(k => [k, vals.reduce((a, v) => a + v[k], 0) / vals.length]));
      // 速いほどプラス。秒の差を0.1秒単位に
      const x = vals.map(v => Object.fromEntries(FEATS.map(k => [k, (mean[k] - v[k]) * 10])));
      const pay = (r.result.payouts.win || []).find(y => String(y.combination) === String(r.result.order[0]));
      rows.push({d, wi, u0: pr.F.map(f => Math.log(f.raw)), x, od: pr.F.map(f => M.oddsOf(r.odds, "win", [f.b.no]) || 0), pay: pay ? +pay.amount : 0});
    }
    if (races && races % 120 === 0) console.log(d, `レース${races} 読めた${parsed} 一致${matched}`);
  }
  const train = rows.filter(r => r.d < "2026-07-01"), test = rows.filter(r => r.d >= "2026-07-01");
  const base = {train: evaluate(train, {}), test: evaluate(test, {})};
  const feats = {};
  for (const k of FEATS){ const b = fit(train, [k]); feats[k] = {name: NAMES[k], beta: b[k], test: evaluate(test, b)}; }
  const bAll = fit(train, FEATS);
  const out = {
    v: 1, built: new Date().toISOString(), stadium: "三国", from: START, to: addDays(today, -1),
    races, parsed, matched, used: rows.length, train: train.length, test: test.length,
    base, feats, all: {beta: bAll, test: evaluate(test, bAll), train: evaluate(train, bAll)},
    fullBeta: fit(rows, FEATS),
    debug: parsed ? undefined : debug.html
  };
  fs.writeFileSync("orig.json", JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("orig.mjs")) await main();
