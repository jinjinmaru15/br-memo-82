// スリットレーダーの見張り（GitHub Actions・記録だけ。通知はしない）
//
// watch.yml から LOOP_MINUTES=55 で起動すると、55分間見続けて、次の実行に引き継ぐ。
//
// 締切前と締切直後に公式サイトのオッズを読んで、合言葉-odds のトピックに5分おきにまとめて送る
// （アプリが読み、record.mjs が1日3回キャッシュにためて集計する。ntfy は12時間で消える）
//   締切7分前・3分半前：単勝だけ
//   締切2分前・1分前・30秒前：単勝と3連単
//   締切2分後：締切時の単勝と3連単（まだ締切時になっていなければ2分後にもう一度）
// 3連単は投票が多く締切前でもほぼ動かないので、そこから「本当の1着の確率」を出し、
// 投票が少なくてブレる単勝のオッズと比べる。確定オッズでは、単勝が3連単から見て1.5倍以上お得な艇を
// 買うと回収率が150%近くあった。それが締切の何秒前まで見えるかを確かめるための記録。
//
// 通知（予告・買い・見送り・スリットアラート）は 2026-10-19 に止めた。
// 締切前の単勝オッズは投票が少なく当てにならず、買う前に見えるオッズで検証すると回収率は約70%だったため。
//
// 予想の計算は index.html の中のコードをそのまま使う（記録に各艇の1着率も付ける）。
import fs from "node:fs";

const TOPIC = process.env.NTFY_TOPIC;
const NTFY = "https://ntfy.sh";
// 締切まで何分のときに読むか（マイナスは締切後）。tri は3連単も読む。win は「何分前まで遅れても読むか」
const TARGETS = [
  {m: 7, tri: false, win: 3.6},
  {m: 3.5, tri: false, win: 2.2},
  {m: 2, tri: true, win: 0.35},
  {m: 1, tri: true, win: 0.3},
  {m: 0.5, tri: true, win: 0.3},
  {m: -2, tri: true, win: 6, fin: true}
];
const API_EVERY = 2 * 60e3;      // レースデータを取り直す間隔
const ODDS_PUB_EVERY = 5 * 60e3; // オッズを送る間隔（ntfy は1日250通まで）
const GAP = 1000;                // 公式サイトへは1秒に1回まで
const LOOP_MIN = +(process.env.LOOP_MINUTES || 0);

const html = fs.readFileSync("index.html", "utf8");
const a = html.indexOf("/* ---------- 定数 ---------- */");
const b = html.indexOf("/* ---------- 状態 ---------- */");
if (a < 0 || b < 0) throw new Error("index.html から判定コードを見つけられませんでした");
const M = new Function(html.slice(a, b) + "\nreturn {parseV1, slitAlerts, predict, prepStats, DEFAULTS, STADIUMS, jstNowDate, hhmm, formFor: typeof formFor === 'function' ? formFor : null, setMotorEx: typeof setMotorEx === 'function' ? setMotorEx : null};")();

// モーターの展示の速さ（毎朝 funadata/motor.json に書かれる）も、アプリと同じように予想に入れる
try { if (M.setMotorEx && fs.existsSync("funadata/motor.json")) M.setMotorEx(JSON.parse(fs.readFileSync("funadata/motor.json", "utf8"))); } catch (e){}

async function publish(title, message, priority, topic){
  try {
    const r = await fetch(NTFY, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({topic, title, message, priority})});
    if (!r.ok){ console.log(`ntfy への送信に失敗（${title}）: HTTP ${r.status}`); return false; }
    return true;
  } catch (e){ console.log(`ntfy への送信に失敗（${title}）: ${e.message}`); return false; }
}

const cellText = s => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").replace(/\s+/g, "");
// ページ上の「オッズ更新時間 12:02」か「締切時オッズ」
export function oddsTime(page){
  const m = String(page || "").match(/class="tab4_time"[^>]*>([\s\S]*?)<\//);
  if (!m) return null;
  const t = cellText(m[1]);
  if (t.includes("締切時")) return "締切";
  const hm = t.match(/(\d{1,2}):(\d{2})/);
  return hm ? `${hm[1].padStart(2, "0")}:${hm[2]}` : null;
}

// 公式「単勝・複勝オッズ」ページから単勝オッズだけを取り出す
// 1つ目の grid_unit が単勝の表。各行の1列目が艇番、3列目がオッズ。
export function parseWinOdds(page){
  if (!page || page.includes("該当レースは中止")) return null;
  const parts = page.split(/class="[^"]*\bgrid_unit\b[^"]*"/);
  if (parts.length < 2) return null;
  const out = new Map();
  for (const tr of parts[1].match(/<tr[\s\S]*?<\/tr>/g) || []){
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => cellText(m[1]));
    if (tds.length < 3) continue;
    const no = parseInt(tds[0], 10);
    const od = parseFloat(tds[2]);
    if (no >= 1 && no <= 6 && od > 0) out.set(no, od);
  }
  return out.size ? out : null;
}

