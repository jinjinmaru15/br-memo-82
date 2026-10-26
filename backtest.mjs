// スリットレーダーの長期検証（GitHub Actions で毎晩実行）
// 2026年1月からのオッズ付きデータで、アプリと同じ計算で予想し直し、
// 「期待値プラスだけ買ったら」の成績を backtest.json に書き出す。
// コース別成績は、検証する月より前のデータだけで作る（答えを先に見ない）。
// 元データは公開リポジトリには置かず、GitHub のキャッシュ（btcache）にだけ保存する。
import fs from "node:fs";
import zlib from "node:zlib";
import {compact as compactStats, build} from "./build-stats.mjs";
import {motorIndex, motorEx, renewMap} from "./motorex.mjs";

const SRC = "https://turnmark.github.io/api/v1";
const START = "2026-01-01";
const CACHE = "btcache";
// b6：モーター番号（モーターの展示の速さ用）と3連複の払戻（自信ごとの成績用）も持つ。前の形（b1〜b5）は消す
const PREFIX = "b6-";
const pfx = d => PREFIX;
const FUNA = "https://funanote-k7q2xm.pages.dev/data/";
const UA = "Mozilla/5.0 (compatible; slit-radar-import/1.0; with permission of the site operator)";
const GRID_EV = [1.2, 1.3, 1.5, 2.0];
const GRID_P = [0.02, 0.05, 0.10];
const MAIN = {ev: 2.0, minP: 0.10};
const BANDS = [[1, 3], [3, 6], [6, 10], [10, 20], [20, 1e9]];
// 開催日ごと。2026-10-17 以降は、条件を探すのに使っていない新しいレース（ここで本物かどうかを確かめる）
const FRESH = "2026-10-17";
// アプリの「自信」と同じ決め方：一番ありそうな3艇で1〜3着が決まる確率（順番なし）が30%以上「かたい」、20%以上「ふつう」、それ未満「荒れそう」。
// オッズ（3連単から出した1着の確率）と意見が大きく割れる（KL 0.07超）ときは一段下げる
const JISHIN = [[0.30, "かたい"], [0.20, "ふつう"], [0, "荒れそう"]];
const DAYB = [["初日", r => r.day === 1 && !r.lastDay], ["2日目", r => r.day === 2 && !r.lastDay], ["3日目", r => r.day === 3 && !r.lastDay],
  ["4日目以降", r => r.day >= 4 && !r.lastDay], ["最終日", r => r.lastDay]];

const html = fs.readFileSync("index.html", "utf8");
const ia = html.indexOf("/* ---------- 定数 ---------- */"), ib = html.indexOf("/* ---------- 状態 ---------- */");
if (ia < 0 || ib < 0) throw new Error("index.html から判定コードを見つけられませんでした");
const M = new Function(html.slice(ia, ib) + "\nreturn {parseV1, predict, slitAlerts, prepStats, oddsOf, DEFAULTS, PAYKEY, impliedWin: typeof impliedWin === 'function' ? impliedWin : null, formFromList: typeof formFromList === 'function' ? formFromList : null};")();

const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const lastDay = addDays(today, -1);
const keepFrom = addDays(today, -3);

// 予想に必要な部分だけを残した小さなレース
function mini(r){
  const o = r.odds;
  return {
    s: r.stadium, no: r.no, hp: r.hasPreview, day: r.day ?? null, last: !!r.lastDay, wind: r.cond ? r.cond.wind : null, wd: r.cond ? r.cond.wd : null, wave: r.cond ? r.cond.wave : null,
    boats: r.boats.map(b => ({no: b.no, reg: b.reg, cls: b.cls, win: b.win, local: b.local, top2: b.top2, top3: b.top3, ltop2: b.ltop2, ltop3: b.ltop3, motor3: b.motor3, boat3: b.boat3, avgST: b.avgST, F: b.F, motor2: b.motor2, boat2: b.boat2, mno: b.motorNo ?? null, course: b.course, exST: b.exST, exF: b.exF, exTime: b.exTime, tilt: b.tilt, prop: b.prop, parts: b.parts, wt: b.wt, wtAdj: b.wtAdj})),
    order: r.result.order,
    pay: {win: r.result.payouts.win || [], exacta: r.result.payouts.exacta || [], trifecta: r.result.payouts.trifecta || [], trio: r.result.payouts.trio || []},
    odds: o ? {win: o.win, exacta: o.exacta, trifecta: o.trifecta} : null
  };
}
const race = m => ({stadium: m.s, no: m.no, hasPreview: m.hp, day: m.day ?? null, lastDay: !!m.last, cond: m.wind == null ? null : {wind: m.wind, wd: m.wd, wave: m.wave}, boats: m.boats, odds: m.odds, result: {order: m.order, payouts: m.pay}});

