// 「データ攻め」（https://funanote-k7q2xm.pages.dev/・運営 あべけんさん）のデータを取り込む
// 運営の方の許可を得て取り込んでいる（2026-10-25。リポジトリに置くことも含めて許可済み）。
//
// FUNA_EXPORT=all  ：見つけたデータファイル（.json/.csv）を全部 funadata/ に gzip で書き出す（手動で動かすとき）
// FUNA_EXPORT=daily：毎日変わる小さいもの（荒れスコア・検証のまとめ）だけ書き出す（毎朝の定期実行）
//   荒れスコアは funadata/arare/YYYYMMDD.json に日ごとに残す（あとで「当たっていたか」を確かめるため）
//   モーターカルテから「モーターの展示の速さ」を計算して funadata/motor.json に書く（アプリの予想に使う・motorex.mjs）
//   選手カード（特徴タグなど・対戦成績）は、登録番号を64で割った余りごとのファイルなので、全部読みに行く（importCards）
//
// 1回目は「どんなデータがどこにあるか」を調べる：
//   サイト内のページ・スクリプト・データファイル（.json/.csv）をたどって全部読み、
//   中身は GitHub のキャッシュ（funacache/）にだけ保存する（公開リポジトリには置かない）。
//   どのURLに何があったか（形・件数・先頭の少し）だけを funanote-manifest.json に書く。
// サイトへの負担を減らすため、1秒に1回まで・1回の実行で最大 MAX_FETCH 件。続きは次の実行で読む。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {execSync} from "node:child_process";
import {MEX, motorIndex, motorSnapshot, renewMap} from "./motorex.mjs";

