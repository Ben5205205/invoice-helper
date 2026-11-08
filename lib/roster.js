// 疏文法會名冊：Ben 在開了「名冊」的群組貼試算表連結＋交代一句 → 小幫手讀那一頁、照規則排好順序、貼確認卡 →
// 按「確定製作」→ 叫 GitHub Actions 排版（scripts/roster/build.py，注音芫荽字型、直排唱名順序）→ PDF 存雲端硬碟 → 推播下載卡。
// Actions 用 GitHub OIDC 證明身分（沒有共用密碼），工作資料只給那一次執行拿一次。
import { kv, rid, claude, rememberSent } from "./assistant.js";
import { gas } from "./books.js";
import { recordAI, recordPush } from "./usage.js";
import { textMessage } from "./line.js";
import { fileLink } from "./vault.js";

export const ROSTER_SQL = `CREATE TABLE IF NOT EXISTS line_roster_jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT, sheet TEXT, gid TEXT, tab TEXT,
  config TEXT, plans TEXT, status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);`;

const C = { brand: "#12524F", ink: "#1F2937", sub: "#6B7280", soft: "#EEF2F1", line: "#E5E7EB", accent: "#F28C28", red: "#DC2626" };
export const DEFAULT_RULES = {
  first: ["福田︱尊榮富足大老闆", "福田︱福報財庫滿滿", "一人一樹-滿滿", "NB-年繳", "B-年繳", "NK", "K"],
  last: ["J"],
  company_weight: 2,
};
// 每個群組預設都能做名冊（只有 Ben 貼試算表連結才會動），說「關閉名冊」的群組不做
export const rosterOn = async (db, chatId) => (await kv.get(db, "roster:on:" + chatId)) !== "0";
export const rules = async db => ({ ...DEFAULT_RULES, ...(await kv.json(db, "roster:rules", {})) });
export const sheetLink = t => { const m = String(t || "").match(/docs\.google\.com\/spreadsheets\/d\/([-\w]{25,})[^\s]*/); if (!m) return null; const g = m[0].match(/[#&?]gid=(\d+)/); return { id: m[1], gid: g ? g[1] : null }; };

/* 試算表那一頁 → 各方案（由左到右）：第一列是方案名稱，第二列有「姓名」那一欄 */
export function parseTab(rows) {
  rows = (rows || []).map(r => (r || []).map(v => String(v ?? "")));
  const hi = rows.findIndex(r => r.some(v => v.trim()));
  if (hi < 0) return [];
  const head = rows[hi], si = rows.findIndex((r, i) => i > hi && r.some(v => v.trim() === "姓名"));
  if (si < 0) return [];
  const sub = rows[si], starts = head.map((v, i) => (v.trim() ? i : -1)).filter(i => i >= 0);
  const plans = [];
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : Math.max(head.length, sub.length);
    let col = -1;
    for (let j = s; j < end; j++) if ((sub[j] || "").trim() === "姓名") { col = j; break; }
    if (col < 0) return;
    const names = rows.slice(si + 1).map(r => (r[col] || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    plans.push({ name: head[s].trim(), names });
  });
  return plans;
}

/* 同名方案合併（例如兩欄 J），保留由左到右第一次出現的位置 */
const merged = plans => { const m = new Map(); for (const p of plans) { if (!m.has(p.name)) m.set(p.name, []); m.get(p.name).push(...p.names); } return [...m].map(([name, names]) => ({ name, names })); };
const norm = s => String(s || "").replace(/[\s|｜︱\-－—]/g, "").toUpperCase();

/* 預設順序：first 裡的（照那個順序）→ 其他照由左到右 → last 裡的 */
export function defaultOrder(names, r) {
  const pick = list => list.map(x => names.find(n => norm(n) === norm(x))).filter(Boolean);
  const f = pick(r.first), l = pick(r.last);
  return [...f, ...names.filter(n => !f.includes(n) && !l.includes(n)), ...l];
}

const CONFIG_SYS = (plans, r, prev) => `你幫忙製作疏文法會的唱名名冊。試算表這一頁有這些方案（由左到右，括號是人數）：
${plans.map(p => `${p.name}（${p.names.length}）`).join("、")}
目前的固定規則：方案順序先排「${r.first.join("、")}」，其他照由左到右，最後放「${r.last.join("、")}」；公司行號分份時一個算 ${r.company_weight} 個名單。
${prev ? "上一版設定（老闆現在是在修改它）：" + JSON.stringify(prev) : ""}
讀老闆的交代，只回 JSON：
{"title":"名冊標題，例如「11-23名冊」（從交代或分頁名稱看日期；沒有就用分頁名稱）",
 "order":[這次所有方案名稱的完整順序，名稱要跟上面一模一樣；沒特別交代就照固定規則],
 "remove":[{"name":"要刪掉的名字","plan":"方案（不確定就空字串）"}],
 "split":{"parts":份數,"first_extra":第一份多幾個,"company_weight":公司算幾個} 或 null（沒說要分份就 null；${prev?.split ? "上一版有分份，沒說取消就保留" : ""}),
 "save_rules":null 或 {"first":[...],"last":[...],"company_weight":n}（只有老闆說「以後」「之後都」「固定」才填，填完整的新規則）,
 "note":"一句話說明這次跟固定規則不一樣的地方，沒有就空字串"}`;

export async function planConfig(env, db, { chatId, userId, text, plans, prev }) {
  const r = await rules(db), mp = merged(plans), names = mp.map(p => p.name);
  let cfg = { title: "", order: defaultOrder(names, r), remove: [], split: prev?.split || null, note: "" };
  if (env.ANTHROPIC_API_KEY) {
    const body = { model: env.CHAT_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system: CONFIG_SYS(mp, r, prev), messages: [{ role: "user", content: text || "照固定規則做" }] };
    try {
      const res = await claude(env, body);
      if (res.usage) await recordAI(env, db, { chatId, userId, model: body.model, usage: res.usage }).catch(() => {});
      const j = JSON.parse((res.content || []).map(b => b.text || "").join("").match(/\{[\s\S]*\}/)[0]);
      const ord = (j.order || []).map(x => names.find(n => norm(n) === norm(x))).filter(Boolean);
      cfg = { title: String(j.title || "").slice(0, 40), order: [...new Set([...ord, ...defaultOrder(names, r).filter(n => !ord.includes(n))])],
        remove: (j.remove || []).filter(x => x && x.name).map(x => ({ name: String(x.name).trim(), plan: String(x.plan || "").trim() })),
        split: j.split && Number(j.split.parts) > 1 ? { parts: Math.min(20, Number(j.split.parts)), first_extra: Number(j.split.first_extra) || 0, company_weight: Number(j.split.company_weight) || r.company_weight } : null,
        note: String(j.note || "").slice(0, 200), save_rules: j.save_rules || null };
    } catch (e) { console.log("roster config", e.message); }
  }
  if (cfg.save_rules) {
    const s = cfg.save_rules, nr = { first: Array.isArray(s.first) ? s.first : r.first, last: Array.isArray(s.last) ? s.last : r.last, company_weight: Number(s.company_weight) || r.company_weight };
    await kv.set(db, "roster:rules", JSON.stringify(nr));
  }
  return cfg;
}

/* 照設定排好：方案順序、刪名字 → [{name, names}]，和找不到的名字 */
export function applyConfig(plans, cfg) {
  const mp = merged(plans), byName = new Map(mp.map(p => [p.name, [...p.names]])), missing = [], removed = [];
  for (const x of cfg.remove || []) {
    const cands = x.plan ? [...byName.keys()].filter(n => norm(n) === norm(x.plan)) : [...byName.keys()];
    let done = false;
    for (const pn of cfg.order.filter(n => cands.includes(n))) { const a = byName.get(pn), i = a.indexOf(x.name); if (i >= 0) { a.splice(i, 1); removed.push(`${x.name}（${pn}）`); done = true; break; } }
    if (!done) missing.push(x.name);
  }
  return { plans: cfg.order.map(n => ({ name: n, names: byName.get(n) || [] })).filter(p => p.names.length), removed, missing };
}

const isShort = n => [...n].length <= 4 && /^[㐀-鿿豈-﫿\u{20000}-\u{2ffff}]+$/u.test(n);
export function counts(plans, cw = 2) {
  const people = plans.reduce((a, p) => a + p.names.filter(isShort).length, 0), total = plans.reduce((a, p) => a + p.names.length, 0);
  return { people, companies: total - people, total, weight: people + (total - people) * cw };
}

/* 確認卡：方案順序和人數、刪了誰、怎麼分份 */
export function confirmCard(job) {
  const cfg = job.config, { plans, removed, missing } = applyConfig(job.plans, cfg), c = counts(plans, cfg.split?.company_weight || 2);
  const row = (a, b, bold) => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: a, size: "xs", color: C.ink, flex: 6, wrap: true, weight: bold ? "bold" : "regular" }, { type: "text", text: b, size: "xs", color: C.sub, align: "end", flex: 2 }] });
  let splitText = "不分份";
  if (cfg.split) {
    const n = cfg.split.parts, extra = cfg.split.first_extra, first = Math.ceil((c.weight - extra) / n) + extra, rest = c.weight - first;
    splitText = `分 ${n} 份：第 1 份 ${first}，其餘每份約 ${Math.floor(rest / (n - 1))}${rest % (n - 1) ? "–" + Math.ceil(rest / (n - 1)) : ""}（公司算 ${cfg.split.company_weight} 個）`;
  }
  return { type: "flex", altText: `名冊確認：${cfg.title}`, contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
      { type: "text", text: `名冊確認｜${cfg.title || job.tab}`, color: "#FFFFFF", weight: "bold", size: "md", wrap: true },
      { type: "text", text: `共 ${c.total} 筆：人名 ${c.people}、公司／長名 ${c.companies}`, color: "#CFE3E1", size: "xs" }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "xs", contents: [
      { type: "text", text: "唱名順序", size: "xs", weight: "bold", color: C.brand },
      ...plans.map((p, i) => row(`${i + 1}. ${p.name}`, `${p.names.length}`)),
      { type: "separator", margin: "md", color: C.line },
      { type: "text", text: splitText, size: "xs", color: C.ink, wrap: true, margin: "md" },
      ...(removed.length ? [{ type: "text", text: "刪除：" + removed.join("、"), size: "xs", color: C.ink, wrap: true }] : []),
      ...(missing.length ? [{ type: "text", text: "找不到，沒刪：" + missing.join("、"), size: "xs", color: C.red, wrap: true }] : []),
      ...(cfg.note ? [{ type: "text", text: cfg.note, size: "xxs", color: C.sub, wrap: true }] : []),
      { type: "text", text: "人名在前（三字 → 四字），公司行號全部放最後；每頁由右往左、由上往下。要改就回覆這張卡說明。", size: "xxs", color: C.sub, wrap: true, margin: "md" }] },
    footer: { type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px", contents: [
      { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "取消", data: "roster:no:" + job.id, displayText: "名冊取消" } },
      { type: "button", style: "primary", color: C.brand, height: "sm", action: { type: "postback", label: "確定製作", data: "roster:go:" + job.id, displayText: "名冊確定製作" } }] } } };
}