export async function getDay(d, fetcher = fetch){
  const f = `${CACHE}/${pfx(d)}${d}.json.gz`;
  if (fs.existsSync(f)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
  const url = `${SRC}/${d.slice(0, 4)}/${d.replace(/-/g, "")}.json`;
  for (let attempt = 0; attempt < 3; attempt++){
    try {
      const res = await fetcher(url);
      if (res.status === 404){
        const empty = {races: [], stats: []};
        if (d < keepFrom) fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(empty)));
        return empty;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const out = {races: M.parseV1(j, d).filter(r => r.result && r.result.order.length).map(mini), stats: compactStats(j)};
      if (d < keepFrom) fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(out)));
      return out;
    } catch (e){
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  console.warn("取得できなかった日:", d);
  return {races: [], stats: []};
}

function agg(list){
  const n = list.length;
  if (!n) return {n: 0, hit: 0, ret: 0, roi: 0, lo: 0, hi: 0};
  let ret = 0, hit = 0, sq = 0;
  for (const x of list){ ret += x.pay; if (x.pay) hit++; sq += (x.pay / 100) ** 2; }
  const roi = ret / (100 * n);
  const sd = Math.sqrt(Math.max(0, sq / n - roi * roi));
  const se = sd / Math.sqrt(n);
  return {n, hit, ret, roi: +roi.toFixed(4), lo: +(roi - 1.96 * se).toFixed(4), hi: +(roi + 1.96 * se).toFixed(4)};
}