const BASE = "https://funanote-k7q2xm.pages.dev";
const CACHE = "funacache";
const MAX_FETCH = +(process.env.FUNA_MAX || 1500);
const GAP = 1000;
const UA = "Mozilla/5.0 (compatible; slit-radar-import/1.0; with permission of the site operator)";
const EXPORT = process.env.FUNA_EXPORT || "all";
const DAILY = ["/data/arare.json", "/data/verify_summary.json"];
const FRESH_H = 20;   // これより新しいキャッシュは読み直さない（サイトは毎朝4時ごろ更新）
const SEEDS = ["/", "/racers/", "/highlights/", "/results/", "/motor/", "/players/", "/players/card.html", "/stadium/", "/payouts/",
  "/motor-maintenance/", "/kensho/", "/kensho/tilt/", "/glossary/", "/fan/", "/announcers/", "/uranai/", "/updates/", "/torisetsu/"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
let last = 0, fetched = 0;

// サイト内のURLだけをきれいな形に（#以降を外す）
function norm(u, from){
  try {
    const x = new URL(u, BASE + from);
    if (x.host !== new URL(BASE).host) return null;
    x.hash = "";
    return x.pathname + x.search;
  } catch (e){ return null; }
}
const fileOf = p => path.join(CACHE, "raw", (p === "/" ? "/index" : p).replace(/[?&=]/g, "_").replace(/\/$/, "/index")) + ".gz";

async function get(p, freshH = FRESH_H){
  const f = fileOf(p);
  if (fs.existsSync(f)){
    const meta = JSON.parse(fs.readFileSync(f + ".meta", "utf8"));
    const fresh = meta.at && Date.now() - meta.at < freshH * 3600e3;
    // 画像・フォント・CSS は変わらないので読み直さない。データとページは毎日読み直す
    if (fresh || /image|font|css/.test(meta.type || "") || fetched >= MAX_FETCH) return {...meta, body: zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"), cached: true};
  }
  if (fetched >= MAX_FETCH) return null;
  const wait = last + GAP - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now(); fetched++;
  try {
    const r = await fetch(BASE + p, {headers: {"User-Agent": UA, "Accept-Language": "ja"}, signal: AbortSignal.timeout(30000), redirect: "follow"});
    const body = await r.text();
    const meta = {status: r.status, type: r.headers.get("content-type") || "", bytes: Buffer.byteLength(body), at: Date.now()};
    if (r.ok){
      fs.mkdirSync(path.dirname(f), {recursive: true});
      fs.writeFileSync(f, zlib.gzipSync(body));
      fs.writeFileSync(f + ".meta", JSON.stringify(meta));
    }
    return {...meta, body};
  } catch (e){
    return {status: 0, type: "", bytes: 0, body: "", err: String(e.message || e).slice(0, 100)};
  }
}

// HTML・JS・JSON の中から、たどる先を探す
function findLinks(body, from, type){
  const out = new Set(), patterns = new Set();
  const add = u => { const n = norm(u, from); if (n) out.add(n); };
  if (/html/.test(type) || /<html/i.test(body.slice(0, 500))){
    for (const m of body.matchAll(/\b(?:href|src|data-src|data-url)\s*=\s*["']([^"'#]+)["']/gi)) add(m[1]);
  }
  // 文字列の中のデータファイルらしきもの（.json/.csv/.js、/data/ や /api/ を含むもの）
  for (const m of body.matchAll(/["'`]((?:https?:\/\/[^"'`\s]+)?\/?[A-Za-z0-9_\-./]*\.(?:json|csv|js|txt)(?:\?[^"'`\s]*)?)["'`]/g)){
    if (m[1].includes("${")) patterns.add(m[1]); else add(m[1]);
  }
  for (const m of body.matchAll(/["'`](\/?(?:data|api|json)\/[^"'`\s]*)["'`]/g)){
    if (m[1].includes("${")) patterns.add(m[1]); else add(m[1]);
  }
  // テンプレート文字列（日付や場の番号を埋め込む URL）は、そのまま記録して後で調べる
  for (const m of body.matchAll(/`([^`]*\$\{[^`]*\.(?:json|csv)[^`]*)`/g)) patterns.add(m[1].slice(0, 200));
  return {links: [...out], patterns: [...patterns]};
}

// 選手カード（特徴タグなどの p と、対戦成績の h2h）
// ページのスクリプトは、登録番号を64で割った余りごとのファイル（card/p/0.json〜63.json）にまとめて置いている
//   例：const k=Number(no)%64; fetch(`card/p/${k}.json`)
// リンクをたどるだけでは見つからないので、ページのスクリプトから割る数を読んで、全部のファイルを読む（p と h2h で約130件）。
// サイトがカードを作り直したとき（集計期間の終わりが変わったとき）だけ読み直す。
const CARD_MAX = +(process.env.FUNA_CARDS || 400);
const CARD_STATE = path.join(CACHE, "cards-state.json");
const readCached = p => { const f = fileOf(p); try { return fs.existsSync(f) ? zlib.gunzipSync(fs.readFileSync(f)).toString("utf8") : null; } catch (e){ return null; } };
const readJSON = p => { const s = readCached(p); try { return s ? JSON.parse(s) : null; } catch (e){ return null; } };
async function importCards(){
  const ix = readJSON("/players/card/index.json");
  const common = readJSON("/players/card/common.json"), meta = readJSON("/players/card/h2h/meta.json");
  // 確認用：選手カードのページで、ファイル名を作っているところ
  const html = readCached("/players/card.html") || "";
  const code = [...html.matchAll(/[^\n]{0,200}card\/(?:p|h2h)\/[^\n]{0,160}/g)].map(m => m[0].slice(0, 360)).slice(0, 4);
  if (!ix) return {err: "選手の一覧（card/index.json）がまだありません", code};
  const ver = String((common && common.win && common.win.y1 && common.win.y1.to) || (meta && meta.to) || "");
  // 割る数（見つからなければ、前に見た64）
  const mm = code.join("\n").match(/Number\([^)]*\)\s*%\s*(\d+)/) || html.match(/Number\([^)]*\)\s*%\s*(\d+)\s*;[^\n]{0,120}card\/p\//);
  const mod = mm ? +mm[1] : 64;
  const key = "mod" + mod;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(CARD_STATE, "utf8")); } catch (e){}
  if (st.ver !== ver || st.key !== key) st = {ver, key, done: {p: [], h2h: []}};
  const keys = [...Array(mod).keys()].map(String);
  let n = 0, miss = 0;
  for (const kind of ["p", "h2h"]){
    const done = new Set(st.done[kind]);
    for (const k of keys){
      if (done.has(k) || n >= CARD_MAX || miss >= 10) continue;
      const r = await get(`/players/card/${kind}/${k}.json`, 0);
      n++;
      if (r && r.status === 200){ done.add(k); miss = 0; }
      else if (r && r.status === 404) done.add(k);   // その余りの選手がいない
      else miss++;
    }
    st.done[kind] = [...done];
  }
  fs.writeFileSync(CARD_STATE, JSON.stringify(st));
  // 書き出し：種類ごとに1つのファイル（登録番号 → その選手のカード）
  const have = {};
  fs.mkdirSync("funadata", {recursive: true});
  for (const kind of ["p", "h2h"]){
    const all = {};
    for (const k of keys){
      const j = readJSON(`/players/card/${kind}/${k}.json`);
      if (j && typeof j === "object") for (const [t, v] of Object.entries(j)) if (+t % mod === +k) all[t] = v;
    }
    have[kind] = Object.keys(all).length;
    if (have[kind]) fs.writeFileSync(`funadata/players__card__${kind}.json.gz`, zlib.gzipSync(JSON.stringify({ver, mod, n: have[kind], of: Object.keys(ix).length, cards: all})));
  }
  return {ver, key, fetched: n, have, of: Object.keys(ix).length, code};
}

// 今日の見どころ（/highlights/highlights.json・毎朝5時ごろ作られる）と荒れスコア（/data/arare.json）を、
// アプリで読みやすい小さな形にする。日付が今日でなければ（サイトの更新前なら）、その日付のまま書いておき、アプリは使わない
const num2 = v => (v === null || v === undefined || v === "" || isNaN(+v)) ? null : +v;
export function compactToday(H, A){
  const out = {built: new Date().toISOString(), d: null, gen: H && H.生成時刻 || "", arareGen: A && A.generated || "", races: {}};
  const hd = H && String(H.開催日 || "");
  if (/^\d{8}$/.test(hd)) out.d = `${hd.slice(0, 4)}-${hd.slice(4, 6)}-${hd.slice(6, 8)}`;
  // 分類は「波乱」「堅め」だけが書かれていて、どちらでもないレースは書かれていない（サイトの検証では「混戦」）
  // 前の晩の下書き（分類がまだ1つもない）のときは、混戦にしない
  const hasC = H && Array.isArray(H.レース) && H.レース.some(r => r.分類);
  for (const r of (H && Array.isArray(H.レース) ? H.レース : [])){
    const s = parseInt(r.場コード, 10), no = parseInt(String(r.レース), 10);
    if (!s || !no) continue;
    const cl = r.collapse && r.collapse.top ? {b: r.collapse.top.boat, k: r.collapse.top.kimarite, p: r.collapse.top.pct, n: r.collapse.n || null, io: r.collapse.inOutRate ?? null} : null;
    const B = {};
    for (const b of Array.isArray(r.艇) ? r.艇 : []){
      const run = Array.isArray(b.今節の走り) ? b.今節の走り.map(x => [num2(x.着), num2(x.コース)]) : [];
      B[b.枠] = {m: num2(b.機力), me: b.機力評価 || "", sst: !!b.鋭ST, lv: !!b.当地優位, iw: num2(b.inWinRate), in: num2(b.inN),
        sa: num2(b.さされ率), mk: num2(b.まくられ率), ms: num2(b.まくりさされ率),
        ex: b.今節展示 ? num2(b.今節展示.偏差) : null, exn: b.今節展示 ? num2(b.今節展示.本数) : null, run};
    }
    out.races[`${s}-${no}`] = {c: r.分類 || (hasC ? "混戦" : ""), h: num2(r.波乱), hx: num2(r.波乱指数), ik: !!r.イン堅, i1: num2(r.イン1着率),
      mi: r.見立て || "", te: Array.isArray(r.展開) ? r.展開 : [], dn: r.downFactors && Array.isArray(r.downFactors.items) ? r.downFactors.items : [],
      ha: r.波及 || "", cl, B};
  }
  // 荒れスコア（0〜6点。理由つき）。日付が見どころと同じものだけ足す
  for (const x of Object.values((A && A.races) || {})){
    const k = `${parseInt(x.jcd, 10)}-${x.rno}`;
    const d = /^\d{8}$/.test(String(x.hd)) ? `${x.hd.slice(0, 4)}-${x.hd.slice(4, 6)}-${x.hd.slice(6, 8)}` : null;
    if (!out.d) out.d = d;
    if (d !== out.d) continue;
    (out.races[k] || (out.races[k] = {})).ar = [x.score, x.level || "", Array.isArray(x.factors) ? x.factors : []];
  }
  return out;
}
async function buildToday(){
  const todayYmd = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  const parse = r => { try { return r && r.status === 200 ? JSON.parse(r.body) : null; } catch (e){ return null; } };
  // さっき読んだものが今日の分ならそのまま。今日の分でなければ（サイトの朝の更新前に読んでいたら）読み直す
  const read = async (p, isToday) => {
    let j = parse(await get(p));
    if (!j || !isToday(j)) j = parse(await get(p, 0)) || j;
    return j;
  };
  const H = await read("/highlights/highlights.json", j => String(j.開催日) === todayYmd);
  const A = await read("/data/arare.json", j => Object.values(j.races || {}).some(x => String(x.hd) === todayYmd));
  if (A && Object.values(A.races || {}).some(x => String(x.hd) === todayYmd)){
    fs.mkdirSync("funadata/arare", {recursive: true});
    fs.writeFileSync(`funadata/arare/${todayYmd}.json`, JSON.stringify(A));
  }
  if (!H && !A){ console.warn("今日の見どころ・荒れスコアを読めませんでした"); return; }
  const t = compactToday(H, A);
  fs.writeFileSync("funadata/today.json", JSON.stringify(t));
  // 分類を日ごとに残す（[分類, 波乱, 波乱指数, イン堅]）
  if (t.d){
    const keep = {};
    for (const [k, x] of Object.entries(t.races)) if (x.c || x.hx != null) keep[k] = [x.c || "", x.h ?? null, x.hx ?? null, x.ik ? 1 : 0];
    if (Object.keys(keep).length){
      fs.mkdirSync("funadata/hantei", {recursive: true});
      fs.writeFileSync(`funadata/hantei/${t.d.replace(/-/g, "")}.json`, JSON.stringify({d: t.d, gen: t.gen, races: keep}));
    }
  }
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  console.log(`今日のデータ攻め：${t.d}（${t.d === today ? "今日" : "今日ではない"}）${Object.keys(t.races).length}レース・生成 ${t.gen}・荒れスコア ${t.arareGen}`);
}

// JSON の形の要約（どんな項目が何件あるか、先頭を少しだけ）
function shape(v, depth = 0){
  if (Array.isArray(v)) return {array: v.length, item: v.length ? shape(v[0], depth + 1) : null};
  if (v && typeof v === "object"){
    const keys = Object.keys(v);
    if (depth >= 3) return {object: keys.length, keys: keys.slice(0, 20)};
    const o = {object: keys.length, keys: keys.slice(0, 30), fields: {}};
    for (const k of keys.slice(0, 12)) o.fields[k] = shape(v[k], depth + 1);
    return o;
  }
  return typeof v === "string" ? `string(${v.slice(0, 40)})` : typeof v;
}

export async function main(){
  fetched = 0;
  fs.mkdirSync(CACHE, {recursive: true});
  const seen = new Set(), queue = [...SEEDS], manifest = [], patterns = {};
  while (queue.length){
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const r = await get(p);
    if (!r){ manifest.push({path: p, status: "未取得（次の実行で）"}); continue; }
    const kind = /json/.test(r.type) || /\.json(\?|$)/.test(p) ? "json" : /csv/.test(r.type) || /\.csv(\?|$)/.test(p) ? "csv"
      : /javascript/.test(r.type) || /\.m?js(\?|$)/.test(p) ? "js" : /html/.test(r.type) ? "html" : (r.type || "?").split(";")[0];
    const e = {path: p, status: r.status, kind, bytes: r.bytes};
    if (r.err) e.err = r.err;
    if (r.status === 200){
      if (kind === "html"){
        const title = (r.body.match(/<title>([^<]*)<\/title>/i) || [])[1];
        if (title) e.title = title.trim().slice(0, 80);
        // 中身のない（スクリプトで後から埋める）ページか、ダミーの出走表か
        if (r.body.includes("川中島")) e.note = "ダミーの出走表（川中島）を含む";
        e.scripts = [...r.body.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 20);
        e.inlineScriptBytes = [...r.body.matchAll(/<script\b(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].reduce((a, m) => a + m[1].length, 0);
      }
      if (kind === "json"){
        try { e.shape = shape(JSON.parse(r.body)); } catch (err){ e.shape = "JSONとして読めない"; }
        e.head = r.body.slice(0, 300);
      }
      if (kind === "csv"){ const lines = r.body.split(/\r?\n/); e.rows = lines.length; e.head = lines.slice(0, 3).join("\n").slice(0, 300); }
      const f = findLinks(r.body, p, r.type);
      for (const l of f.links) if (!seen.has(l) && !queue.includes(l)) queue.push(l);
      if (f.patterns.length) patterns[p] = f.patterns.slice(0, 30);
    }
    manifest.push(e);
  }
  let cards = null;
  try { cards = await importCards(); } catch (err){ cards = {err: String(err.message || err).slice(0, 200)}; }
  const out = {
    built: new Date().toISOString(), base: BASE, minutes: +((Date.now() - T0) / 60e3).toFixed(1),
    fetchedThisRun: fetched, total: manifest.length, notYet: manifest.filter(x => String(x.status).startsWith("未取得")).length,
    byKind: manifest.reduce((a, x) => { a[x.kind || "?"] = (a[x.kind || "?"] || 0) + 1; return a; }, {}),
    cards, patterns, files: manifest
  };
  fs.writeFileSync("funanote-manifest.json", JSON.stringify(out, null, 1));
  // リポジトリに書き出す
  const clean = p => p.replace(/^\//, "").replace(/\?.*$/, "").replace(/\//g, "__");
  const ex = [];
  fs.mkdirSync("funadata/arare", {recursive: true});
  for (const e of manifest){
    if (e.status !== 200 || !["json", "csv"].includes(e.kind)) continue;
    const base = e.path.replace(/\?.*$/, "");
    if (EXPORT !== "all" && !DAILY.includes(base)) continue;
    const f = fileOf(e.path);
    if (!fs.existsSync(f)) continue;
    const name = clean(e.path);
    if (ex.includes(name)) continue;   // ?_= つきと同じもの
    fs.copyFileSync(f, `funadata/${name}.gz`);
    ex.push(name);
    if (base === "/data/arare.json"){
      try {
        const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
        const hd = Object.values(j.races || {})[0]?.hd || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
        fs.writeFileSync(`funadata/arare/${hd}.json`, JSON.stringify(j));
      } catch (err){}
    }
  }
  // アプリ用：モーターの展示の速さ（今日のレースに使う。今日より前の記録だけで計算）→ funadata/motor.json
  try {
    const rd = p => { const f = fileOf(p); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8")) : null; };
    const karte = rd("/data/motorKarte.json");
    if (karte && karte.records){
      const idx = motorIndex(karte, renewMap(rd("/data/motorReplace.json"), rd("/data/motorUsage.json")));
      const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const m = motorSnapshot(idx, today);
      fs.writeFileSync("funadata/motor.json", JSON.stringify({built: new Date().toISOString(), from: today, last: idx.last, karteUpdated: karte.updated || "", W: MEX.W, K: MEX.K, m}));
      console.log(`モーターの展示の速さ：${Object.keys(m).length}基（記録は ${idx.last} まで）`);
    } else console.warn("モーターカルテがまだありません");
  } catch (err){ console.warn("モーターの展示の速さを作れませんでした:", err.message); }
  // アプリ用：前付けしそうな選手（データ攻めの決まり手データの「前づけ率」・直近半年）→ funadata/maezuke.json
  // 10/16〜25で確かめた：5・6枠で前づけ率20%以上の選手は、展示で9割が内のコースに入った（0%の選手は6%）
  try {
    const csv = readCached("/players/racerKimarite.csv");
    if (csv){
      const lines = csv.split(/\r?\n/).filter(Boolean), head = lines[0].split(",");
      const col = name => head.indexOf(name);
      const iReg = col("登録番号"), iRate = col("前づけ率"), iAvg = col("前づけ平均"), iN = col("出走数"), iFrom = col("集計開始"), iTo = col("集計終了");
      const m = {};
      let from = "", to = "";
      for (const ln of lines.slice(1)){
        const c = ln.split(",");
        const rate = parseFloat(c[iRate]);
        if (rate >= 5) m[c[iReg]] = [rate, parseFloat(c[iAvg]) || 0, +c[iN] || 0];
        if (c[iFrom]) from = c[iFrom];
        if (c[iTo]) to = c[iTo];
      }
      if (iReg >= 0 && iRate >= 0){
        fs.writeFileSync("funadata/maezuke.json", JSON.stringify({built: new Date().toISOString(), from, to, m}));
        console.log(`前付けしそうな選手：${Object.keys(m).length}人（${from}〜${to}）`);
      }
    }
  } catch (err){ console.warn("前付けのデータを作れませんでした:", err.message); }
  // アプリ用：今日のデータ攻め（見どころの分類・見立て・展開と、荒れスコア）→ funadata/today.json
  // あとで「当たっていたか」を確かめるため、分類だけ funadata/hantei/YYYYMMDD.json に日ごとに残す
  try { await buildToday(); } catch (err){ console.warn("今日のデータ攻めを作れませんでした:", err.message); }
  fs.writeFileSync("funadata/README.md", `# データ攻めのデータ\n\nhttps://funanote-k7q2xm.pages.dev/ （運営：あべけんさん）のデータを、運営の方の許可を得て置いています。\n各ファイルは gzip。最終取得：${new Date().toISOString()}\n\nmotor.json はモーターカルテから計算した「モーターの展示の速さ」（アプリの予想に使う・作り方は motorex.mjs）。\nmaezuke.json は決まり手データの「前づけ率」が5%以上の選手（アプリの「前付けしそう」の印に使う）。\ntoday.json は今日の見どころ（分類・見立て・展開・①の不安材料）と荒れスコア（アプリの「データ攻め」欄に出す）。\nhantei/ は日ごとの分類（波乱・堅め・混戦）、arare/ は日ごとの荒れスコア（アプリの検証タブで当たり具合を確かめる）。\n`);
  try { execSync("git add funadata", {stdio: "ignore"}); } catch (err){}
  console.log(`書き出し ${ex.length}ファイル（${EXPORT}）`);
  console.log(`読んだ ${fetched}件（全 ${manifest.length}件・まだ ${out.notYet}件）`, JSON.stringify(out.byKind));
  console.log("選手カード", JSON.stringify(cards ? {...cards, code: cards.code ? cards.code.length + "か所" : 0} : null));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("funanote.mjs")) await main();
