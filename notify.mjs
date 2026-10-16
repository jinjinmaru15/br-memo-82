// スリットレーダーの通知（GitHub Actions で5分おきに実行）
// 締切40分以内のレースで「強」のスリットアラートが出たら ntfy に通知する。
// そのレースだけ公式サイトの単勝オッズを見に行き、期待値を添える（保存はしない）。
// 締切12分前を切ったら、もう一度オッズを見て「直前オッズ」を通知する。
// 予想の計算は index.html の中のコードをそのまま使う（アプリと同じ判定になる）。
import fs from "node:fs";

const TOPIC = process.env.NTFY_TOPIC;
const NTFY = "https://ntfy.sh";
const EV_LINE = 1.5;          // 買いライン = 期待値1.50になるオッズ
const WINDOW_MIN = 40;        // 締切まで何分以内のレースを見るか
const LAST_CALL_MIN = 12;     // 直前オッズを送るタイミング

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

async function publish(title, message, priority = 4){
  const body = {topic: TOPIC, title, message, priority, tags: ["motorboat"]};
  if (site) body.click = site;
  const r = await fetch(NTFY, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  if (!r.ok) throw new Error("ntfy への送信に失敗: HTTP " + r.status);
}

// 今日すでに送った通知（タイトルの最初の語）を ntfy から確認
async function sentKeys(today){
  const out = new Set();
  try {
    const r = await fetch(`${NTFY}/${TOPIC}/json?poll=1&since=all`);
    for (const line of (await r.text()).split("\n")){
      try {
        const m = JSON.parse(line);
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

async function fetchWinOdds(r){
  const url = `https://www.boatrace.jp/owpc/pc/race/oddstf?rno=${r.no}&jcd=${String(r.stadium).padStart(2, "0")}&hd=${r.date.replace(/-/g, "")}`;
  try {
    const res = await fetch(url, {headers: {"Accept-Language": "ja"}});
    if (!res.ok) return null;
    return parseWinOdds(await res.text());
  } catch (e) { return null; }
}

const evText = (p, od) => {
  if (!od) return `単勝オッズは取得できず・${(EV_LINE / p).toFixed(1)}倍以上なら買い`;
  const ev = p * od;
  return `単勝${od.toFixed(1)}倍→期待値${ev.toFixed(2)}${ev >= EV_LINE ? "【買いライン超え】" : "（ライン" + (EV_LINE / p).toFixed(1) + "倍）"}`;
};

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
  let count = 0, upcoming = 0, oddsOK = null;

  for (const r of races){
    if (!r.closedAt) continue;
    const left = Math.round((r.closedAt - now) / 60000);
    if (left > 0) upcoming++;
    if (!r.hasPreview || left <= 0 || left > WINDOW_MIN) continue;
    const alerts = M.slitAlerts(r, s);
    const strong = alerts.filter(x => x.type === "nobi" && x.level === 2);
    if (!strong.length) continue;
    const name = `${M.STADIUMS[r.stadium] || ""}${r.no}R`;
    const first = !sent.has(name);
    const last = !first && left <= LAST_CALL_MIN && !sent.has(name + "直前");
    if (!first && !last) continue;

    const pr = M.predict(r, s, alerts, false, stats);
    const byNo = new Map(pr.F.map(f => [f.b.no, f]));
    const odds = await fetchWinOdds(r);
    oddsOK = oddsOK || !!odds;
    await sleep(1000);
    const boats = strong.map(x => CIRCLED[x.boat]).join("");
    const plus = odds && strong.some(x => byNo.get(x.boat).p1 * (odds.get(x.boat) || 0) >= EV_LINE);

    if (first){
      const top3 = [...pr.F].sort((x, y) => y.p1 - x.p1).slice(0, 3).map(f => `${CIRCLED[f.b.no]}${Math.round(f.p1 * 100)}%`).join(" ");
      const T = pr.tenkai.T, tot = T.reduce((x, y) => x + y, 0) || 1;
      const tk = T.map((v, i) => [M.TECHS[i], v / tot]).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([n, v]) => `${n}${Math.round(v * 100)}%`).join(" ");
      const lines = [`締切 ${M.hhmm(r.closedAt)}（あと${left}分）`];
      for (const x of strong){
        const f = byNo.get(x.boat);
        lines.push(`${CIRCLED[x.boat]} ${f.b.name}（${f.b.cls}）展示${f.b.exTime.toFixed(2)}・内側より−${x.diff.toFixed(2)}`);
        lines.push(`　1着率${Math.round(f.p1 * 100)}%・${evText(f.p1, odds && odds.get(x.boat))}`);
      }
      lines.push(`期待度 ${top3}`);
      lines.push(`展開 ${tk}`);
      if (odds) lines.push(`オッズは${M.hhmm(new Date())}時点。締切までに動きます。`);
      await publish(`${name} スリットアラート強 ${boats}${plus ? " 期待値+" : ""}`, lines.join("\n"));
    } else {
      const lines = [`締切 ${M.hhmm(r.closedAt)}（あと${left}分）`];
      for (const x of strong){
        const f = byNo.get(x.boat);
        lines.push(`${CIRCLED[x.boat]} 1着率${Math.round(f.p1 * 100)}%・${evText(f.p1, odds && odds.get(x.boat))}`);
      }
      await publish(`${name}直前 オッズ確認 ${boats}${plus ? " 期待値+" : ""}`, lines.join("\n"), plus ? 4 : 3);
    }
    count++;
    console.log("通知:", name, first ? "初回" : "直前", odds ? "オッズあり" : "オッズなし");
  }
  console.log(`締切前 ${upcoming}レース、通知 ${count}件`);

  if (isTest){
    if (oddsOK === null){
      const next = races.filter(r => r.closedAt && r.closedAt > now).sort((x, y) => x.closedAt - y.closedAt)[0];
      oddsOK = next ? !!(await fetchWinOdds(next)) : null;
    }
    const oddsMsg = oddsOK === null ? "締切前のレースがないので、公式オッズの取得は確かめられませんでした。" : oddsOK ? "公式サイトの単勝オッズも取得できています。" : "公式サイトの単勝オッズは取得できませんでした（通知は買いラインだけになります）。";
    await publish("通知テスト", `通知は届いています。今は締切前のレースが${upcoming}件あり、「強」のスリットアラートで通知したのは${count}件です。${oddsMsg}以後は5分おきに自動でチェックします。`, 3);
  }
}

if (process.argv[1] && process.argv[1].endsWith("notify.mjs")) await main();
