// スリットレーダーの記録（GitHub Actions で1日3回：7:50・15:50・23:50）
//
// 見張り（notify.mjs）が締切前に見た単勝オッズは ntfy の「合言葉-odds」に12時間だけ残る。
// それを集めて GitHub のキャッシュ（oddslog/）にためておき、レース結果と照らし合わせて
//   1. 買ったつもりの成績（通知どおりに単勝を100円ずつ買ったら。見送り通知に従った場合と、従わなかった場合）
//   2. 締切前のオッズで「期待値いくつ以上」なら、確定オッズで払い戻されたとき本当にプラスか
//   3. 締切前のオッズが確定オッズでどのくらい動くか
//   4. 締切2分前・1分前・30秒前に「単勝が3連単から見て何倍お得か」で買っていたら（2026-10-19〜）
// を paper.json に書き出す（アプリの「検証」で見られる）。
// 元のオッズはキャッシュにだけ置き、公開リポジトリには集計と買い目の記録だけを置く。
import fs from "node:fs";

const TOPIC = process.env.NTFY_TOPIC;
const NTFY = "https://ntfy.sh";
const DIR = "oddslog";
const LOG = `${DIR}/log.json`;
const KEEP_DAYS = 120;
const BUY_EV = 2.0, BUY_P = 0.10;
// いつのオッズか（締切までの分）：今の通知は1分半前（1.85分以内）で決める
const PHASES = [["t7", 3.6, 99], ["t3", 1.85, 3.6], ["t1", 0.4, 1.85]];
const phaseOf = m => { if (m == null) return null; const p = PHASES.find(([, lo, hi]) => m > lo && m <= hi); return p ? p[0] : null; };
const EVS = [1.5, 2.0, 2.5, 3.0, 4.0];
const BANDS = [[1, 2], [2, 4], [4, 7], [7, 12], [12, 25], [25, 1e9]];

const html = fs.readFileSync("index.html", "utf8");
const a = html.indexOf("/* ---------- 定数 ---------- */");
const b = html.indexOf("/* ---------- 状態 ---------- */");
if (a < 0 || b < 0) throw new Error("index.html から判定コードを見つけられませんでした");
const M = new Function(html.slice(a, b) + "\nreturn {parseV1, slitAlerts, predict, prepStats, DEFAULTS, STADIUMS, hhmm, jstNowDate, formFor: typeof formFor === 'function' ? formFor : null, setMotorEx: typeof setMotorEx === 'function' ? setMotorEx : null, formFromList: typeof formFromList === 'function' ? formFromList : null, boat1Solid: typeof boat1Solid === 'function' ? boat1Solid : null};")();

// モーターの展示の速さ（毎朝 funadata/motor.json に書かれる）も、アプリと同じように予想に入れる
try { if (M.setMotorEx && fs.existsSync("funadata/motor.json")) M.setMotorEx(JSON.parse(fs.readFileSync("funadata/motor.json", "utf8"))); } catch (e){}

const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const ymd = d => [d.slice(0, 4), d.replace(/-/g, "")];
const toMin = hm => { const [h, m, sec] = String(hm).split(":").map(Number); return h * 60 + m + (sec || 0) / 60; };
// 締切直前の記録：単勝オッズと、3連単から出した1着の確率（q）を比べる
const LATE = [["t2", 2], ["t1", 1], ["t05", 0.5]];
const KS = [1.3, 1.5, 2, 3];
const LATE_MAX_IMP = 50;   // 3連単から見て50倍以上の大穴は数えない

