// スリットレーダーの記録（GitHub Actions で1日3回：7:50・15:50・23:50）
//
// 見張り（notify.mjs）が締切前に見た単勝オッズは ntfy の「合言葉-odds」に12時間だけ残る。
// それを集めて GitHub のキャッシュ（oddslog/）にためておき、レース結果と照らし合わせて
//   1. 買ったつもりの成績（通知どおりに単勝を100円ずつ買ったら。見送り通知に従った場合と、従わなかった場合）
//   2. 締切前のオッズで「期待値いくつ以上」なら、確定オッズで払い戻されたとき本当にプラスか
//   3. 締切前のオッズが確定オッズでどのくらい動くか
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
const M = new Function(html.slice(a, b) + "\nreturn {parseV1, slitAlerts, predict, prepStats, DEFAULTS, STADIUMS, hhmm, jstNowDate};")();

const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const ymd = d => [d.slice(0, 4), d.replace(/-/g, "")];
const toMin = hm => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };

async function getJSON(url, fetcher){
  try {
    const r = await fetcher(url, {cache: "no-store"});
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// ntfy から締切前オッズの記録を読む
async function readSnaps(fetcher){
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
        for (const e of d.r || []) if (e && e.k && e.w) out.push({d: d.d, k: e.k, t: e.t || d.at, m: e.m ?? null, w: e.w, p: e.p || null});
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
  const fresh = await readSnaps(fetcher);
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
  const rules = {t1: [], t3: [], t7: []}, points = [], drift = Object.fromEntries(PHASES.map(([k]) => [k, BANDS.map(() => [])]));
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
    const meets = (x, no) => x.pp && x.pp[no] >= BUY_P && x.w[no] > 0 && x.pp[no] * x.w[no] >= BUY_EV;
    const boatsOf = x => x ? Object.keys(x.w).filter(no => meets(x, no)).map(Number) : [];
    const mk = (x, no, extra = {}) => ({d: R.d, k: R.k, name: R.name || R.k, close: R.close || "", t: x.t, m: x.m, no, p: x.pp[no], od: x.w[no],
      fin: R.fin ? R.fin[no] ?? null : null, pay: payOf(no), ...extra});
    // それぞれの時点の最初のオッズで決めたら（t1 が今の通知＝1分半前、t3 は3分前、t7 は7分前）
    for (const [k] of PHASES){
      const x = list.find(y => y.pp && phaseOf(y.m) === k);
      for (const no of boatsOf(x)) rules[k].push(mk(x, no));
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
  const out = {
    v: 1, built: new Date().toISOString(), today,
    from: days[0] || null, to: days[days.length - 1] || null,
    rule: {ev: BUY_EV, minP: BUY_P},
    paper: {follow: aggF(follow), t3: aggF(rules.t3), early: aggF(rules.t7)},
    betsRule: rules.t1.length ? "t1" : "t3",
    days: dayList.slice(-30),
    bets: bets.slice(-150),
    calib: Object.fromEntries(PHASES.map(([k]) => [k, calib(k)])),
    drift: Object.fromEntries(PHASES.map(([k]) => [k, BANDS.map(([lo, hi], i) => ({lo, hi: hi > 1e8 ? null : hi, n: drift[k][i].length, med: median(drift[k][i])}))]))
  };
  fs.writeFileSync("paper.json", JSON.stringify(out));
  console.log(`締切前オッズ：新しく${added}件（全${Object.keys(log.snaps).length}件）、結果のわかったレース${[...byRace.keys()].filter(id => log.races[id] && log.races[id].pay != null && !log.races[id].void).length}件`);
  const P = a => `${a.n}点 回収率${(a.roi * 100).toFixed(1)}%`;
  console.log(`買ったつもり：1分半前で決める ${P(out.paper.follow)}｜3分前 ${P(out.paper.t3)}｜7分前 ${P(out.paper.early)}`);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("record.mjs")) await main();
