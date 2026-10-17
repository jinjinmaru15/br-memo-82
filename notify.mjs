// スリットレーダーの見張り（GitHub Actions）
//
// watch.yml から LOOP_MINUTES=55 で起動すると、55分間ずっと1分おきに見続ける。
// （GitHub の定期実行は「5分おき」にしても実際は20〜40分おきなので、
//   1回の実行で長く見張って、次の実行に引き継ぐ）
//
// 1. 買い候補：締切7分前ごろに公式サイトの単勝オッズを見て、
//    「1着率10%以上・期待値2.0以上」の艇があれば通知する（1レース1回）
//    締切3分前ごろにもう一度見て、買いラインを下回っていたら「見送り」を通知する
//    （7分前は条件外だったのが3分前に条件を満たしたら、そこで買い候補を通知する）
// 2. スリットアラート強：締切40分以内で「強」が出たら通知する
// 3. 見た単勝オッズは 合言葉-odds のトピックに3分おきにまとめて送り、アプリが読む
//    （公開リポジトリには保存しない。ntfy は12時間で消える）
//
// 予想の計算は index.html の中のコードをそのまま使う（アプリと同じ判定になる）。
import fs from "node:fs";

const TOPIC = process.env.NTFY_TOPIC;
const NTFY = "https://ntfy.sh";
const BUY_EV = 2.0;            // 買い候補：期待値
const BUY_P = 0.10;            // 買い候補：1着率
const FIRST = 7;               // 締切まで何分で1回目のオッズを見るか
const FINAL = 3;               // 締切まで何分で2回目（直前）のオッズを見るか
const LAST = 1;                // 締切まで1分を切ったら見ない
const ALERT_WINDOW = 40;       // スリットアラートを見る範囲（分）
const STEP = 60e3;             // 見張りの間隔
const API_EVERY = 2 * 60e3;    // レースデータを取り直す間隔
const ODDS_PUB_EVERY = 3 * 60e3; // アプリ用オッズを送る間隔（ntfy は1日の通数に上限がある）
const LOOP_MIN = +(process.env.LOOP_MINUTES || 0);

const html = fs.readFileSync("index.html", "utf8");
const a = html.indexOf("/* ---------- 定数 ---------- */");
const b = html.indexOf("/* ---------- 状態 ---------- */");
if (a < 0 || b < 0) throw new Error("index.html から判定コードを見つけられませんでした");
const M = new Function(html.slice(a, b) + "\nreturn {parseV1, slitAlerts, predict, prepStats, DEFAULTS, STADIUMS, TECHS, jstNowDate, hhmm};")();

const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥"];
const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "/").split("/");
const site = owner && repo ? `https://${owner}.github.io/${repo}/` : undefined;
const isTest = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const line = p => Math.ceil(BUY_EV / p * 10) / 10;
const circ = s => [...String(s)].map(ch => CIRCLED.indexOf(ch)).filter(n => n > 0);