/* 貼了試算表連結（或回覆確認卡修改）→ 讀表、問 AI 怎麼排、貼確認卡 */
export async function startRoster(env, db, line, { chatId, userId, text, link, replyToken, quotedJob }) {
  let job;
  if (quotedJob) {
    job = await db.prepare("SELECT * FROM line_roster_jobs WHERE id=? AND chat_id=? AND status='draft'").bind(quotedJob, chatId).first();
    if (!job) return line.reply(replyToken, [textMessage("這張名冊已經送出製作或取消了，要重做請重新貼連結。")]);
    job.plans = JSON.parse(job.plans); job.config = JSON.parse(job.config);
    job.config = await planConfig(env, db, { chatId, userId, text, plans: job.plans, prev: job.config });
    await db.prepare("UPDATE line_roster_jobs SET config=?, updated=? WHERE id=?").bind(JSON.stringify(job.config), Date.now(), job.id).run();
  } else {
    let tab;
    try { tab = await gas(env, "readTab", link.id, link.gid); }
    catch (e) {
      const m = /NO_ACCESS|權限|access/i.test(e.message) ? "我打不開這份試算表：請把它分享給小幫手用的 Google 帳號（檢視者就好）。" : /unknown/i.test(e.message) ? "雲端那邊還沒更新讀試算表的功能，請 Ben 照說明重新部署一次。" : "讀試算表失敗：" + e.message.slice(0, 80);
      return line.reply(replyToken, [textMessage(m)]);
    }
    const plans = parseTab(tab.rows);
    if (!plans.length) return line.reply(replyToken, [textMessage(`「${tab.name}」這一頁找不到方案和「姓名」欄。第一列要是方案名稱、下一列要有「姓名」。`)]);
    const id = rid(8);
    const config = await planConfig(env, db, { chatId, userId, text: `${text}\n（分頁名稱：${tab.name}）`, plans });
    if (!config.title) config.title = String(tab.name || "名冊").replace(/列印明細|印製明細|已列印明細/g, "").replace(/\//g, "-").trim() + "名冊";
    job = { id, chat_id: chatId, plans, config, tab: tab.name };
    await db.prepare("INSERT INTO line_roster_jobs(id,chat_id,user_id,sheet,gid,tab,config,plans,status,created,updated) VALUES(?,?,?,?,?,?,?,?,'draft',?,?)")
      .bind(id, chatId, userId, link.id, link.gid, tab.name, JSON.stringify(config), JSON.stringify(plans), Date.now(), Date.now()).run();
  }
  const msgs = [confirmCard(job)];
  const r = await line.reply(replyToken, msgs).catch(e => { console.log("roster card", e.message); return null; });
  const sid = r?.sentMessages?.[0]?.id;
  if (sid) await kv.set(db, "roster:card:" + sid, job.id);
  await rememberSent(db, r, msgs).catch(() => {});
}

/* 按「確定製作」：叫 GitHub Actions 開始排版 */
export async function goRoster(env, db, { chatId, id }) {
  const job = await db.prepare("SELECT * FROM line_roster_jobs WHERE id=? AND chat_id=?").bind(id, chatId).first();
  if (!job) return "找不到這份名冊。";
  if (job.status !== "draft") return job.status === "cancelled" ? "這份已經取消了，要做請重新貼連結。" : "這份已經在做了，好了我會貼上來。";
  if (!env.GH_DISPATCH_TOKEN) return "還差一個設定（GitHub 金鑰），Ben 設好就能做了。";
  await db.prepare("UPDATE line_roster_jobs SET status='queued', updated=? WHERE id=?").bind(Date.now(), id).run();
  const r = await fetch(`https://api.github.com/repos/${env.ROSTER_REPO || "art13-art/invoice-helper"}/actions/workflows/roster.yml/dispatches`, {
    method: "POST", headers: { authorization: "Bearer " + env.GH_DISPATCH_TOKEN, accept: "application/vnd.github+json", "user-agent": "line-helper", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job: id } }) });
  if (!r.ok) {
    console.log("roster dispatch", r.status, (await r.text()).slice(0, 200));
    await db.prepare("UPDATE line_roster_jobs SET status='draft', updated=? WHERE id=?").bind(Date.now(), id).run();
    return "排版那邊叫不起來（GitHub 金鑰可能過期或權限不夠），請 Ben 檢查一下。";
  }
  return "好，開始排版，大約 3–5 分鐘，好了我會把 PDF 貼上來。";
}

