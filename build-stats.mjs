// スリットレーダー用の集計スクリプト（GitHub Actions で毎晩実行）
// 直近6ヶ月のレース結果から、選手のコース別成績・スタートの傾向・場の傾向を集計して
// stats.json（昨日まで・アプリ用）と stats-bt.json（15日前まで・検証用）を書き出す。
//
// 各コースの配列（30個の数）
//  0 出走  1 1着  2 2着  3 3着  4 ST合計(1/100秒)  5 ST件数
//  6 逃げで1着  7 差しで1着  8 まくりで1着  9 まくり差しで1着  10 その他で1着
// 11 1コースが逃げたレース数（2〜6コースのとき）  12 そのとき2着  13 そのとき2・3着
// 14 1コースで差されて負け  15 1コースでまくられて負け（まくり・まくり差し）
// 16 ST順位の合計  17 ST順位の件数
// 18 抜け出し（両隣より0.05秒以上早い）  19 出遅れ（両隣より0.05秒以上遅い）  20 両隣と比べられた件数
// 21 安定（自分の平均STから±0.03秒以内）
// 22〜26 負けたときの勝った艇の決まり手（逃げ・差し・まくり・まくり差し・その他）
// 27 ST合計（直近3ヶ月）  28 ST件数（直近3ヶ月）  29 本番でのフライング
//
// 選手ごと：c = コース別の配列、z = 展示ST→本番STのズレ [件数, 合計, 絶対値の合計]（1/100秒）
//           r = 直近10日の結果 [何日前, 場, R, コース, 着順(0=失格など), ST]
// 場ごと：cc = 1着・2着・3着のコースの並びの回数（216個。(1着-1)*36+(2着-1)*6+(3着-1)）
import fs from "node:fs";

const API = "https://boatraceopenapi.github.io/api/v1";
const CACHE = "cache";
const PREFIX = "v2-";
const K = 30;
const TECH = {"逃げ": 0, "差し": 1, "まくり": 2, "まくり差し": 3};

const num = v => (v === null || v === undefined || v === "" || isNaN(+v)) ? null : +v;
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const lastDay = addDays(today, -1);
const btCut = addDays(today, -15);
const firstNeeded = addDays(btCut, -183);
const keepFrom = addDays(today, -2); // 直近2日分は結果の更新があり得るので保存しない

// 1日分のJSONから、集計に必要な部分だけを小さく取り出す
// [場, R, 決まり手, 3連単払戻, rows]  rows: [登録番号, コース, 着順, 本番ST, 展示ST, 艇番]
export function compact(j){
  const out = [];
  for (const [sk, S] of Object.entries((j && j.programs && j.programs.stadiums) || {})){
    for (const [rk, R] of Object.entries((S && S.races) || {})){
      const res = R && R.result;
      if (!res || !res.racers) continue;
      const pvr = (R.preview && R.preview.racers) || {};
      const rows = [];
      for (const x of Object.values(res.racers)){
        if (!x) continue;
        const e = num(x.entry_number), course = num(x.course_number);
        const prog = R.racers ? (R.racers[e] || R.racers[String(e)]) : null;
        const reg = num(x.number) ?? (prog ? num(prog.number) : null);
        if (!course || !reg || !e) continue;
        const st = num(x.start_timing);
        const q = pvr[e] || pvr[String(e)] || {};
        const ex = num(q.start_timing);
        rows.push([reg, course, num(x.place_number) || 0, st == null ? null : Math.round(st * 100), ex == null ? null : Math.round(ex * 100), e]);
      }
      if (rows.length < 4 || !rows.some(r => r[2] === 1)) continue;
      const tech = String(res.technique_number_source ?? "").trim();
      const tri = res.payouts && res.payouts.trifecta && res.payouts.trifecta[0] ? num(res.payouts.trifecta[0].amount) || 0 : 0;
      out.push([+sk, +rk, tech, tri, rows]);
    }
  }
  return out;
}

