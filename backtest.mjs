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
// b7：モーター番号（モーターの展示の速さ用）と3連複・複勝の払戻（自信ごと・◎単勝候補の成績用）も持つ。前の形は消す
const PREFIX = "b7-";
const pfx = d => PREFIX;
const FUNA = "https://funanote-k7q2xm.pages.dev/data/";
const UA = "Mozilla/5.0 (compatible; slit-radar-import/1.0; with permission of the site operator)";
const GRID_EV = [1.2, 1.3, 1.5, 2.0];
const GRID_P = [0.02, 0.05, 0.10];
const MAIN = {ev: 2.0, minP: 0.10};
const BANDS = [[1, 3], [3, 6], [6, 10], [10, 20], [20, 1e9]];
// 開催日ごと。2026-10-17 以降は、条件を探すのに使っていない新しいレース（ここで本物かどうかを確かめる）
const FRESH = "2026-10-17";
// 自信ごとの成績：自信はオッズを見ない形（オッズと割れても下げない）、3連単はおすすめ点数（かたい3・ふつう6・荒れそう10点）。
// 10/29の版で2着・3着のコースの並びの補正を入れた（10/28までのレースで決めた）ので、10/29からが新しいレース
const JFRESH = "2026-10-29";
// アプリの「自信」と同じ決め方：一番ありそうな3艇で1〜3着が決まる確率（順番なし）が30%以上「かたい」、20%以上「ふつう」、それ未満「荒れそう」。
// オッズ（3連単から出した1着の確率）と意見が大きく割れる（KL 0.07超）ときは一段下げる
const JISHIN = [[0.30, "かたい"], [0.20, "ふつう"], [0, "荒れそう"]];
// ◎単勝候補：信頼度「低」（◎の1着率35〜50%）×自信「かたい」。2〜10/25の約1,700レースで◎単勝の回収率は約99%（とんとん）。
// 見つけたあとの新しいレースで、本当にプラスかを確かめる（10/29の版で2着・3着の補正を入れて自信が少し変わったので、10/29から数え直し）
const CAND = {lo: 0.35, hi: 0.50, from: "2026-10-29"};
const DAYB = [["初日", r => r.day === 1 && !r.lastDay], ["2日目", r => r.day === 2 && !r.lastDay], ["3日目", r => r.day === 3 && !r.lastDay],
  ["4日目以降", r => r.day >= 4 && !r.lastDay], ["最終日", r => r.lastDay]];

const html = fs.readFileSync("index.html", "utf8");
const ia = html.indexOf("/* ---------- 定数 ---------- */"), ib = html.indexOf("/* ---------- 状態 ---------- */");
if (ia < 0 || ib < 0) throw new Error("index.html から判定コードを見つけられませんでした");
const M = new Function(html.slice(ia, ib) + "\nreturn {parseV1, predict, slitAlerts, prepStats, oddsOf, DEFAULTS, PAYKEY, impliedWin: typeof impliedWin === 'function' ? impliedWin : null, formFromList: typeof formFromList === 'function' ? formFromList : null, serExFromList: typeof serExFromList === 'function' ? serExFromList : null, TRI_PLAN: typeof TRI_PLAN !== 'undefined' ? TRI_PLAN : null, arareCalc: typeof arareCalc === 'function' ? arareCalc : null};")();

