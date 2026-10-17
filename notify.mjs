// スリットレーダーの通知（GitHub Actions で5分おきに実行）
//
// 1. 買い候補：締切16分前〜2分前のレースの単勝オッズを公式サイトで1回ずつ見て、
//    「1着率10%以上・期待値2.0以上」の艇があれば通知する（1レース1回）
// 2. スリットアラート強：締切40分以内で「強」が出たら通知する（従来どおり）
// 3. 見に行った単勝オッズは、合言葉-odds のトピックにまとめて送り、アプリが読む
//    （公開リポジトリには保存しない。ntfy は12時間で消える）
//
// 予想の計算は index.html の中のコードをそのまま使う（アプリと同じ判定になる）。
import fs from "node:fs";

const TOPIC = process.env.NTFY_TOPIC;
const NTFY = "https://ntfy.sh";
const BUY_EV = 2.0;           // 買い候補：期待値
const BUY_P = 0.10;           // 買い候補：1着率
const ODDS_FROM = 16, ODDS_TO = 2;   // 締切まで何分のレースのオッズを見るか
const ALERT_WINDOW = 40;      // スリットアラートを見る範囲（分）

const html = fs.readFileSync("index.html", "utf8");
const a = html.indexOf("/* ---------- 定数 ---------- */");
const b = html.indexOf("/* ---------- 状態 ---------- */");
if (a < 0 || b < 0) throw new Error("index.html から判定コードを見つけられませんでした");
const M = new Function(html.slice(a, b) + "\nreturn {parseV1, slitAlerts, predict, prepStats, DEFAULTS, STADIUMS, TECHS, jstNowDate, hhmm};")();

const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥"];
const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "/").split("/");
const site = owner && repo ? `https://${owner}.github.io/${repo}/` : undefined;
const isTest = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = p => Math.ceil(BUY_EV / p * 10) / 10;