async function getDay(d){
  const f = `${CACHE}/${PREFIX}${d}.json`;
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const url = `${API}/${d.slice(0, 4)}/${d.replace(/-/g, "")}.json`;
  for (let attempt = 0; attempt < 3; attempt++){
    try {
      const r = await fetch(url);
      if (r.status === 404){ if (d < keepFrom) fs.writeFileSync(f, "[]"); return []; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const out = compact(await r.json());
      if (d < keepFrom) fs.writeFileSync(f, JSON.stringify(out));
      return out;
    } catch (e){
      await new Promise(res => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
  console.warn("取得できなかった日:", d);
  return [];
}

const blank = () => new Array(K).fill(0);

export function build(days, data, until, opt = {}){
  const from6 = addDays(until, -182), from3 = addDays(until, -91), fromRecent = addDays(until, -9);
  const list = [];
  for (const d of days){
    if (d < from6 || d > until) continue;
    for (const race of data.get(d) || []) list.push([d, ...race]);
  }
  // 1回目：選手×コースの平均ST（安定率の基準）
  const avg = new Map();
  for (const [, , , , , rows] of list){
    for (const [reg, c, , st] of rows){
      if (st == null || st <= 0 || st >= 100) continue;
      const k = reg * 10 + c, v = avg.get(k) || [0, 0];
      v[0] += st; v[1]++; avg.set(k, v);
    }
  }
  const racers = {}, stadiums = {};
  let from = null, to = null;
  for (const [d, s, rno, tech, tri, rows] of list){
    from = from && from < d ? from : d; to = to && to > d ? to : d;
    const sd = stadiums[s] || (stadiums[s] = {races: 0, manshu: 0, c: [blank(), blank(), blank(), blank(), blank(), blank()], deme: {}, cc: new Array(216).fill(0)});
    sd.races++;
    if (tri >= 10000) sd.manshu++;
    const ti = TECH[tech] ?? 4;
    const c1 = rows.find(r => r[1] === 1);
    const nige = !!(c1 && c1[2] === 1 && ti === 0);
    const byC = new Map(rows.map(r => [r[1], r]));
    const sts = rows.filter(r => r[3] != null && r[3] >= 0).map(r => r[3]);
    const top = [1, 2, 3].map(p => (rows.find(r => r[2] === p) || [])[5]);
    if (top.every(Boolean)){ const k = top.join("-"); sd.deme[k] = (sd.deme[k] || 0) + 1; }
    const tc = [1, 2, 3].map(p => (rows.find(r => r[2] === p) || [])[1]);
    if (tc.every(c => c >= 1 && c <= 6) && new Set(tc).size === 3) sd.cc[(tc[0] - 1) * 36 + (tc[1] - 1) * 6 + tc[2] - 1]++;
    for (const [reg, c, place, st, ex] of rows){
      if (c < 1 || c > 6) continue;
      const R = racers[reg] || (racers[reg] = {c: [0, 0, 0, 0, 0, 0], z: [0, 0, 0]});
      if (!R.c[c - 1]) R.c[c - 1] = blank();
      const nb = [byC.get(c - 1), byC.get(c + 1)].filter(n => n && n[3] != null && n[3] >= 0).map(n => n[3]);
      const av = avg.get(reg * 10 + c);
      for (const a of [R.c[c - 1], sd.c[c - 1]]){
        a[0]++;
        if (place >= 1 && place <= 3) a[place]++;
        if (st != null && st > 0 && st < 100){ a[4] += st; a[5]++; if (d >= from3){ a[27] += st; a[28]++; } }
        if (st != null && st < 0) a[29]++;
        if (place === 1) a[6 + ti]++; else a[22 + ti]++;
        if (c >= 2 && nige){ a[11]++; if (place === 2) a[12]++; if (place === 2 || place === 3) a[13]++; }
        if (c === 1 && place !== 1){ if (ti === 1) a[14]++; if (ti === 2 || ti === 3) a[15]++; }
        if (st != null && st >= 0){
          a[16] += 1 + sts.filter(v => v < st).length; a[17]++;
          if (nb.length){ a[20]++; if (st <= Math.min(...nb) - 5) a[18]++; if (st >= Math.max(...nb) + 5) a[19]++; }
          if (av && av[1] >= 3 && Math.abs(st - av[0] / av[1]) <= 3) a[21]++;
        }
      }
      // 展示でF（ex < 0）のときはずれの計算に入れない
      if (st != null && ex != null && st >= 0 && ex >= 0){ R.z[0]++; R.z[1] += st - ex; R.z[2] += Math.abs(st - ex); }
      if (opt.recent && d >= fromRecent) (R.r || (R.r = [])).push([dayDiff(until, d), s, rno, c, place, st]);
    }
  }
  for (const R of Object.values(racers)){
    if (!R.z[0]) delete R.z;
    if (R.r) R.r = R.r.sort((x, y) => y[0] - x[0] || x[2] - y[2]).slice(-16);
  }
  for (const sd of Object.values(stadiums)){
    sd.deme = Object.entries(sd.deme).sort((x, y) => y[1] - x[1]).slice(0, 20);
  }
  return {v: 2, built: today, window: "6m", from, to, races: list.length, stadiums, racers};
}

if (process.argv[1] && process.argv[1].endsWith("build-stats.mjs")){
  fs.mkdirSync(CACHE, {recursive: true});
  // 古い形式のキャッシュと、使わなくなった古い日付を消す
  for (const f of fs.readdirSync(CACHE)){
    if (!f.startsWith(PREFIX) || f.slice(PREFIX.length, PREFIX.length + 10) < addDays(firstNeeded, -7)) fs.rmSync(`${CACHE}/${f}`, {force: true});
  }
  const days = [];
  for (let d = firstNeeded; d <= lastDay; d = addDays(d, 1)) days.push(d);
  const data = new Map();
  let i = 0;
  const worker = async () => { while (i < days.length){ const d = days[i++]; data.set(d, await getDay(d)); } };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const live = build(days, data, lastDay, {recent: true});
  const bt = build(days, data, btCut);
  fs.writeFileSync("stats.json", JSON.stringify(live));
  fs.writeFileSync("stats-bt.json", JSON.stringify(bt));
  console.log(`stats.json: ${live.races}レース（${live.from}〜${live.to}）、選手${Object.keys(live.racers).length}人`);
  console.log(`stats-bt.json: ${bt.races}レース（${bt.from}〜${bt.to}）`);
}
