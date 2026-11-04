// 私人助理群（只有 Ben 和小幫手的群組）：照片、檔案、錄音自動存檔，記事、找東西、把照片或文件叫回來。
// 存在 Google 雲端硬碟「LINE 小助理｜廠商帳 / 私人存檔 / 標題」（Apps Script saveFile）；雲端硬碟連不上時，2MB 以下先存資料庫。
// 不自動存：老闆傳完照片說「存 標題」才存，同標題放同一個資料夾；不用 AI 看照片。
import { kv, ymd, hm, isGroup } from "./assistant.js";
import { gas } from "./books.js";
import { textMessage } from "./line.js";

export const VAULT_SQL = `CREATE TABLE IF NOT EXISTS line_files (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT, kind TEXT, name TEXT, mime TEXT, size INTEGER, caption TEXT, drive_id TEXT, url TEXT, data BLOB, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_files_chat ON line_files(chat_id, ts);
CREATE TABLE IF NOT EXISTS line_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_notes_chat ON line_notes(chat_id, ts);`;

export const isPrivate = async (db, chatId) => isGroup(chatId) && (await kv.get(db, "private:" + chatId)) === "1";
/* 私人助理群和管理員私訊共用同一個存檔（在私訊問也找得到群組裡存的東西） */
export const vaultOwner = async (db, chatId, userId, isAdm) => (isAdm ? "admin" : chatId);

const b64 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const ext = t => ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "video/mp4": "mp4", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/mpeg": "mp3", "application/pdf": "pdf" }[t] || "bin");
const KIND = { image: "照片", video: "影片", audio: "錄音", file: "檔案" };