// 公式「3連単オッズ」ページ。表は20行×6列：列が1着（1〜6号艇）、
// 行は「2着＝残りの艇の小さい順に4行ずつ、3着＝その残りの小さい順」
export function parseTrifecta(page){
  if (!page || page.includes("該当レースは中止")) return null;
  const i = page.indexOf("3連単オッズ");
  const body = page.slice(i >= 0 ? i : 0).match(/<tbody[\s\S]*?<\/tbody>/);
  if (!body) return null;
  const rows = body[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
  if (rows.length < 20) return null;
  const out = {};
  let n = 0;
  rows.slice(0, 20).forEach((tr, r) => {
    const cells = [...tr.matchAll(/<td[^>]*class="oddsPoint[^"]*"[^>]*>([\s\S]*?)<\/td>/g)].map(m => parseFloat(cellText(m[1])));
    if (cells.length !== 6) return;
    cells.forEach((od, g) => {
      const first = g + 1, others = [1, 2, 3, 4, 5, 6].filter(x => x !== first);
      const second = others[Math.floor(r / 4)], third = others.filter(x => x !== second)[r % 4];
      if (od > 0){ out[`${first}${second}${third}`] = od; n++; }
    });
  });
  return n >= 20 ? out : null;
}

// 3連単オッズから「買う人たちが見ている1着の確率」
export function winProbFromTri(tri){
  if (!tri) return null;
  const q = {}; let tot = 0;
  for (const [k, od] of Object.entries(tri)){ const v = 1 / od; q[k[0]] = (q[k[0]] || 0) + v; tot += v; }
  if (!tot) return null;
  return Object.fromEntries(Object.entries(q).map(([no, v]) => [no, +(v / tot).toFixed(4)]));
}

export async function main({now: clock = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms))} = {}){
  if (!TOPIC){ console.log("NTFY_TOPIC が設定されていません"); return; }
  // 古い notify.yml の定期実行は何もしない（watch.yml が見張る）
  if (!LOOP_MIN){ console.log("LOOP_MINUTES がないので何もしません（watch.yml が見張っています）"); return; }

  const today = M.jstNowDate();
  const stats = fs.existsSync("stats.json") ? M.prepStats(JSON.parse(fs.readFileSync("stats.json", "utf8"))) : null;
  const s = {...M.DEFAULTS, w: {...M.DEFAULTS.w}};
  const done = new Map();      // レース → 読み終えた時点の番号
  const pending = [];
  const t0 = clock();
  let races = null, lastApi = -Infinity, lastPub = t0, lastFetch = -Infinity;
  let pages = 0, pagesOK = 0, snaps = 0, oddsMsgs = 0, triOK = 0, lastErr = "";

  const wait = async ms => { if (ms > 0) await sleep(ms); };
  const hms = t => new Date(t + 9 * 3600e3).toISOString().slice(11, 19);

  async function loadRaces(){
    try {
      // GitHub Pages は10分ほどキャッシュされるので、毎回ちがう URL にして最新を取る
      const res = await fetch(`https://boatraceopenapi.github.io/api/v1/${today.slice(0, 4)}/${today.replace(/-/g, "")}.json?t=${Math.floor(clock() / 60000)}`, {cache: "no-store"});
      if (!res.ok){ console.log("今日のデータがありません:", res.status); return null; }
      return M.parseV1(await res.json(), today).sort((x, y) => x.closedAt - y.closedAt);
    } catch (e){ console.log("レースデータを読めませんでした:", e.message); return null; }
  }

  async function getPage(kind, r){
    const url = `https://www.boatrace.jp/owpc/pc/race/${kind}?rno=${r.no}&jcd=${String(r.stadium).padStart(2, "0")}&hd=${r.date.replace(/-/g, "")}`;
    await wait(lastFetch + GAP - clock());
    lastFetch = clock();
    pages++;
    try {
      // 前の見張り（10/19昼まで動いていた）と同じ頼み方にする。応答が遅くても25秒までは待つ
      const res = await fetch(url, {headers: {"Accept-Language": "ja"}, signal: AbortSignal.timeout(25000)});
      if (!res.ok){ lastErr = `HTTP ${res.status}`; console.log("公式サイト:", res.status, url); return null; }
      const text = await res.text();
      pagesOK++;
      return text;
    } catch (e){ lastErr = String(e.message || e).slice(0, 80); console.log("公式サイトを読めませんでした:", e.message); return null; }
  }

  // 見張りの調子（record.mjs が paper.json に残す。動いているかを確かめるため）
  const status = () => ({v: "late1", pages, ok: pagesOK, snaps, tri: triOK, err: lastErr || undefined, races: races ? races.length : 0});
  async function flushOdds(force = false){
    if (!pending.length && !force) return;
    // 1通4096バイトまでなので小分けにする
    let chunk = [];
    const send = async (always = false) => {
      if (!chunk.length && !always) return;
      if (await publish("odds", JSON.stringify({d: today, at: M.hhmm(new Date(clock())), r: chunk, st: status()}), 1, TOPIC + "-odds")) oddsMsgs++;
      chunk = [];
    };
    for (const e of pending.splice(0)){
      chunk.push(e);
      if (JSON.stringify(chunk).length > 3200){ chunk.pop(); await send(); chunk.push(e); }
    }
    await send(force);
    lastPub = clock();
  }

  // 今読むべきもの：締切が近いほど先に（締切後の分は最後）
  function nextJob(){
    const now = clock(), out = [];
    for (const r of races || []){
      if (!r.closedAt) continue;
      const left = (r.closedAt - now) / 60000;
      const st = done.get(r.key) || {i: 0, retry: 0, wait: 0};
      done.set(r.key, st);
      if (st.wait && now < st.wait) continue;
      while (st.i < TARGETS.length){
        const T = TARGETS[st.i];
        if (left > T.m) break;
        if (left < T.m - T.win){ st.i++; st.retry = 0; continue; }   // 間に合わなかった
        out.push({r, T, st});
        break;
      }
    }
    out.sort((x, y) => (x.T.fin ? 1 : 0) - (y.T.fin ? 1 : 0) || x.T.m - y.T.m || x.r.closedAt - y.r.closedAt);
    return out[0] || null;
  }
  // 次に何かを読むべき時刻
  function nextAt(){
    let best = Infinity;
    for (const r of races || []){
      if (!r.closedAt) continue;
      const st = done.get(r.key) || {i: 0, wait: 0};
      const T = TARGETS[st.i];
      if (T) best = Math.min(best, Math.max(r.closedAt - T.m * 60000, st.wait || 0));
    }
    return best;
  }

  async function snap({r, T, st}){
    const left = (r.closedAt - clock()) / 60000;
    const wp = await getPage("oddstf", r);
    const w = parseWinOdds(wp), u = oddsTime(wp);
    // 締切後に読んで、まだ締切時のオッズになっていなければ1分半後にもう一度（2回まで）
    if (T.fin && u !== "締切" && st.retry < 2){ st.retry++; st.wait = clock() + 90e3; return; }
    let q = null, uq = null;
    if (T.tri){
      const tp = await getPage("odds3t", r);
      q = winProbFromTri(parseTrifecta(tp)); uq = oddsTime(tp);
      if (q) triOK++;
    }
    st.i++; st.retry = 0; st.wait = 0;
    if (!w) return;
    const e = {k: r.key, w: Object.fromEntries(w), t: hms(clock()), m: +left.toFixed(2)};
    if (r.hasPreview){
      if (M.formFor && stats && !r.form) r.form = M.formFor(r, stats, races);
      const pr = M.predict(r, s, M.slitAlerts(r, s), false, stats);
      e.p = Object.fromEntries(pr.F.map(f => [f.b.no, +f.p1.toFixed(3)]));
    }
    if (u) e.u = u;
    if (q){ e.q = q; if (uq && uq !== u) e.uq = uq; }
    pending.push(e);
    snaps++;
  }

  while (true){
    if (clock() - lastApi >= API_EVERY){
      const x = await loadRaces();
      if (x) races = x;   // どこまで読んだかはレースの番号ごとに覚えているので、読み直しても続きから
      lastApi = clock();
    }
    // 1件ずつ、そのつど一番急ぐものを選んで読む
    for (let job; (job = nextJob()); ) await snap(job);
    if (clock() - lastPub >= ODDS_PUB_EVERY){ await flushOdds(); console.log(`${hms(clock())} 公式サイト ${pagesOK}/${pages}・記録 ${snaps}件（3連単 ${triOK}）${lastErr ? "・最後のエラー " + lastErr : ""}`); }

    const allDone = races && races.length && races.every(r => !r.closedAt || +r.closedAt + 8 * 60e3 <= clock());
    if (allDone){ console.log("今日のレースは全部終わりました"); break; }
    if (clock() - t0 >= LOOP_MIN * 60e3) break;
    // 次に読む時刻まで待つ（最長20秒）
    const until = Math.min(nextAt(), lastApi + API_EVERY, lastPub + ODDS_PUB_EVERY, t0 + LOOP_MIN * 60e3);
    await wait(Math.max(300, Math.min(20e3, until - clock())));
  }
  await flushOdds(true);
  console.log(`公式サイト ${pages}ページ（取得 ${pagesOK}）、記録 ${snaps}件（3連単あり ${triOK}）、送信 ${oddsMsgs}通`);
}

if (process.argv[1] && process.argv[1].endsWith("notify.mjs")) await main();