/* ---------- GitHub Actions 那一端（OIDC 驗證） ---------- */
let JWKS = null;
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export async function verifyRunner(env, request) {
  const tok = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [h, p, s] = tok.split(".");
  if (!s) return null;
  const head = JSON.parse(new TextDecoder().decode(b64u(h))), claims = JSON.parse(new TextDecoder().decode(b64u(p)));
  if (!JWKS) JWKS = (await (await fetch("https://token.actions.githubusercontent.com/.well-known/jwks")).json()).keys;
  let jwk = JWKS.find(k => k.kid === head.kid);
  if (!jwk) { JWKS = (await (await fetch("https://token.actions.githubusercontent.com/.well-known/jwks")).json()).keys; jwk = JWKS.find(k => k.kid === head.kid); }
  if (!jwk || head.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p)))) return null;
  const repo = env.ROSTER_REPO || "art13-art/invoice-helper", now = Date.now() / 1000;
  if (claims.iss !== "https://token.actions.githubusercontent.com" || claims.aud !== "taxtools-roster" || claims.exp < now || claims.repository !== repo) return null;
  if (!String(claims.workflow_ref || "").startsWith(`${repo}/.github/workflows/roster.yml@refs/heads/main`)) return null;
  return claims;
}

/* 排好的 PDF：存雲端硬碟「疏文名冊/標題」，失敗就先存資料庫（附簽章連結） */
export async function saveRosterFile(env, db, job, name, bytes, origin) {
  const cfg = JSON.parse(job.config || "{}");
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  let drive = null;
  try { drive = await gas(env, "saveFile", name, "application/pdf", btoa(s), "疏文名冊/" + (cfg.title || job.tab || "名冊")); } catch (e) { console.log("roster drive", e.message); }
  const fid = rid(12);
  const keep = !drive && bytes.length < 1.9 * 1024 * 1024 ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
  await db.prepare("INSERT INTO line_files(id,chat_id,user_id,kind,name,mime,size,caption,drive_id,url,data,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(fid, job.chat_id, null, "file", name, "application/pdf", bytes.length, "名冊 " + (cfg.title || ""), drive?.id || null, drive?.url || null, keep, Date.now()).run();
  return { fid, url: drive?.url || (await fileLink(env, origin, fid)) };
}

/* 做好了：推播下載卡（一張卡列出完整名冊和每一份） */
export function resultCard(job, files, summary) {
  const cfg = JSON.parse(job.config || "{}");
  return { type: "flex", altText: `名冊做好了：${cfg.title}`, contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
      { type: "text", text: `名冊做好了｜${cfg.title}`, color: "#FFFFFF", weight: "bold", size: "md", wrap: true },
      { type: "text", text: `共 ${summary.total} 筆：人名 ${summary.people}、公司／長名 ${summary.companies}`, color: "#CFE3E1", size: "xs" }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "sm", contents: files.slice(0, 12).map(f => ({ type: "box", layout: "horizontal", alignItems: "center", spacing: "md", contents: [
      { type: "box", layout: "vertical", flex: 5, contents: [
        { type: "text", text: f.label, size: "sm", weight: "bold", color: C.ink },
        { type: "text", text: `${f.count ? f.count + " 個名單・" : ""}${f.pages} 頁・${f.first} → ${f.last}`, size: "xxs", color: C.sub, wrap: true }] },
      { type: "button", style: "primary", color: C.brand, height: "sm", flex: 2, action: { type: "uri", label: "開啟", uri: f.url } }] })) } } };
}

export async function finishRoster(env, db, line, job, body) {
  await db.prepare("UPDATE line_roster_jobs SET status=?, result=?, updated=? WHERE id=?").bind(body.ok ? "done" : "failed", JSON.stringify(body).slice(0, 20000), Date.now(), job.id).run();
  const msgs = body.ok ? [resultCard(job, body.files || [], body.summary || {})] : [textMessage("名冊排版失敗了，我會再檢查。要先重試可以回覆剛剛的確認卡說「重做」，或重新貼連結。")];
  await line.push(job.chat_id, msgs).then(async () => recordPush(db, job.chat_id, await line.memberCount(job.chat_id).catch(() => 1))).catch(e => console.log("roster push", e.message));
}

/* 計時器：送出 25 分鐘還沒好就當失敗通知 */
export async function rosterTick(env, db, line, now = Date.now()) {
  const { results } = await db.prepare("SELECT * FROM line_roster_jobs WHERE status IN ('queued','running') AND updated<?").bind(now - 25 * 60e3).all();
  for (const j of results) await finishRoster(env, db, line, j, { ok: false, error: "timeout" });
  return results.length;
}