async function publish(title, message, priority = 4, topic = TOPIC, extra = {}){
  const body = {topic, title, message, priority, ...extra};
  if (topic === TOPIC){ body.tags = ["motorboat"]; if (site) body.click = site; }
  const r = await fetch(NTFY, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  if (!r.ok) throw new Error("ntfy への送信に失敗: HTTP " + r.status);
}

// 今日すでに送った通知（タイトルの最初の語）を ntfy から確認
async function sentKeys(today){
  const out = new Set();
  try {
    const r = await fetch(`${NTFY}/${TOPIC}/json?poll=1&since=all`);
    for (const l of (await r.text()).split("\n")){
      try {
        const m = JSON.parse(l);
        if (m.event !== "message" || !m.title) continue;
        const d = new Date(m.time * 1000 + 9 * 3600e3).toISOString().slice(0, 10);
        if (d === today) out.add(m.title.split(" ")[0]);
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

let fetches = 0;
async function fetchWinOdds(r){
  const url = `https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${r.no}&jcd=${String(r.stadium).padStart(2, "0")}&hd=${r.date.replace(/-/g, "")}`;
  if (fetches++) await sleep(1000);   // 公式サイトへは1秒に1回まで
  try {
    const res = await fetch(url, {headers: {"Accept-Language": "ja"}});
    if (!res.ok) return null;
    return parseWinOdds(await res.text());
  } catch (e) { return null; }
}

export async function main(){
  if (!TOPIC){ console.log("NTFY_TOPIC が設定されていません"); return; }
  const today = M.jstNowDate();
  const res = await fetch(`https://boatraceopenapi.github.io/api/v1/${today.slice(0, 4)}/${today.replace(/-/g, "")}.json`, {cache: "no-store"});
  if (!res.ok){ console.log("今日のデータがありません:", res.status); if (isTest) await publish("通知テスト", "通知は届いています。今日のレースデータはまだありません。", 3); return; }
  const races = M.parseV1(await res.json(), today);
  const stats = fs.existsSync("stats.json") ? M.prepStats(JSON.parse(fs.readFileSync("stats.json", "utf8"))) : null;
  const s = {...M.DEFAULTS, w: {...M.DEFAULTS.w}};
  const sent = await sentKeys(today);
  const now = Date.now();
  const at = M.hhmm(new Date());
  const oddsOut = [];
  let buys = 0, alertsSent = 0, upcoming = 0, checked = 0, oddsOK = 0;

  for (const r of races.sort((x, y) => x.closedAt - y.closedAt)){
    if (!r.closedAt) continue;
    const left = Math.round((r.closedAt - now) / 60000);
    if (left > 0) upcoming++;
    if (!r.hasPreview || left <= 0) continue;
    const inOdds = left > ODDS_TO && left <= ODDS_FROM;
    const alerts = M.slitAlerts(r, s);
    const strong = left <= ALERT_WINDOW ? alerts.filter(x => x.type === "nobi" && x.level === 2) : [];
    const name = `${M.STADIUMS[r.stadium] || ""}${r.no}R`;
    const needAlert = strong.length && !sent.has(name);
    if (!inOdds && !needAlert) continue;

    const pr = M.predict(r, s, alerts, false, stats);
    const byNo = new Map(pr.F.map(f => [f.b.no, f]));
    const odds = await fetchWinOdds(r);
    checked++;
    if (odds){ oddsOK++; oddsOut.push({k: r.key, w: Object.fromEntries(odds)}); }

    // 1. 買い候補
    if (odds && inOdds && !sent.has(name + "買い")){
      const buy = pr.F.filter(f => f.p1 >= BUY_P && odds.get(f.b.no) && f.p1 * odds.get(f.b.no) >= BUY_EV).sort((x, y) => y.p1 * odds.get(y.b.no) - x.p1 * odds.get(x.b.no));
      if (buy.length){
        const lines = [`締切 ${M.hhmm(r.closedAt)}（あと${left}分）・${at}時点のオッズ`];
        for (const f of buy){
          const od = odds.get(f.b.no);
          lines.push(`${CIRCLED[f.b.no]} ${f.b.name}（${f.b.cls}）単勝${od.toFixed(1)}倍・1着率${Math.round(f.p1 * 100)}%・期待値${(f.p1 * od).toFixed(2)}`);
          lines.push(`　買いライン${line(f.p1).toFixed(1)}倍以上`);
        }
        if (strong.length) lines.push(`スリットアラート強 ${strong.map(x => CIRCLED[x.boat]).join("")}`);
        await publish(`${name}買い ${buy.map(f => CIRCLED[f.b.no]).join("")}単勝`, lines.join("\n"), 4);
        buys++;
        console.log("買い候補:", name, buy.map(f => f.b.no).join(","));
      }
    }

    // 2. スリットアラート強（従来どおり。オッズと期待値を添える）
    if (needAlert){
      const lines = [`締切 ${M.hhmm(r.closedAt)}（あと${left}分）`];
      for (const x of strong){
        const f = byNo.get(x.boat), od = odds && odds.get(x.boat);
        lines.push(`${CIRCLED[x.boat]} ${f.b.name}（${f.b.cls}）展示${f.b.exTime.toFixed(2)}・内側より−${x.diff.toFixed(2)}`);
        const ok = od && f.p1 >= BUY_P && f.p1 * od >= BUY_EV;
        lines.push(`　1着率${Math.round(f.p1 * 100)}%・` + (od ? `単勝${od.toFixed(1)}倍→期待値${(f.p1 * od).toFixed(2)}${ok ? "【買いライン超え】" : `（買いライン${line(f.p1).toFixed(1)}倍）`}` : `単勝${line(f.p1).toFixed(1)}倍以上なら買い候補`));
      }
      lines.push("（アラート単独は長期検証でマイナス）");
      await publish(`${name} スリットアラート強 ${strong.map(x => CIRCLED[x.boat]).join("")}`, lines.join("\n"), 3);
      alertsSent++;
      console.log("スリットアラート:", name);
    }
  }

  // 3. アプリ用にオッズをまとめて送る（1回の実行で1通。大きいときは分ける）
  for (let i = 0; i < oddsOut.length; i += 40){
    await publish("odds", JSON.stringify({d: today, at, r: oddsOut.slice(i, i + 40)}), 1, TOPIC + "-odds");
  }
  console.log(`締切前 ${upcoming}レース、オッズを見たレース ${checked}（取得 ${oddsOK}）、買い候補 ${buys}件、スリットアラート ${alertsSent}件`);

  if (isTest){
    let note = "";
    if (!checked){
      const next = races.filter(x => x.closedAt && x.closedAt > now && x.hasPreview).sort((x, y) => x.closedAt - y.closedAt)[0];
      note = next ? (await fetchWinOdds(next) ? "公式サイトの単勝オッズも取得できています。" : "公式サイトの単勝オッズは取得できませんでした。") : "今は展示が終わった締切前のレースがないので、オッズの取得は確かめられませんでした。";
    } else note = oddsOK ? "公式サイトの単勝オッズも取得できています。" : "公式サイトの単勝オッズは取得できませんでした。";
    await publish("通知テスト", `通知は届いています。締切前のレース${upcoming}件、オッズを見たレース${checked}件、買い候補の通知${buys}件。${note}以後は5分おきに自動でチェックします。`, 3);
  }
}

if (process.argv[1] && process.argv[1].endsWith("notify.mjs")) await main();