async function getJSON(url, fetcher){
  try {
    const r = await fetcher(url, {cache: "no-store"});
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// ntfy から締切前オッズの記録を読む
async function readSnaps(fetcher, runs = []){
  const out = [];
  if (!TOPIC) return out;
  try {
    const r = await fetcher(`${NTFY}/${encodeURIComponent(TOPIC + "-odds")}/json?poll=1&since=12h`);
    if (!r.ok) return out;
    for (const line of (await r.text()).split("\n")){
      try {
        const m = JSON.parse(line);
        if (m.event !== "message") continue;
        const d = JSON.parse(m.message);
        if (d.st) runs.push({d: d.d, at: d.at, ...d.st});
        for (const e of d.r || []) if (e && e.k && e.w){
          const x = {d: d.d, k: e.k, t: e.t || d.at, m: e.m ?? null, w: e.w, p: e.p || null};
          if (e.q) x.q = e.q;
          if (e.u) x.u = e.u;
          out.push(x);
        }
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

const agg = list => {
  const n = list.length, hit = list.filter(x => x.pay > 0).length, ret = list.reduce((s, x) => s + x.pay, 0);
  return {n, hit, ret, roi: n ? +(ret / (100 * n)).toFixed(4) : 0};
};
// 買い目の成績に「確定オッズで見た期待値」と「決めた時→確定のオッズの動き」を足す（確定オッズは翌日に入る）
const aggF = list => {
  const w = list.filter(x => x.fin > 0);
  return {...agg(list), nFin: w.length,
    finEv: w.length ? +(w.reduce((s, x) => s + x.p * x.fin, 0) / w.length).toFixed(3) : null,
    ev: list.length ? +(list.reduce((s, x) => s + x.p * x.od, 0) / list.length).toFixed(3) : null,
    drop: w.length ? +median(w.map(x => x.fin / x.od)).toFixed(3) : null};
};
const median = v => { if (!v.length) return null; const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export async function main({fetcher = fetch, today = M.jstNowDate()} = {}){
  fs.mkdirSync(DIR, {recursive: true});
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : {v: 1, snaps: {}, races: {}};

  // 1. 新しい締切前オッズを足す（同じレース・同じ時刻は1つにまとめる）
  const runs = [];
  const fresh = await readSnaps(fetcher, runs);
  // 見張りの調子（最後の30件）
  log.runs = [...(log.runs || []), ...runs].filter((x, i, a) => a.findIndex(y => y.d === x.d && y.at === x.at) === i).slice(-30);
  let added = 0;
  for (const x of fresh){
    const id = `${x.d}|${x.k}|${x.t}`;
    if (!log.snaps[id]){ log.snaps[id] = x; added++; }
    else if (!log.snaps[id].p && x.p) log.snaps[id] = x;
  }

  // 2. 結果・確定オッズ・（記録に1着率がなければ）予想を、日ごとに足す
  const stats = fs.existsSync("stats.json") ? M.prepStats(JSON.parse(fs.readFileSync("stats.json", "utf8"))) : null;
  const s = {...M.DEFAULTS, w: {...M.DEFAULTS.w}};
  const days = [...new Set(Object.values(log.snaps).map(x => x.d))].sort();
  for (const d of days){
    const keys = new Set(Object.values(log.snaps).filter(x => x.d === d).map(x => x.k));
    const need = [...keys].filter(k => { const R = log.races[`${d}|${k}`]; return !R || (R.pay == null && !R.void) || (R.fin == null && d < today && (R.finTry || 0) < 3); });
    if (!need.length) continue;
    const [y, md] = ymd(d);
    const base = await getJSON(`https://boatraceopenapi.github.io/api/v1/${y}/${md}.json?t=${Date.now()}`, fetcher);
    const tm = d < today ? await getJSON(`https://turnmark.github.io/api/v1/${y}/${md}.json`, fetcher) : null;
    const races = new Map((base ? M.parseV1(base, d) : []).map(r => [r.key, r]));
    const refunds = new Map();
    for (const [sk, S] of Object.entries((base && base.programs && base.programs.stadiums) || {}))
      for (const [rk, X] of Object.entries((S && S.races) || {}))
        if (X && X.result && Array.isArray(X.result.refunds)) refunds.set(`${sk}-${rk}`, X.result.refunds.map(Number));
    const fins = new Map((tm ? M.parseV1(tm, d) : []).filter(r => r.odds).map(r => [r.key, r.odds.win]));
    for (const k of need){
      const id = `${d}|${k}`, r = races.get(k);
      const R = log.races[id] || (log.races[id] = {d, k});
      if (r){
        R.name = `${M.STADIUMS[r.stadium] || ""}${r.no}R`;
        R.close = r.closedAt ? M.hhmm(r.closedAt) : R.close;
        if (r.hasPreview && !R.p){
          if (M.formFor && stats) r.form = M.formFor(r, stats, [...races.values()]);
          const pr = M.predict(r, s, M.slitAlerts(r, s), false, stats);
          R.p = Object.fromEntries(pr.F.map(f => [f.b.no, +f.p1.toFixed(3)]));
        }
        if (r.result && r.result.order.length){
          R.win = r.result.order[0];
          const pw = (r.result.payouts.win || []).find(x => String(x.combination) === String(R.win));
          R.pay = pw ? +pw.amount : 0;
          R.back = refunds.get(k) || [];   // 返還（欠場など）は払戻100円として扱う
        }
      }
      const fw = fins.get(k);
      if (fw) R.fin = Object.fromEntries(Object.entries(fw).map(([no, od]) => [no, +od]));
      else if (tm) R.finTry = (R.finTry || 0) + 1;
      // 2日たっても結果がないレース（中止など）は数えない
      if (R.pay == null && d <= addDays(today, -2)) R.void = true;
    }
  }

  // 1号艇が堅いか（動画6本目の③：当地勝率6.0以上・本節の平均3着以内・展示タイムの見劣りなし）を、結果の出たレースごとに1回だけ決めて残す。
  // 本節の成績は、その日と前の6日の出走表・結果から数える（10/19からの記録にもさかのぼってつける）
  if (M.boat1Solid && M.formFromList){
    const cacheDay = new Map();
    const dayRaces = async d => {
      if (!cacheDay.has(d)){
        const [y, md] = ymd(d);
        const j = await getJSON(`https://boatraceopenapi.github.io/api/v1/${y}/${md}.json?t=${d >= addDays(today, -1) ? Date.now() : 0}`, fetcher);
        cacheDay.set(d, j ? M.parseV1(j, d) : []);
      }
      return cacheDay.get(d);
    };
    const needS1 = [...new Set(Object.values(log.races).filter(R => R.s1 === undefined && R.pay != null && !R.void).map(R => R.d))].sort();
    for (const d of needS1){
      const list = [];
      for (let i = 6; i >= 0; i--) list.push(...await dayRaces(addDays(d, -i)));
      const todays = list.filter(r => r.date === d);
      M.formFromList(list, todays);
      const byKey = new Map(todays.map(r => [r.key, r]));
      for (const R of Object.values(log.races)){
        if (R.d !== d || R.s1 !== undefined || R.pay == null || R.void) continue;
        const r = byKey.get(R.k);
        // 結果は出ているのに出走表・展示がないレースは、決められないので null（次からは読み直さない）
        const s = r && r.hasPreview ? M.boat1Solid(r) : null;
        R.s1 = s ? (s.ok ? 1 : 0) : null;
      }
    }
  }

  // 古い記録を消す
  const cut = addDays(today, -KEEP_DAYS);
  for (const id of Object.keys(log.snaps)) if (log.snaps[id].d < cut) delete log.snaps[id];
  for (const id of Object.keys(log.races)) if (log.races[id].d < cut) delete log.races[id];
  fs.writeFileSync(LOG, JSON.stringify(log));

  // 3. 集計
  const byRace = new Map();
  for (const x of Object.values(log.snaps)){
    const id = `${x.d}|${x.k}`;
    (byRace.get(id) || byRace.set(id, []).get(id)).push(x);
  }
  // 信頼度（その時点の◎の1着率）ごとの実際の成績。アプリの「信頼度」と同じ区切り
  const CONF = [[0.65, "高"], [0.5, "中"], [0.35, "低"], [0, "混戦"]];
  const byConf = Object.fromEntries(["t1", "t3"].map(k => [k, CONF.map(([from, label]) => ({from, label, races: 0, top: [], rec: []}))]));
  const rules = {t1: [], t3: [], t7: []}, points = [], drift = Object.fromEntries(PHASES.map(([k]) => [k, BANDS.map(() => [])]));
  const late = {t2: [], t1: [], t05: [], fin: []}, lateRaces = {t2: 0, t1: 0, t05: 0, fin: 0};
  const b1 = {t2: [], t1: [], t05: [], fin: []};
  for (const [id, list] of byRace){
    const R = log.races[id];
    if (!R || R.pay == null || R.void) continue;   // 結果がまだ（または中止）
    list.sort((x, y) => toMin(x.t) - toMin(y.t));
    for (const x of list){
      if (x.m == null && R.close) x.m = toMin(R.close) - toMin(x.t);
      x.pp = x.p || R.p;
    }
    const payOf = no => R.back && R.back.includes(no) ? 100 : (R.win === no ? R.pay : 0);
    // 期待値ごとの成績（その時点のオッズで選んで、確定オッズで払い戻されたら）
    for (const x of list){
      const phase = x.m > 9 ? null : phaseOf(x.m);
      if (!phase || !x.pp) continue;
      for (const [no, od] of Object.entries(x.w)){
        const p = x.pp[no], n = +no;
        if (!(od > 0) || !(p > 0)) continue;
        points.push({phase, p, ev: p * od, pay: payOf(n), finEv: R.fin && R.fin[no] ? p * R.fin[no] : null});
        if (R.fin && R.fin[no] > 0){
          const bi = BANDS.findIndex(([lo, hi]) => od >= lo && od < hi);
          if (bi >= 0) drift[phase][bi].push(R.fin[no] / od);
        }
      }
    }
    // 締切直前：単勝のオッズ ÷ 3連単から出した単勝のオッズ（還元率75%）＝「何倍お得か」
    {
      const fin = list.find(x => x.q && x.m != null && x.m < 0 && x.u === "締切");
      const finOd = no => fin ? fin.w[no] : R.fin ? R.fin[no] : null;
      const pick = T => {
        let best = null;
        for (const x of list) if (x.q && x.m > 0 && Math.abs(x.m - T) <= 0.35 && (!best || Math.abs(x.m - T) < Math.abs(best.m - T))) best = x;
        return best;
      };
      const put = (key, x) => {
        if (!x) return;
        lateRaces[key]++;
        for (const [no, od] of Object.entries(x.w)){
          const q = x.q[no];
          if (!(od > 0) || !(q > 0)) continue;
          const imp = 0.75 / q;
          if (imp >= LATE_MAX_IMP) continue;
          const fo = finOd(no);
          late[key].push({d: R.d, gap: od / imp, od, pay: payOf(+no), fin: fo > 0 ? fo : null,
            finGap: fin && fin.q && fin.q[no] > 0 && fin.w[no] > 0 ? fin.w[no] * fin.q[no] / 0.75 : null});
        }
      };
      for (const [key, T] of LATE) put(key, pick(T));
      put("fin", fin);
    }
    // 1号艇の単勝：締切前に見えた1号艇の単勝オッズの帯で分ける（動画6本目の③「1号艇が堅い」かどうか別）。
    // 確定オッズで分けると「1号艇が堅い」ときは1.3〜3.0倍で102%（2〜10月）だったので、買う前に見えるオッズでも同じかを確かめる
    {
      const pickW = T => {
        let best = null;
        for (const x of list) if (x.w && +x.w["1"] > 0 && x.m > 0 && Math.abs(x.m - T) <= 0.35 && (!best || Math.abs(x.m - T) < Math.abs(best.m - T))) best = x;
        return best;
      };
      const fo = R.fin && +R.fin["1"] > 0 ? +R.fin["1"] : null;
      for (const [key, T] of LATE){
        const x = pickW(T);
        if (x) b1[key].push({d: R.d, od: +x.w["1"], pay: payOf(1), s1: R.s1, fin: fo});
      }
      if (fo) b1.fin.push({d: R.d, od: fo, pay: payOf(1), s1: R.s1, fin: fo});
    }
    const meets = (x, no) => x.pp && x.pp[no] >= BUY_P && x.w[no] > 0 && x.pp[no] * x.w[no] >= BUY_EV;
    const boatsOf = x => x ? Object.keys(x.w).filter(no => meets(x, no)).map(Number) : [];
    const mk = (x, no, extra = {}) => ({d: R.d, k: R.k, name: R.name || R.k, close: R.close || "", t: x.t, m: x.m, no, p: x.pp[no], od: x.w[no],
      fin: R.fin ? R.fin[no] ?? null : null, pay: payOf(no), ...extra});
    // それぞれの時点の最初のオッズで決めたら（t1 が今の通知＝1分半前、t3 は3分前、t7 は7分前）
    for (const [k] of PHASES){
      const x = list.find(y => y.pp && phaseOf(y.m) === k);
      for (const no of boatsOf(x)) rules[k].push(mk(x, no));
      if (x && byConf[k]){
        const [topNo, topP] = Object.entries(x.pp).map(([no, p]) => [+no, +p]).sort((a, b) => b[1] - a[1])[0];
        const C = byConf[k][CONF.findIndex(([t]) => topP >= t)];
        C.races++;
        C.top.push({pay: payOf(topNo)});
        for (const no of boatsOf(x)) C.rec.push({pay: payOf(no)});
      }
    }
  }
  for (const k in rules) rules[k].sort((x, y) => (x.d + x.close).localeCompare(y.d + y.close) || x.no - y.no);
  const follow = rules.t1;
  const bets = rules.t1.length ? rules.t1 : rules.t3;
  const dayList = [...new Set([...rules.t1, ...rules.t3, ...rules.t7].map(x => x.d))].sort()
    .map(d => ({d, ...agg(follow.filter(x => x.d === d)), t3: agg(rules.t3.filter(x => x.d === d)), early: agg(rules.t7.filter(x => x.d === d))}));
  const calib = phase => EVS.map(ev => {
    const sel = points.filter(x => x.phase === phase && x.p >= BUY_P && x.ev >= ev);
    const fe = sel.map(x => x.finEv).filter(v => v != null);
    return {ev, ...agg(sel), finEv: fe.length ? +(fe.reduce((s, v) => s + v, 0) / fe.length).toFixed(3) : null};
  });
  const lateSum = list => KS.map(k => {
    const sel = list.filter(b => b.gap >= k);
    const f = sel.filter(b => b.fin > 0), g = sel.map(b => b.finGap).filter(v => v != null);
    return {k, ...agg(sel), drop: f.length ? +median(f.map(b => b.fin / b.od)).toFixed(3) : null, finGap: g.length ? +median(g).toFixed(3) : null};
  });
  const lateDays = [...new Set(late.t05.map(b => b.d))].sort().slice(-30).map(d => ({d, t1: agg(late.t1.filter(b => b.d === d && b.gap >= 1.5)), t05: agg(late.t05.filter(b => b.d === d && b.gap >= 1.5))}));
  const B1BANDS = [[1, 1.3], [1.3, 1.6], [1.6, 2], [2, 3], [3, 5], [5, 1e9]];
  const b1Split = sel => ({all: agg(sel), solid: agg(sel.filter(x => x.s1 === 1)), other: agg(sel.filter(x => x.s1 === 0))});
  const b1Sum = list => ({
    bands: B1BANDS.map(([lo, hi]) => ({lo, hi: hi > 1e8 ? null : hi, ...b1Split(list.filter(x => x.od >= lo && x.od < hi))})),
    over: [1.3, 1.6, 2].map(lo => ({lo, ...b1Split(list.filter(x => x.od >= lo))})),
    drop: (() => { const f = list.filter(x => x.fin > 0 && x.od > 0); return f.length ? +median(f.map(x => x.fin / x.od)).toFixed(3) : null; })()
  });
  const b1From = [...b1.t1, ...b1.fin].map(x => x.d).sort()[0] || null;
  const out = {
    v: 1, built: new Date().toISOString(), today,
    from: days[0] || null, to: days[days.length - 1] || null,
    rule: {ev: BUY_EV, minP: BUY_P},
    paper: {follow: aggF(follow), t3: aggF(rules.t3), early: aggF(rules.t7)},
    betsRule: rules.t1.length ? "t1" : "t3",
    byConf: Object.fromEntries(Object.entries(byConf).map(([k, list]) => [k, list.map(c => ({from: c.from, label: c.label, races: c.races, top: agg(c.top), rec: agg(c.rec)}))])),
    diag: {runs: (log.runs || []).slice(-10), byDay: Object.fromEntries([...new Set(Object.values(log.snaps).map(x => x.d))].sort().slice(-7).map(d => {
      const v = Object.values(log.snaps).filter(x => x.d === d);
      return [d, {snaps: v.length, tri: v.filter(x => x.q).length, fin: v.filter(x => x.u === "締切").length}];
    }))},
    late: {K: KS, maxImp: LATE_MAX_IMP, races: lateRaces, sum: Object.fromEntries(Object.entries(late).map(([k, list]) => [k, lateSum(list)])), days: lateDays},
    b1: {from: b1From, races: Object.fromEntries(Object.entries(b1).map(([k, v]) => [k, v.length])), solidRaces: Object.fromEntries(Object.entries(b1).map(([k, v]) => [k, v.filter(x => x.s1 === 1).length])),
      sum: Object.fromEntries(Object.entries(b1).map(([k, v]) => [k, b1Sum(v)]))},
    days: dayList.slice(-30),
    bets: bets.slice(-150),
    calib: Object.fromEntries(PHASES.map(([k]) => [k, calib(k)])),
    drift: Object.fromEntries(PHASES.map(([k]) => [k, BANDS.map(([lo, hi], i) => ({lo, hi: hi > 1e8 ? null : hi, n: drift[k][i].length, med: median(drift[k][i])}))]))
  };
  fs.writeFileSync("paper.json", JSON.stringify(out));
  console.log(`締切前オッズ：新しく${added}件（全${Object.keys(log.snaps).length}件）、結果のわかったレース${[...byRace.keys()].filter(id => log.races[id] && log.races[id].pay != null && !log.races[id].void).length}件`);
  const P = a => `${a.n}点 回収率${(a.roi * 100).toFixed(1)}%`;
  console.log(`買ったつもり：1分前で決める ${P(out.paper.follow)}｜3分前 ${P(out.paper.t3)}｜7分前 ${P(out.paper.early)}`);
  const L = out.late.sum;
  console.log(`締切直前のズレ1.5倍以上：2分前 ${P(L.t2[1])}｜1分前 ${P(L.t1[1])}｜30秒前 ${P(L.t05[1])}｜締切時（参考） ${P(L.fin[1])}`);
  const B = out.b1.sum;
  console.log(`1号艇の単勝（1.6倍以上・1号艇が堅い）：1分前 ${P(B.t1.over[1].solid)}｜30秒前 ${P(B.t05.over[1].solid)}｜確定（参考） ${P(B.fin.over[1].solid)}`);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("record.mjs")) await main();