// モーターカルテ（データ攻め・許可を得て使用）。サイトから読めなければ、リポジトリに置いた写し（funadata/）を使う
async function loadMotor(){
  const get = async name => {
    try {
      const r = await fetch(FUNA + name, {headers: {"User-Agent": UA, "Accept-Language": "ja"}, signal: AbortSignal.timeout(60000)});
      await new Promise(ok => setTimeout(ok, 1000));
      if (r.ok) return await r.json();
    } catch (e){}
    try {
      const f = `funadata/data__${name}.gz`;
      if (fs.existsSync(f)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
    } catch (e){}
    return null;
  };
  const karte = await get("motorKarte.json");
  if (!karte || !karte.records){ console.warn("モーターカルテを読めませんでした（展示の速さなしで検証します）"); return null; }
  const idx = motorIndex(karte, renewMap(await get("motorReplace.json"), await get("motorUsage.json")));
  console.log(`モーターカルテ：記録は ${idx.last} まで`);
  return idx;
}

export async function main(fetcher = fetch){
  fs.mkdirSync(CACHE, {recursive: true});
  for (const f of fs.readdirSync(CACHE)) if (!f.startsWith(PREFIX)){ try { fs.unlinkSync(`${CACHE}/${f}`); } catch (e){} }
  const motor = await loadMotor();
  const days = [];
  for (let d = START; d <= lastDay; d = addDays(d, 1)) days.push(d);

  // 1回目：全日をそろえる（集計用の小さなデータだけ手元に置く）
  const statsData = new Map(), fresh = new Map();
  let i = 0;
  const worker = async () => {
    while (i < days.length){
      const d = days[i++];
      const x = await getDay(d, fetcher);
      statsData.set(d, x.stats);
      if (d >= keepFrom) fresh.set(d, x.races);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const s = {...M.DEFAULTS, w: {...M.DEFAULTS.w}};
  const cand = [], alertAll = [], alertEV = [], finalWin = [];
  // 信頼度（◎の1着率）ごとの成績：アプリの「信頼度」と同じ区切り
  const CONF = [[0.65, "高"], [0.5, "中"], [0.35, "低"], [0, "混戦"]];
  const z = () => ({n: 0, hit: 0, ret: 0});
  const byConf = CONF.map(([from, label]) => ({from, label, races: 0, top: z(), rec: z(), ex1: z(), tri: z()}));
  const dayBlank = () => DAYB.map(([label]) => ({label, races: 0, top: z(), rec: z(), tri: z(), kon: z()}));
  const byDay = {known: dayBlank(), fresh: dayBlank()};
  const jBlank = () => JISHIN.map(([from, label]) => ({label, from, races: 0, hit3: 0, top: z(), ex1: z(), tri: z(), trio: z()}));
  const byJishin = {known: jBlank(), fresh: jBlank()};
  const months = [...new Set(days.map(d => d.slice(0, 7)))];
  const perMonth = {};
  let N = 0, oddsRaces = 0, hit1 = 0, c1Win = 0, ll = 0, llBase = 0;
  const bins = [0, 1, 2, 3, 4].map(() => ({n: 0, w: 0, p: 0}));

  // 2回目：月ごとに、その月より前のデータだけで集計を作って予想する
  let recent = [];   // 今節の調子用：直近6日のレース
  for (const mon of months){
    const until = addDays(mon + "-01", -1);
    const built = build(days, statsData, until);
    const stats = built.races ? M.prepStats(built) : null;
    perMonth[mon] = {races: 0, odds: 0, statsRaces: built.races};
    for (const d of days.filter(x => x.startsWith(mon))){
      const list = fresh.has(d) ? fresh.get(d) : (await getDay(d, fetcher)).races;
      const dayRaces = list.map(m => ({...race(m), date: d}));
      // モーターの展示の速さ：その日より前の記録だけで計算（答えを先に見ない）
      const ymd = d.replace(/-/g, "");
      for (const r of dayRaces) for (const b of r.boats) b.mx = motor && b.mno != null ? motorEx(motor, r.stadium, b.mno, ymd).mx : 0;
      recent = recent.filter(x => x.date >= addDays(d, -6)).concat(dayRaces);
      if (M.formFromList) M.formFromList(recent, dayRaces);
      for (const r of dayRaces){
        if (!r.hasPreview) continue;
        const alerts = M.slitAlerts(r, s);
        const pr = M.predict(r, s, alerts, false, stats);
        const win = r.result.order[0];
        const fw = pr.F.find(f => f.b.no === win);
        if (!fw) continue;
        N++; perMonth[mon].races++;
        ll += -Math.log(Math.max(fw.p1, 1e-6));
        const ps = pr.F.reduce((a, f) => a + f.prior, 0);
        llBase += -Math.log(Math.max(fw.prior / ps, 1e-6));
        if (pr.top.b.no === win) hit1++;
        if (pr.c1.b.no === win) c1Win++;
        pr.F.forEach(f => { const bi = Math.min(4, Math.floor(f.p1 * 5)); bins[bi].n++; bins[bi].p += f.p1; if (f.b.no === win) bins[bi].w++; });
        if (!r.odds) continue;
        oddsRaces++; perMonth[mon].odds++;
        const payOf = (t, c) => {
          const comb = t === "win" ? String(c[0]) : c.join("-");
          const p = (r.result.payouts[M.PAYKEY[t]] || []).find(x => String(x.combination) === comb);
          return p ? (+p.amount || 0) : 0;
        };
        // 単勝は、買う前に見えるオッズ（3連単から推定）で選び、実際の払戻で数える
        // （確定の単勝オッズで選ぶと200%近く出るが、買う時点では確定オッズはわからないので参考だけ）
        const iw = M.impliedWin ? M.impliedWin(r.odds, pr.F.map(f => f.b.no)) : null;
        const winOd = no => iw ? iw[no] || null : null;
        const add = (t, c, p) => {
          if (p < GRID_P[0]) return;
          const od = t === "win" ? winOd(c[0]) : M.oddsOf(r.odds, t, c);
          if (!od || p * od < GRID_EV[0]) return;
          cand.push({t, p, od, ev: p * od, pay: payOf(t, c), m: mon});
        };
        for (const f of pr.F){
          const od = M.oddsOf(r.odds, "win", [f.b.no]);
          if (od && f.p1 >= MAIN.minP && f.p1 * od >= MAIN.ev) finalWin.push({p: f.p1, od, pay: payOf("win", [f.b.no])});
        }
        pr.F.forEach(f => add("win", [f.b.no], f.p1));
        pr.exAll.forEach(x => add("ex", x.c, x.p));
        pr.triAll.forEach(x => add("tri", x.c, x.p));
        // 信頼度ごと：◎の単勝・推奨（期待値で選ぶ単勝）・参考の2連単1点と3連単（合計25%まで最大5点）
        const C = byConf[CONF.findIndex(([t]) => pr.top.p1 >= t)];
        const order = r.result.order;
        const put = (o, cost, pay) => { o.n += cost; if (pay > 0){ o.hit++; o.ret += pay; } };
        C.races++;
        put(C.top, 1, pr.top.b.no === win ? payOf("win", [win]) : 0);
        for (const f of pr.F){
          const od = winOd(f.b.no);
          if (od && f.p1 >= MAIN.minP && f.p1 * od >= MAIN.ev) put(C.rec, 1, f.b.no === win ? payOf("win", [win]) : 0);
        }
        const e1 = pr.exAll[0];
        put(C.ex1, 1, e1.c[0] === order[0] && e1.c[1] === order[1] ? payOf("ex", e1.c) : 0);
        let cum = 0; const picks = [];
        for (const t of pr.triAll){ if (picks.length >= 5 || cum >= 0.25) break; picks.push(t); cum += t.p; }
        const th = picks.find(t => t.c[0] === order[0] && t.c[1] === order[1] && t.c[2] === order[2]);
        C.tri.n += picks.length; if (th){ C.tri.hit++; C.tri.ret += payOf("tri", th.c); }
        // 開催日ごと：◎の単勝・期待値で選ぶ単勝・3連単（期待値1.5以上・確率1%以上）・混戦レースの3連単（期待値2以上・確率1%以上）
        const di = DAYB.findIndex(([, f]) => f(r));
        if (di >= 0){
          const D = (d >= FRESH ? byDay.fresh : byDay.known)[di];
          D.races++;
          put(D.top, 1, pr.top.b.no === win ? payOf("win", [win]) : 0);
          for (const f of pr.F){
            const od = winOd(f.b.no);
            if (od && f.p1 >= MAIN.minP && f.p1 * od >= MAIN.ev) put(D.rec, 1, f.b.no === win ? payOf("win", [win]) : 0);
          }
          const kon = pr.top.p1 < 0.35;
          for (const t of pr.triAll){
            if (t.p < 0.01) continue;
            const od = M.oddsOf(r.odds, "tri", t.c);
            if (!od) continue;
            const pay = t.c[0] === order[0] && t.c[1] === order[1] && t.c[2] === order[2] ? payOf("tri", t.c) : 0;
            if (t.p * od >= 1.5) put(D.tri, 1, pay);
            if (kon && t.p * od >= 2) put(D.kon, 1, pay);
          }
        }
        // 自信ごと：◎の単勝・2連単1点・3連単（参考）・3連複（自信の3艇を1点）
        if (pr.set3){
          const q = {}; let qt = 0;
          for (const a of pr.F) for (const b of pr.F) for (const c of pr.F){
            if (a === b || b === c || a === c) continue;
            const od = M.oddsOf(r.odds, "tri", [a.b.no, b.b.no, c.b.no]);
            if (od > 0){ q[a.b.no] = (q[a.b.no] || 0) + 1 / od; qt += 1 / od; }
          }
          let li = JISHIN.findIndex(([t]) => pr.set3.p >= t);
          if (qt){
            const kl = pr.F.reduce((a, f) => { const m = (q[f.b.no] || 0) / qt; return a + (f.p1 > 0 && m > 0 ? f.p1 * Math.log(f.p1 / m) : 0); }, 0);
            if (kl > 0.07) li = Math.min(JISHIN.length - 1, li + 1);
          }
          const J = (d >= FRESH ? byJishin.fresh : byJishin.known)[li];
          J.races++;
          put(J.top, 1, pr.top.b.no === win ? payOf("win", [win]) : 0);
          put(J.ex1, 1, e1.c[0] === order[0] && e1.c[1] === order[1] ? payOf("ex", e1.c) : 0);
          J.tri.n += picks.length; if (th){ J.tri.hit++; J.tri.ret += payOf("tri", th.c); }
          const in3 = order.length >= 3 && pr.set3.c.every(n => order.slice(0, 3).includes(n));
          if (in3) J.hit3++;
          const trio = r.result.payouts.trio;
          if (trio && trio.length){
            const comb = [...order.slice(0, 3)].sort((a, b) => a - b).join("=");
            const x = trio.find(y => String(y.combination) === comb);
            put(J.trio, 1, in3 && x ? +x.amount || 0 : 0);
          }
        }
        for (const a of alerts){
          if (a.type !== "nobi" || a.level !== 2) continue;
          const f = pr.F.find(g => g.b.no === a.boat);
          const od = winOd(a.boat);
          if (!f || !od) continue;
          const x = {p: f.p1, od, pay: payOf("win", [a.boat])};
          alertAll.push(x);
          if (f.p1 * od >= MAIN.ev && f.p1 >= MAIN.minP) alertEV.push(x);
        }
      }
    }
  }

  const pick = (t, ev, minP) => cand.filter(x => x.t === t && x.ev >= ev - 1e-9 && x.p >= minP - 1e-9);
  const main = pick("win", MAIN.ev, MAIN.minP);
  const out = {
    v: 2, sel: "tri", built: today, from: START, to: lastDay, races: N, oddsRaces, motor: motor ? motor.last : null,
    base: {hit1: N ? hit1 / N : 0, c1Win: N ? c1Win / N : 0, ll: N ? ll / N : 0, llBase: N ? llBase / N : 0, bins},
    main: {...MAIN, win: agg(main), finalWin: agg(finalWin)},
    grid: GRID_EV.flatMap(ev => GRID_P.map(minP => ({ev, minP, win: agg(pick("win", ev, minP)), ex: agg(pick("ex", ev, minP)), tri: agg(pick("tri", ev, minP))}))),
    monthly: months.map(m => ({m, ...perMonth[m], ...agg(main.filter(x => x.m === m))})),
    bands: BANDS.map(([from, to]) => ({from, to, ...agg(main.filter(x => x.od >= from && x.od < to))})),
    alert: {all: agg(alertAll), ev: agg(alertEV)},
    byConf: byConf.map(c => ({...c, ...Object.fromEntries(["top", "rec", "ex1", "tri"].map(k => [k, {...c[k], roi: c[k].n ? +(c[k].ret / (100 * c[k].n)).toFixed(4) : 0}]))})),
    byDay: {from: FRESH, ...Object.fromEntries(["known", "fresh"].map(g => [g, byDay[g].map(c => ({...c, ...Object.fromEntries(["top", "rec", "tri", "kon"].map(k => [k, {...c[k], roi: c[k].n ? +(c[k].ret / (100 * c[k].n)).toFixed(4) : 0}]))}))]))},
    byJishin: {from: FRESH, ...Object.fromEntries(["known", "fresh"].map(g => [g, byJishin[g].map(c => ({...c, ...Object.fromEntries(["top", "ex1", "tri", "trio"].map(k => [k, {...c[k], roi: c[k].n ? +(c[k].ret / (100 * c[k].n)).toFixed(4) : 0}]))}))]))}
  };
  fs.writeFileSync("backtest.json", JSON.stringify(out));
  const w = out.main.win;
  console.log(`対象 ${N}レース（オッズあり ${oddsRaces}）`);
  console.log(`単勝・期待値${MAIN.ev}以上・確率${MAIN.minP * 100}%以上：${w.n}点 回収率${(w.roi * 100).toFixed(1)}%（95%の範囲 ${(w.lo * 100).toFixed(0)}〜${(w.hi * 100).toFixed(0)}%）`);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("backtest.mjs")) await main();
