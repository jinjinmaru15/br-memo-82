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
  fs.writeFileSync("funadata/README.md", `# データ攻めのデータ\n\nhttps://funanote-k7q2xm.pages.dev/ （運営：あべけんさん）のデータを、運営の方の許可を得て置いています。\n各ファイルは gzip。最終取得：${new Date().toISOString()}\n\nmotor.json はモーターカルテから計算した「モーターの展示の速さ」（アプリの予想に使う・作り方は motorex.mjs）。\n`);
  try { execSync("git add funadata", {stdio: "ignore"}); } catch (err){}
  console.log(`書き出し ${ex.length}ファイル（${EXPORT}）`);
  console.log(`読んだ ${fetched}件（全 ${manifest.length}件・まだ ${out.notYet}件）`, JSON.stringify(out.byKind));
  console.log("選手カード", JSON.stringify(cards ? {...cards, code: cards.code ? cards.code.length + "か所" : 0} : null));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("funanote.mjs")) await main();