/* 存一個 LINE 訊息裡的照片／檔案／錄音／影片，放進「私人存檔 / 標題」資料夾（同標題存在一起） */
export async function archive(env, db, line, { owner, chatId, userId, msg, title, n }) {
  const kind = msg.type === "image" ? "image" : msg.type;
  const f = await line.content(msg.id, 25 * 1024 * 1024);
  const now = Date.now(), stamp = ymd(msg.ts || now).replace(/-/g, "") + "-" + hm(msg.ts || now).replace(":", "");
  const t = cleanTitle(title);
  const name = msg.fileName || `${t}-${stamp}${n ? "-" + n : ""}.${ext(f.type)}`;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  let drive = null;
  try { drive = await gas(env, "saveFile", name, f.type || "application/octet-stream", b64(f.bytes), "私人存檔/" + t); }
  catch (e) { console.log("vault drive", e.message); }
  const keep = !drive && f.bytes.length < 1.9 * 1024 * 1024 ? f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) : null;
  if (!drive && !keep) throw new Error("檔案太大，雲端硬碟又還沒接好，這個先存不了");
  await db.prepare("INSERT INTO line_files(id,chat_id,user_id,kind,name,mime,size,caption,drive_id,url,data,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, owner, userId || null, kind, name, f.type || null, f.bytes.length, t, drive?.id || null, drive?.url || null, keep, now).run();
  return { id, kind, name, title: t, drive: !!drive };
}
const cleanTitle = t => String(t || "").replace(/[\\:*?"<>|]/g, "").replace(/\s+/g, " ").replace(/^\/+|\/+$/g, "").trim().slice(0, 40) || "未分類";

/* 私人助理群傳進來的照片／檔案先記著（最多 30 個、24 小時內），說「存」才存 */
const PEND_MS = 24 * 3600e3;
export async function addPending(db, chatId, item) {
  const list = (await kv.json(db, "vpend:" + chatId, [])).filter(x => Date.now() - x.ts < PEND_MS);
  list.push(item);
  await kv.set(db, "vpend:" + chatId, JSON.stringify(list.slice(-30)));
}
/* 「存 疏文」「存起來：合約」「幫我存 發票/11月」→ { title }；問句不算 */
export function saveCmd(text) {
  const t = String(text || "").trim();
  if (/[?？嗎呢哪]|什麼|甚麼|存了|存過|存在|存檔在/.test(t)) return null;
  const m = t.match(/^(?:幫我|請|麻煩)?存(?:起來|一下|下來|檔)?(?:到|進|在)?\s*[:：,，]?\s*(.*)$/s);
  return m ? { title: m[1].replace(/(資料夾|這些|這張|這個|剛剛的?)/g, "").trim() } : null;
}
const KIND_UNIT = { image: "張照片", file: "個檔案", audio: "段錄音", video: "段影片" };
export async function savePending(env, db, line, { owner, chatId, userId, title, quoted }) {
  let list = (await kv.json(db, "vpend:" + chatId, [])).filter(x => Date.now() - x.ts < PEND_MS);
  const pick = quoted ? list.filter(x => x.id === quoted) : list;
  if (!pick.length) return quoted || list.length ? null : null;   // 沒有待存的：交給 AI（可能是要記事）
  const t = cleanTitle(title), done = [], fail = [];
  let i = 0;
  for (const x of pick.slice(0, 20)) {
    try { done.push(await archive(env, db, line, { owner, chatId, userId, msg: x, title: t, n: pick.length > 1 ? ++i : 0 })); }
    catch (e) { console.log("archive failed", e.message); fail.push(x); }
  }
  const saved = new Set(done.length ? pick.slice(0, 20).filter(x => !fail.includes(x)).map(x => x.id) : []);
  await kv.set(db, "vpend:" + chatId, JSON.stringify(list.filter(x => !saved.has(x.id))));
  if (!done.length) return "沒存成功，等一下再說一次「存 " + t + "」？";
  const cnt = {}; done.forEach(r => { cnt[r.kind] = (cnt[r.kind] || 0) + 1; });
  const what = Object.entries(cnt).map(([k, v]) => v + " " + (KIND_UNIT[k] || "個")).join("、");
  return `存好了：${what}，放在「${t}」` + (fail.length ? `\n有 ${fail.length} 個沒存成功（可能太久了），再傳一次？` : "") + (done.some(r => !r.drive) ? "\n（雲端硬碟還沒接好，先存在系統裡）" : "");
}

/* ---------- AI 工具（只有管理員的私訊和私人助理群） ---------- */
export const VAULT_TOOLS = [
  { name: "save_note", description: "把老闆要你記下來的事存進他的記事本（說「記一下」「幫我記」「存起來」時用）。原文照存，日期系統會加。", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "search_notes", description: "查老闆記事本裡記過的事。query 給關鍵字（空白分開），空字串＝最近 20 筆。", input_schema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "find_files", description: "在老闆的存檔裡找照片、檔案、錄音、影片（他在私人助理群或私訊傳過的都存著）。用關鍵字比對檔名和老闆取的標題（資料夾名）；可加 kind（image/file/audio/video）和 days（最近幾天）。回傳 id、日期、檔名、描述。", input_schema: { type: "object", properties: { query: { type: "string" }, kind: { type: "string" }, days: { type: "number" } } } },
  { name: "send_files", description: "把存檔裡的照片／檔案傳回聊天室給老闆（先用 find_files 找到 id）。一次最多 4 個；照片會直接顯示，檔案附「開啟檔案」按鈕。", input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
];
const words = q => String(q || "").split(/[\s,，、]+/).map(w => w.trim()).filter(Boolean).slice(0, 6);
export async function runVaultTool(ctx, name, input) {
  const { db } = ctx, owner = ctx.vaultOwner;
  if (name === "save_note") {
    const t = String(input.text || "").trim().slice(0, 4000);
    if (!t) return { error: "沒有內容" };
    await db.prepare("INSERT INTO line_notes(chat_id,text,ts) VALUES(?,?,?)").bind(owner, t, Date.now()).run();
    return { ok: true };
  }
  if (name === "search_notes") {
    const w = words(input.query);
    const { results } = await db.prepare(`SELECT text,ts FROM line_notes WHERE chat_id=? ${w.map(() => "AND text LIKE ?").join(" ")} ORDER BY ts DESC LIMIT 20`).bind(owner, ...w.map(x => `%${x}%`)).all();
    return { notes: results.map(r => ({ date: `${ymd(r.ts)} ${hm(r.ts)}`, text: r.text })) };
  }
  if (name === "find_files") {
    const w = words(input.query), days = Number(input.days) || 0;
    const cond = [...w.map(() => "(COALESCE(name,'') || ' ' || COALESCE(caption,'')) LIKE ?"), ...(input.kind ? ["kind=?"] : []), ...(days ? ["ts>?"] : [])];
    const args = [...w.map(x => `%${x}%`), ...(input.kind ? [input.kind] : []), ...(days ? [Date.now() - days * 864e5] : [])];
    let { results } = await db.prepare(`SELECT id,kind,name,caption,ts FROM line_files WHERE chat_id=? ${cond.map(c => "AND " + c).join(" ")} ORDER BY ts DESC LIMIT 10`).bind(owner, ...args).all();
    // 一個字都對不到：放寬成任一關鍵字
    if (!results.length && w.length > 1) results = (await db.prepare(`SELECT id,kind,name,caption,ts FROM line_files WHERE chat_id=? AND (${w.map(() => "(COALESCE(name,'') || ' ' || COALESCE(caption,'')) LIKE ?").join(" OR ")}) ORDER BY ts DESC LIMIT 10`).bind(owner, ...w.map(x => `%${x}%`)).all()).results;
    return { files: results.map(r => ({ id: r.id, kind: KIND[r.kind] || r.kind, date: `${ymd(r.ts)} ${hm(r.ts)}`, name: r.name, caption: r.caption || "" })) };
  }
  if (name === "send_files") {
    const ids = (input.ids || []).slice(0, 4);
    const got = [];
    for (const id of ids) { const r = await db.prepare("SELECT id,kind,name,mime,url FROM line_files WHERE id=? AND chat_id=?").bind(id, owner).first(); if (r) got.push(r); }
    if (!got.length) return { error: "找不到這些檔案" };
    (ctx.sendFiles ||= []).push(...got);
    return { ok: true, sent: got.map(r => r.name), note: "系統會把檔案接在你這則回覆後面，你只要說一句就好" };
  }
  return null;
}

/* 傳回聊天室的訊息：照片直接顯示（JPEG/PNG），其他附開啟按鈕 */
async function sig(env, id) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET || "x"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("file:" + id)))].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function fileLink(env, origin, id) { return `${origin}/api/line/file?id=${id}&s=${await sig(env, id)}`; }
export const checkSig = async (env, id, s) => !!id && s === (await sig(env, id));
export async function fileMessages(env, origin, files) {
  const out = [];
  for (const f of files) {
    const url = await fileLink(env, origin, f.id);
    if (f.kind === "image" && /jpe?g|png/.test(f.mime || "")) out.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
    else out.push({ type: "flex", altText: "檔案：" + f.name, contents: { type: "bubble", size: "kilo",
      body: { type: "box", layout: "horizontal", paddingAll: "14px", spacing: "md", alignItems: "center", contents: [
        { type: "box", layout: "vertical", width: "36px", height: "36px", cornerRadius: "8px", backgroundColor: "#12524F", justifyContent: "center", contents: [{ type: "text", text: f.kind === "audio" ? "音" : f.kind === "video" ? "影" : "檔", color: "#FFFFFF", align: "center", weight: "bold" }] },
        { type: "text", text: String(f.name).slice(0, 60), weight: "bold", size: "sm", color: "#1F2937", wrap: true, maxLines: 2, flex: 1 }] },
      footer: { type: "box", layout: "vertical", paddingAll: "14px", paddingTop: "0px", contents: [
        { type: "button", style: "primary", color: "#12524F", height: "sm", action: { type: "uri", label: "開啟檔案", uri: f.url || url } }] } } });
  }
  return out;
}

export { textMessage };