async function publish(title, message, priority = 4, topic = TOPIC, extra = {}){
  const body = {topic, title, message, priority, ...extra};
  if (topic === TOPIC){ body.tags = ["motorboat"]; if (site) body.click = site; }
  try {
    const r = await fetch(NTFY, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    if (!r.ok){ console.log(`ntfy への送信に失敗（${title}）: HTTP ${r.status}`); return false; }
    return true;
  } catch (e){ console.log(`ntfy への送信に失敗（${title}）: ${e.message}`); return false; }
}

// 今日すでに送った通知を ntfy から確認（タイトルの最初の語 → タイトル全体）
async function sentKeys(today){
  const out = new Map();
  try {
    const r = await fetch(`${NTFY}/${TOPIC}/json?poll=1&since=all`);
    for (const l of (await r.text()).split("\n")){
      try {
        const m = JSON.parse(l);
        if (m.event !== "message" || !m.title) continue;
        const d = new Date(m.time * 1000 + 9 * 3600e3).toISOString().slice(0, 10);
        if (d === today) out.set(m.title.split(" ")[0], m.title);
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

// 公式「単勝・複勝オッズ」ページから単勝オッズだけを取り出す
// 1つ目の grid_unit が単勝の表。各行の1列目が艇番、3列目がオッズ。
export function parseWinOdds(page){
  if (!page || page.includes("該当レースは中止")) return null;
  const parts = page.split(/class="[^"]*\bgrid_unit\b[^"]*"/);
  if (parts.length < 2) return null;
  const out = new Map();
  for (const tr of parts[1].match(/<tr[\s\S]*?<\/tr>/g) || []){
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").replace(/\s+/g, ""));
    if (tds.length < 3) continue;
    const no = parseInt(tds[0], 10);
    const od = parseFloat(tds[2]);
    if (no >= 1 && no <= 6 && od > 0) out.set(no, od);
  }
  return out.size ? out : null;
}

export async function main({now: clock = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms))} = {}){
  if (!TOPIC){ console.log("NTFY_TOPIC が設定されていません"); return; }
  // 長く見張る watch.yml があるなら、古い notify.yml の定期実行は何もしない
  if (!LOOP_MIN && !isTest && fs.existsSync(".github/workflows/watch.yml")){
    console.log("watch.yml が見張っているので、ここでは何もしません");
    return;
  }

  const today = M.jstNowDate();
  const stats = fs.existsSync("stats.json") ? M.prepStats(JSON.parse(fs.readFileSync("stats.json", "utf8"))) : null;
  const s = {...M.DEFAULTS, w: {...M.DEFAULTS.w}};
  const sent = await sentKeys(today);
  const seen = new Map();          // レースごと：オッズを見た回数・時刻・失敗回数
  const pending = new Map();       // まだアプリ用に送っていないオッズ
  const firstWin = LOOP_MIN ? FIRST : 16;   // 1回だけの実行なら広めに見る
  const t0 = clock();
  let races = null, lastApi = -Infinity, lastPub = t0, lastFetch = -Infinity;
  let buys = 0, skips = 0, alertsSent = 0, checked = 0, oddsOK = 0, oddsMsgs = 0, rounds = 0;
  let testNote = null;

  const wait = async ms => { if (ms > 0) await sleep(ms); };

  async function loadRaces(){
    try {
      // GitHub Pages は10分ほどキャッシュされるので、毎回ちがう URL にして最新を取る
      const res = await fetch(`https://boatraceopenapi.github.io/api/v1/${today.slice(0, 4)}/${today.replace(/-/g, "")}.json?t=${Math.floor(clock() / 60000)}`, {cache: "no-store"});
      if (!res.ok){ console.log("今日のデータがありません:", res.status); return null; }
      return M.parseV1(await res.json(), today).sort((x, y) => x.closedAt - y.closedAt);
    } catch (e){ console.log("レースデータを読めませんでした:", e.message); return null; }
  }

  async function fetchWinOdds(r){
    const url = `https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${r.no}&jcd=${String(r.stadium).padStart(2, "0")}&hd=${r.date.replace(/-/g, "")}`;
    await wait(lastFetch + 1000 - clock());   // 公式サイトへは1秒に1回まで
    lastFetch = clock();
    try {
      const res = await fetch(url, {headers: {"Accept-Language": "ja"}});
      if (!res.ok){ console.log("公式サイト:", res.status, url); return null; }
      return parseWinOdds(await res.text());
    } catch (e){ console.log("公式サイトを読めませんでした:", e.message); return null; }
  }

  async function flushOdds(){
    if (!pending.size) return;
    // 1通4096バイトまでなので小分けにする
    const list = [...pending.entries()].map(([k, v]) => ({k, w: v.w, t: v.t}));
    let chunk = [];
    const send = async () => {
      if (!chunk.length) return;
      if (await publish("odds", JSON.stringify({d: today, at: M.hhmm(new Date(clock())), r: chunk}), 1, TOPIC + "-odds")) oddsMsgs++;
      chunk = [];
    };
    for (const e of list){
      chunk.push(e);
      if (JSON.stringify(chunk).length > 3300){ chunk.pop(); await send(); chunk.push(e); }
    }
    await send();
    pending.clear();
    lastPub = clock();
  }

  const buyOf = (pr, odds) => pr.F
    .filter(f => f.p1 >= BUY_P && odds.get(f.b.no) && f.p1 * odds.get(f.b.no) >= BUY_EV)
    .sort((x, y) => y.p1 * odds.get(y.b.no) - x.p1 * odds.get(x.b.no));

  async function checkRace(r, pr, name, left){
    const st = seen.get(r.key) || {n: 0, last: 0, fail: 0};
    seen.set(r.key, st);
    const odds = await fetchWinOdds(r);
    checked++;
    if (!odds){
      if (++st.fail >= 3){ st.n++; st.fail = 0; st.last = clock(); }
      return;
    }
    oddsOK++;
    st.n++; st.fail = 0; st.last = clock();
    const at = M.hhmm(new Date(clock()));
    pending.set(r.key, {w: Object.fromEntries(odds), t: at});
    const mins = Math.max(1, Math.round(left));
    const head = `締切 ${M.hhmm(r.closedAt)}（あと${mins}分）・${at}時点のオッズ`;
    const byNo = new Map(pr.F.map(f => [f.b.no, f]));
    const buy = buyOf(pr, odds);
    const sentTitle = sent.get(name + "買い");

    // 買い候補（まだ送っていなければ）
    if (!sentTitle && buy.length){
      const lines = [head];
      for (const f of buy){
        const od = odds.get(f.b.no);
        lines.push(`${CIRCLED[f.b.no]} ${f.b.name}（${f.b.cls}）単勝${od.toFixed(1)}倍・1着率${Math.round(f.p1 * 100)}%・期待値${(f.p1 * od).toFixed(2)}`);
        lines.push(`　買いライン${line(f.p1).toFixed(1)}倍以上`);
      }
      const title = `${name}買い ${buy.map(f => CIRCLED[f.b.no]).join("")}単勝`;
      if (await publish(title, lines.join("\n"), 4)){ sent.set(name + "買い", title); buys++; console.log("買い候補:", name, buy.map(f => f.b.no).join(",")); }
      return;
    }

    // 直前に見直して、送った艇がどれも買いラインを割っていたら見送り
    if (sentTitle && left <= FINAL + 0.5 && !sent.has(name + "見送り")){
      const boats = circ(sentTitle.split(" ").slice(1).join(" "));
      if (!boats.length || boats.some(no => buy.some(f => f.b.no === no))) return;
      const lines = [head];
      for (const no of boats){
        const f = byNo.get(no), od = odds.get(no);
        if (!f) continue;
        lines.push(`${CIRCLED[no]} 単勝${od ? od.toFixed(1) + "倍" : "なし"}（買いライン${line(f.p1).toFixed(1)}倍）${od ? `・期待値${(f.p1 * od).toFixed(2)}` : ""}`);
      }
      lines.push("オッズが下がって買いラインを割りました。まだ買っていなければ見送り。");
      const title = `${name}見送り ${boats.map(no => CIRCLED[no]).join("")}`;
      if (await publish(title, lines.join("\n"), 4)){ sent.set(name + "見送り", title); skips++; console.log("見送り:", name); }
    }
  }

  async function round(){
    const now = clock();
    for (const r of races){
      if (!r.closedAt) continue;
      const left = (r.closedAt - now) / 60000;
      if (left <= LAST || !r.hasPreview) continue;
      const name = `${M.STADIUMS[r.stadium] || ""}${r.no}R`;
      const st = seen.get(r.key) || {n: 0, last: 0, fail: 0};
      const due = (st.n === 0 && left <= firstWin) || (LOOP_MIN && st.n === 1 && left <= FINAL && now - st.last >= 90e3);
      const alerts = M.slitAlerts(r, s);
      const strong = left <= ALERT_WINDOW ? alerts.filter(x => x.type === "nobi" && x.level === 2) : [];
      const needAlert = strong.length && !sent.has(name);
      if (!due && !needAlert) continue;
      const pr = M.predict(r, s, alerts, false, stats);

      // スリットアラート強（オッズは見ずに、買いラインを添える）
      if (needAlert){
        const byNo = new Map(pr.F.map(f => [f.b.no, f]));
        const lines = [`締切 ${M.hhmm(r.closedAt)}（あと${Math.round(left)}分）`];
        for (const x of strong){
          const f = byNo.get(x.boat);
          lines.push(`${CIRCLED[x.boat]} ${f.b.name}（${f.b.cls}）展示${f.b.exTime.toFixed(2)}・内側より−${x.diff.toFixed(2)}`);
          lines.push(`　1着率${Math.round(f.p1 * 100)}%・単勝${line(f.p1).toFixed(1)}倍以上なら買い候補`);
        }
        lines.push("（アラート単独は長期検証でマイナス。締切7分前ごろにオッズを見て、買いなら別に通知します）");
        const title = `${name} スリットアラート強 ${strong.map(x => CIRCLED[x.boat]).join("")}`;
        if (await publish(title, lines.join("\n"), 3)){ sent.set(name, title); alertsSent++; console.log("スリットアラート:", name); }
      }
      if (due) await checkRace(r, pr, name, left);
    }
  }

  while (true){
    if (clock() - lastApi >= API_EVERY){
      const x = await loadRaces();
      if (x) races = x;
      lastApi = clock();
    }
    if (races) await round();
    rounds++;

    // テスト実行：初回のあと、通知とオッズ取得が動いているかを知らせる
    if (isTest && testNote === null){
      const upcoming = races ? races.filter(r => r.closedAt && r.closedAt > clock()) : [];
      if (!races) testNote = "今日のレースデータはまだありません。";
      else if (!upcoming.length) testNote = "今日のレースはもう全部締め切りました。";
      else {
        const r = upcoming[0];
        const got = pending.get(r.key);
        const odds = got ? new Map(Object.entries(got.w).map(([no, od]) => [+no, od])) : await fetchWinOdds(r);
        if (odds){
          if (!got) pending.set(r.key, {w: Object.fromEntries(odds), t: M.hhmm(new Date(clock()))});
          testNote = `公式サイトの単勝オッズも取れています（${M.STADIUMS[r.stadium] || ""}${r.no}R ${[...odds].map(([no, od]) => CIRCLED[no] + od.toFixed(1)).join(" ")}）。アプリの買い候補タブの上に「締切前のオッズ：1レース分」と出れば、アプリもオッズを読めています。`;
        } else testNote = "公式サイトの単勝オッズは取れませんでした。";
        testNote = `締切前のレース${upcoming.length}件。` + testNote;
      }
      await flushOdds();
      await publish("通知テスト", `通知は届いています。${testNote}${LOOP_MIN ? `このあと${LOOP_MIN}分間、1分おきに見張ります（その後も自動で引き継ぎます）。` : ""}`, 3);
    }

    const elapsed = clock() - t0;
    const allDone = races && races.length && races.every(r => !r.closedAt || r.closedAt <= clock());
    if (!LOOP_MIN || allDone || elapsed + STEP > LOOP_MIN * 60e3){
      if (allDone && LOOP_MIN) console.log("今日のレースは全部締め切りました");
      break;
    }
    if (clock() - lastPub >= ODDS_PUB_EVERY) await flushOdds();
    await wait(t0 + rounds * STEP - clock());
  }
  await flushOdds();
  console.log(`見張り ${rounds}回、オッズを見た ${checked}回（取得 ${oddsOK}）、買い候補 ${buys}件、見送り ${skips}件、スリットアラート ${alertsSent}件、アプリ用オッズ ${oddsMsgs}通`);
}

if (process.argv[1] && process.argv[1].endsWith("notify.mjs")) await main();