// データ攻めの分類（波乱・堅め・混戦）と荒れスコア：funanote.mjs が毎朝 funadata/hantei/ と funadata/arare/ にためたもの
const FUNA_CLS = ["波乱", "堅め", "混戦"];
function loadFunaDaily(){
  const H = new Map(), A = new Map();
  try {
    for (const f of fs.readdirSync("funadata/hantei")){
      const j = JSON.parse(fs.readFileSync(`funadata/hantei/${f}`, "utf8"));
      for (const [k, v] of Object.entries(j.races || {})) if (v && FUNA_CLS.includes(v[0])) H.set(`${j.d}|${k}`, v[0]);
    }
  } catch (e){}
  try {
    for (const f of fs.readdirSync("funadata/arare")){
      const j = JSON.parse(fs.readFileSync(`funadata/arare/${f}`, "utf8"));
      for (const x of Object.values(j.races || {})){
        const hd = String(x.hd || "");
        if (!/^\d{8}$/.test(hd) || x.score == null) continue;
        A.set(`${hd.slice(0, 4)}-${hd.slice(4, 6)}-${hd.slice(6, 8)}|${parseInt(x.jcd, 10)}-${x.rno}`, +x.score);
      }
    }
  } catch (e){}
  return {H, A};
}

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
    pay: {win: r.result.payouts.win || [], place: r.result.payouts.place || [], exacta: r.result.payouts.exacta || [], trifecta: r.result.payouts.trifecta || [], trio: r.result.payouts.trio || []},
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
  // fast／other：◎の今節の展示順位が速い候補とそれ以外（ボートレース日和の項目の検証で見つけた絞り込み。10/25までで見つけた）
  const cOne = () => ({races: 0, top: z(), place: z()});
  const cBlank = () => ({...cOne(), fast: cOne(), other: cOne()});
  const kouho = {known: cBlank(), fresh: cBlank(), recent: []};
  // データ攻め：荒れスコア（アプリで同じ数え方・2月〜）と、サイトの荒れスコア・分類（毎朝ためた日から）ごとの成績
  const FD = loadFunaDaily();
  const fz = label => ({label, races: 0, b1: 0, are: 0, man: 0, b1win: z(), top: z(), tri: z()});
  const LV = ["低", "中", "高"], lvIdx = sc => sc >= 4 ? 2 : sc >= 2 ? 1 : 0;
  const funa = {calc: LV.map(fz), site: LV.map(fz), cls: FUNA_CLS.map(fz), siteFrom: null};
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
        // データ攻めの荒れスコア・分類ごと：1号艇の1着率・荒れ率（3連単5千円以上）・万舟率、1号艇の単勝・◎の単勝・アプリの3連単おすすめの回収率
        if (stats && pr.set3 && r.result.order.length >= 3){
          const order = r.result.order;
          const pw = (k, comb) => { const p = (r.result.payouts[k] || []).find(x => String(x.combination) === comb); return p ? (+p.amount || 0) : 0; };
          const triPay = pw("trifecta", order.slice(0, 3).join("-")), winPay = pw("win", String(order[0]));
          const li0 = JISHIN.findIndex(([t]) => pr.set3.p >= t);
          const tp = pr.triAll.slice(0, M.TRI_PLAN ? M.TRI_PLAN[li0] : 5);
          const tHit = tp.some(t => t.c[0] === order[0] && t.c[1] === order[1] && t.c[2] === order[2]);
          const putF = G => {
            G.races++; if (order[0] === 1) G.b1++; if (triPay >= 5000) G.are++; if (triPay >= 10000) G.man++;
            G.b1win.n++; if (order[0] === 1 && winPay){ G.b1win.hit++; G.b1win.ret += winPay; }
            G.top.n++; if (pr.top.b.no === order[0] && winPay){ G.top.hit++; G.top.ret += winPay; }
            G.tri.n += tp.length; if (tHit){ G.tri.hit++; G.tri.ret += triPay; }
          };
          const ac = M.arareCalc ? M.arareCalc(r) : null;
          if (ac) putF(funa.calc[lvIdx(ac.score)]);
          const key = `${d}|${r.stadium}-${r.no}`;
          if (FD.A.has(key)){ putF(funa.site[lvIdx(FD.A.get(key))]); if (!funa.siteFrom || d < funa.siteFrom) funa.siteFrom = d; }
          if (FD.H.has(key)) putF(funa.cls[FUNA_CLS.indexOf(FD.H.get(key))]);
        }
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
          const li0 = JISHIN.findIndex(([t]) => pr.set3.p >= t);   // オッズを見ない自信（アプリの表示・3連単の提案と同じ）
          let li = li0;                                              // ◎単勝候補用：オッズと大きく割れたら一段下げる
          if (qt){
            const kl = pr.F.reduce((a, f) => { const m = (q[f.b.no] || 0) / qt; return a + (f.p1 > 0 && m > 0 ? f.p1 * Math.log(f.p1 / m) : 0); }, 0);
            if (kl > 0.07) li = Math.min(JISHIN.length - 1, li + 1);
          }
          // ◎単勝候補（信頼度「低」×自信「かたい」）：◎の単勝と複勝
          if (stats && li === 0 && pr.top.p1 >= CAND.lo && pr.top.p1 < CAND.hi){   // 1月はコース実績がなく予想の形が違うので数えない
            const G = d >= CAND.from ? kouho.fresh : kouho.known, A = pr.top.b.no;
            const wp = win === A ? payOf("win", [A]) : 0;
            const pl = order.slice(0, 2).includes(A) ? (+((r.result.payouts.place || []).find(x => String(x.combination) === String(A)) || {}).amount || 0) : 0;
            G.races++; put(G.top, 1, wp); put(G.place, 1, pl);
            const se = M.serExFromList ? M.serExFromList(recent, r).get(A) || null : null;
            const fast = !!(se && se.lv === "fast");
            const H = G[fast ? "fast" : "other"];
            H.races++; put(H.top, 1, wp); put(H.place, 1, pl);
            if (d >= CAND.from) kouho.recent.push({d, s: r.stadium, no: r.no, A, p1: +pr.top.p1.toFixed(3), se: se ? +se.avg.toFixed(2) : null, sn: se ? se.n : 0, fast: fast ? 1 : 0, res: order.slice(0, 3), win: wp, place: pl});
          }
          // 1月はコース実績がなく予想の形が違うので数えない（カードの「過去の成績」と同じ2月から）
          const J = stats ? (d >= JFRESH ? byJishin.fresh : byJishin.known)[li0] : {races: 0, hit3: 0, top: z(), ex1: z(), tri: z(), trio: z()};
          J.races++;
          put(J.top, 1, pr.top.b.no === win ? payOf("win", [win]) : 0);
          put(J.ex1, 1, e1.c[0] === order[0] && e1.c[1] === order[1] ? payOf("ex", e1.c) : 0);
          // 3連単：アプリの確率の高い順に、おすすめ点数（オッズは見ない）
          const tp = pr.triAll.slice(0, M.TRI_PLAN ? M.TRI_PLAN[li0] : 5);
          const tth = tp.find(t => t.c[0] === order[0] && t.c[1] === order[1] && t.c[2] === order[2]);
          J.tri.n += tp.length; if (tth){ J.tri.hit++; J.tri.ret += payOf("tri", tth.c); }
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
    cand: (() => {
      const one = c => ({races: c.races, ...Object.fromEntries(["top", "place"].map(k => [k, {...c[k], roi: c[k].n ? +(c[k].ret / (100 * c[k].n)).toFixed(4) : 0}]))});
      return {...CAND, ...Object.fromEntries(["known", "fresh"].map(g => [g, {...one(kouho[g]), fast: one(kouho[g].fast), other: one(kouho[g].other)}])), recent: kouho.recent.slice(-60)};
    })(),
    byJishin: {from: JFRESH, plan: M.TRI_PLAN, ...Object.fromEntries(["known", "fresh"].map(g => [g, byJishin[g].map(c => ({...c, ...Object.fromEntries(["top", "ex1", "tri", "trio"].map(k => [k, {...c[k], roi: c[k].n ? +(c[k].ret / (100 * c[k].n)).toFixed(4) : 0}]))}))]))},
    funa: (() => {
      const one = G => ({...G, ...Object.fromEntries(["b1win", "top", "tri"].map(k => [k, {...G[k], roi: G[k].n ? +(G[k].ret / (100 * G[k].n)).toFixed(4) : 0}]))});
      return {calcFrom: "2026-02-01", siteFrom: funa.siteFrom, calc: funa.calc.map(one), site: funa.site.map(one), cls: funa.cls.map(one)};
    })()
  };
  fs.writeFileSync("backtest.json", JSON.stringify(out));
  const w = out.main.win;
  console.log(`対象 ${N}レース（オッズあり ${oddsRaces}）`);
  console.log(`単勝・期待値${MAIN.ev}以上・確率${MAIN.minP * 100}%以上：${w.n}点 回収率${(w.roi * 100).toFixed(1)}%（95%の範囲 ${(w.lo * 100).toFixed(0)}〜${(w.hi * 100).toFixed(0)}%）`);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("backtest.mjs")) await main();
