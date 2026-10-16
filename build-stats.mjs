// スリットレーダー用の集計スクリプト（GitHub Actions で毎晩実行）
// 2026-01-01 以降の全レース結果から、選手のコース別成績と場の傾向を集計して
// stats.json（昨日まで・アプリ用）と stats-bt.json（15日前まで・検証用）を書き出す。
//
// 各コースの配列（16個の数）
//  0 出走  1 1着  2 2着  3 3着  4 ST合計(1/100秒)  5 ST件数
//  6 逃げで1着  7 差しで1着  8 まくりで1着  9 まくり差しで1着  10 その他で1着
// 11 1コースが逃げたレース数（2〜6コースのとき）  12 そのとき2着  13 そのとき2・3着
// 14 1コースで差されて負け  15 1コースでまくられて負け（まくり・まくり差し）
import fs from "node:fs";

const API = "https://boatraceopenapi.github.io/api/v1";
const START = "2026-01-01";
const CACHE = "cache";
const TECH = {"逃げ": 0, "差し": 1, "まくり": 2, "まくり差し": 3};

const num = v => (v === null || v === undefined || v === "" || isNaN(+v)) ? null : +v;
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const lastDay = addDays(today, -1);
const btCut = addDays(today, -15);
const keepFrom = addDays(today, -2); // 直近2日分は結果の更新があり得るので保存しない

fs.mkdirSync(CACHE, {recursive: true});

// 1日分のJSONから、集計に必要な部分だけを小さく取り出す
export function compact(j){
  const out = [];
  for (const [sk, S] of Object.entries((j && j.programs && j.programs.stadiums) || {})){
    for (const R of Object.values((S && S.races) || {})){
      const res = R && R.result;
      if (!res || !res.racers) continue;
      const rows = [];
      for (const x of Object.values(res.racers)){
        if (!x) continue;
        const e = num(x.entry_number), course = num(x.course_number);
        const prog = R.racers ? (R.racers[e] || R.racers[String(e)]) : null;
        const reg = num(x.number) ?? (prog ? num(prog.number) : null);
        if (!course || !reg) continue;
        const st = num(x.start_timing);
        rows.push([reg, course, num(x.place_number) || 0, st == null ? null : Math.round(st * 100)]);
      }
      if (rows.length < 4 || !rows.some(r => r[2] === 1)) continue;
      const tech = String(res.technique_number_source ?? "").trim();
      const tri = res.payouts && res.payouts.trifecta && res.payouts.trifecta[0] ? num(res.payouts.trifecta[0].amount) || 0 : 0;
      out.push([+sk, tech, tri, rows]);
    }
  }
  return out;
}

async function getDay(d){
  const f = `${CACHE}/${d}.json`;
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

const blank = () => new Array(16).fill(0);

export function build(days, data, until){
  const racers = {}, stadiums = {};
  let races = 0, from = null, to = null;
  for (const d of days){
    if (d > until) break;
    const list = data.get(d) || [];
    if (list.length){ from = from || d; to = d; }
    for (const [s, tech, tri, rows] of list){
      races++;
      const sd = stadiums[s] || (stadiums[s] = {races: 0, manshu: 0, c: [blank(), blank(), blank(), blank(), blank(), blank()]});
      sd.races++;
      if (tri >= 10000) sd.manshu++;
      const ti = TECH[tech] ?? 4;
      const c1 = rows.find(r => r[1] === 1);
      const nige = !!(c1 && c1[2] === 1 && ti === 0);
      for (const [reg, c, place, st] of rows){
        if (c < 1 || c > 6) continue;
        const rr = racers[reg] || (racers[reg] = [0, 0, 0, 0, 0, 0]);
        if (!rr[c - 1]) rr[c - 1] = blank();
        for (const a of [rr[c - 1], sd.c[c - 1]]){
          a[0]++;
          if (place >= 1 && place <= 3) a[place]++;
          if (st != null && st > 0 && st < 100){ a[4] += st; a[5]++; }
          if (place === 1) a[6 + ti]++;
          if (c >= 2 && nige){ a[11]++; if (place === 2) a[12]++; if (place === 2 || place === 3) a[13]++; }
          if (c === 1 && place !== 1){ if (ti === 1) a[14]++; if (ti === 2 || ti === 3) a[15]++; }
        }
      }
    }
  }
  return {v: 1, built: today, from, to, races, stadiums, racers};
}

if (process.argv[1] && process.argv[1].endsWith("build-stats.mjs")){
  const days = [];
  for (let d = START; d <= lastDay; d = addDays(d, 1)) days.push(d);
  const data = new Map();
  let i = 0;
  const worker = async () => { while (i < days.length){ const d = days[i++]; data.set(d, await getDay(d)); } };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const live = build(days, data, lastDay);
  const bt = build(days, data, btCut);
  fs.writeFileSync("stats.json", JSON.stringify(live));
  fs.writeFileSync("stats-bt.json", JSON.stringify(bt));
  console.log(`stats.json: ${live.races}レース（${live.from}〜${live.to}）、選手${Object.keys(live.racers).length}人`);
  console.log(`stats-bt.json: ${bt.races}レース（${bt.from}〜${bt.to}）`);
}
