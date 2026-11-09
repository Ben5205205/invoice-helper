// 拆酒店帳單：幹部在群組貼帳單 → 讀帳單 → 回「如要拆單服務，請填寫表單」＋按鈕
// → 表單（依帳單人數開好客人欄位：名字、男女、併給誰／小姐坐誰／公費誰分）→ 送出 → @All「拆帳完畢」＋請款卡。金額算到個位數，加總一定等於帳單現金價格。
import { claude, kv, rid, isGroup } from "./assistant.js";
import { recordAI, recordPush } from "./usage.js";
import { toBlocks } from "./files.js";
import { mentionMessage, textMessage, lineClient } from "./line.js";
import { pick } from "./voice.js";
import { resolveStore } from "./stores.js";

const HOUR = 3600e3;
const C = { brand: "#12524F", ink: "#1F2937", sub: "#6B7280", soft: "#EEF2F1", line: "#E5E7EB", warn: "#B45309", accent: "#F28C28" };
export const SPLIT_SQL = `CREATE TABLE IF NOT EXISTS line_splits (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, bill_no TEXT, created INTEGER NOT NULL, created_by TEXT, status TEXT NOT NULL, data TEXT NOT NULL, result TEXT, done_at INTEGER);
CREATE INDEX IF NOT EXISTS line_splits_chat ON line_splits(chat_id, created);
CREATE TABLE IF NOT EXISTS line_split_imgs (split_id TEXT NOT NULL, n INTEGER NOT NULL, mime TEXT, data BLOB, PRIMARY KEY (split_id, n));`;

export const fmt = n => Math.round(Number(n) || 0).toLocaleString("en-US");
export const splitOn = async (db, chatId) => (await kv.get(db, "split:on:" + chatId)) === "1";
/* 群組照片要不要判斷帳單：說過「開啟拆帳」＝broad（寬鬆，收據也算）；說過「關閉」或廠商群組＝off；其他群組預設 strict（只認酒店／KTV／酒吧帳單） */
export async function splitMode(db, chatId) {
  const v = await kv.get(db, "split:on:" + chatId);
  if (v === "1") return "strict";   // 開啟過的群組也只認酒店／KTV／酒吧帳單
  if (v === "0") return "off";
  if ((await kv.json(db, "flows", []).catch(() => [])).some(f => f.notify === chatId)) return "off";
  return "strict";
}
/* 分享用的單張代碼：只打得開這一張單（看不到群組其他帳單、群組名稱、帳單照片） */
export async function shareToken(db, id) {
  let t = await kv.get(db, "splitshare:" + id);
  if (!t) { t = rid(12) + rid(12); await kv.set(db, "splitshare:" + id, t); await kv.set(db, "splitshr:" + t, id); }
  return t;
}
export async function splitToken(db, chatId) {
  let t = await kv.get(db, "split:tok:" + chatId);
  if (!t) { t = rid(12) + rid(12); await kv.set(db, "split:tok:" + chatId, t); await kv.set(db, "splittok:" + t, chatId); }
  return t;
}
/* 每家店固定一套配色（不重複）：依店名意象挑的主色＋深色（漸層）＋點綴色＋淡色底＋一個浮水印字。
   請款卡標題、合併請款單、明細網頁都用它。名單外的店從備用色裡挑，不會撞到上面幾家。 */
const THEMES = [
  { keys: ["香閣", "SS", "香閣里拉", "香閣里拉招待會所"], name: "沉香", base: "#6B3657", deep: "#4A2240", tint: "#F5ECF2", accent: "#E9CBA4", mark: "香" },
  { keys: ["FOCUS", "FOCUS麗緻酒店", "麗緻"], name: "深海", base: "#1E3A5F", deep: "#132843", tint: "#EAF0F7", accent: "#A9C8EA", mark: "F" },
  { keys: ["世盟", "世盟百欣商務酒店", "百欣"], name: "勃艮第", base: "#7E2632", deep: "#5A1822", tint: "#F7EAEC", accent: "#EDB9A6", mark: "盟" },
  { keys: ["威思汀", "FL", "威思汀商務會所"], name: "汀洲", base: "#1D6A6E", deep: "#124A4D", tint: "#E7F3F3", accent: "#A7DDD8", mark: "汀" },
  { keys: ["威士登"], name: "琥珀", base: "#7A4E1D", deep: "#553510", tint: "#F7EFE4", accent: "#EBC584", mark: "登" },
];
const SPARE = [
  { base: "#2F6B3A", deep: "#1F4A27", tint: "#E8F1EA", accent: "#B9DDBF" }, { base: "#4B3C8C", deep: "#332865", tint: "#EEEBF7", accent: "#C9BFF0" },
  { base: "#3D4A55", deep: "#29323A", tint: "#EBEEF1", accent: "#C3CDD6" }, { base: "#A3521A", deep: "#773B10", tint: "#FBEEE3", accent: "#F3C9A0" },
  { base: "#5E6B1F", deep: "#424C13", tint: "#F1F3E3", accent: "#D6DE9E" }, { base: "#2B3F8F", deep: "#1D2B66", tint: "#E8ECF8", accent: "#B7C4F0" },
  { base: "#8A3A6E", deep: "#62284E", tint: "#F6EAF2", accent: "#EBBFDB" }, { base: "#0F5E52", deep: "#0A4239", tint: "#E5F2EF", accent: "#9FD8CC" },
];
const skey = n => String(n || "").replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s·・._\-]|酒店|會館|俱樂部|KTV/gi, "").toUpperCase();
const THEME_KEYS = new Map(THEMES.flatMap(t => t.keys.map(k => [skey(k), t])));
export function storeColor(name) {
  const k = skey(name);
  const t = THEME_KEYS.get(k) || (k.length >= 2 ? THEMES.find(t => t.keys.some(x => skey(x).length >= 2 && (k.includes(skey(x)) || skey(x).includes(k)))) : null);
  if (t) return { base: t.base, deep: t.deep, tint: t.tint, accent: t.accent, mark: t.mark };
  let h = 0; for (const ch of k || "帳單") h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const c = SPARE[h % SPARE.length];
  return { ...c, mark: [...String(name || "").replace(/\s/g, "")][0] || "" };
}
/* 同一批裡兩家（名單外的）店剛好同色時，後面那家換下一個沒用過的顏色 */
export function storeColors(names) {
  const used = new Set(), out = {};
  for (const n of names) {
    if (out[n]) continue;
    let c = storeColor(n);
    if (used.has(c.base)) { const f = SPARE.find(x => !used.has(x.base)); if (f) c = { ...f, mark: c.mark }; }
    used.add(c.base); out[n] = c;
  }
  return out;
}
const load = async (db, id) => { const r = await db.prepare("SELECT * FROM line_splits WHERE id=?").bind(id).first(); if (r) r.d = JSON.parse(r.data || "{}"); return r; };
const save = (db, r) => db.prepare("UPDATE line_splits SET data=?, status=?, bill_no=? WHERE id=?").bind(JSON.stringify(r.d), r.status, r.d.bill_no || null, r.id).run();
/* 表單連結：有設定 LINE 內嵌視窗（kv liff:split）就用 liff.line.me 開（從聊天室滑出、送完自動關、知道是誰） */
export async function formLink(db, origin, chatId, id) {
  const q = `t=${await splitToken(db, chatId)}&id=${id}`;
  const liff = await kv.get(db, "liff:split");
  return liff ? `https://liff.line.me/${liff}?${q}` : origin ? `${origin}/split/form?${q}` : "";
}
/* 同一張單（同單號）最近一筆紀錄：重貼時用來判斷「已經拆過」或「拆到一半」 */
export async function sameBill(db, chatId, billNo) {
  const no = String(billNo || "").replace(/\s/g, "");
  if (!no) return null;
  const r = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND REPLACE(bill_no,' ','')=? AND status!='cancelled' AND created>? ORDER BY created DESC LIMIT 1").bind(chatId, no, Date.now() - 60 * 24 * HOUR).first();
  if (r) r.d = JSON.parse(r.data || "{}");
  return r;
}
/* 這張單在「別的群組」已經拆好了：貼到這群時不再問要不要拆，直接給結果卡。
   卡上的連結用單張分享連結（看不到原本那群的名稱和其他帳單）。 */
export async function doneElsewhere(db, chatId, billNo) {
  // 單號只比英數字（「1106015-530008」「1106015 530008」「61030012[002-1]」的寫法差異都不算）
  const nk = x => String(x || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase(), no = nk(billNo);
  if (no.length < 5) return null;
  const { results } = await db.prepare("SELECT * FROM line_splits WHERE chat_id!=? AND status='done' AND result IS NOT NULL AND bill_no IS NOT NULL AND created>? ORDER BY done_at DESC LIMIT 300").bind(chatId, Date.now() - 60 * 24 * HOUR).all();
  const r = results.find(x => nk(x.bill_no) === no) || (no.length >= 7 ? results.find(x => { const k = nk(x.bill_no); return k.length >= 7 && (k.startsWith(no) || no.startsWith(k)); }) : null);
  if (r) r.d = JSON.parse(r.data || "{}");
  return r || null;
}
/* 讀完帳單才知道單號（照片判斷時沒讀到）：讀出來的單號在別群拆好了，就把剛開的這筆取消，改給結果卡 */
export async function elsewhereAfterRead(db, chatId, r, origin) {
  if (!r || r.error || r.merged || !r.split?.d?.bill_no) return null;
  const other = await doneElsewhere(db, chatId, r.split.d.bill_no).catch(() => null);
  if (!other) return null;
  await db.prepare("UPDATE line_splits SET status='cancelled' WHERE id=?").bind(r.split.id).run();
  return (await elsewhereArrive(db, chatId, other, origin || other.d.origin || "")) || [];
}
/* 別群拆好的單貼過來：直接給請款卡；今天這群已經有別張單，就順便問要不要合併 */
export async function elsewhereArrive(db, chatId, other, origin) {
  const msgs = await elsewhereMessages(db, other, origin, chatId);
  return [...msgs, ...(await combineAskMessages(db, chatId, other.id))];
}
/* 記下這群看過哪些別群的單（之後說「合併」、同一天再貼單時才找得到） */
export async function recordShown(db, chatId, id) {
  const now = Date.now(), k = "split:shown:" + chatId;
  const l = (await kv.json(db, k, [])).filter(x => now - x.ts < 36 * 3600e3 && x.id !== id);
  l.push({ id, ts: now });
  await kv.set(db, k, JSON.stringify(l));
}
/* ---------- 同時貼好幾張照片：3 秒內連貼算同一批 ----------
   每張照片進來先記一筆（split:img:群組:訊息）；判斷完是什麼（別群拆好的單／新帳單／不是帳單）再標上。
   別群拆好的單要等：3 秒內沒有下一張、而且同一批每張都判斷完，才決定——
   同一批都是別群拆好的單（2 張以上）→ 只回一次「要合併、分開、還是重新修改？」；其他情況各自照平常處理。 */
export const BURST = { gap: 3000, max: 15000, poll: 700 };
const imgKey = (chatId, m) => `split:img:${chatId}:${m}`;
export async function noteImage(db, chatId, msgId, ts = Date.now()) { if (msgId) await kv.set(db, imgKey(chatId, msgId), JSON.stringify({ ts })); }
export async function markImage(db, chatId, msgId, out) {
  if (!msgId) return;
  const o = await kv.json(db, imgKey(chatId, msgId), null);
  if (o) await kv.set(db, imgKey(chatId, msgId), JSON.stringify({ ...o, out }));
}
async function burstList(db, chatId) {
  const now = Date.now(), pre = `split:img:${chatId}:`;
  const { results } = await db.prepare("SELECT k,v FROM line_kv WHERE k LIKE ?").bind(pre + "%").all();
  const l = [];
  for (const r of results) { let v; try { v = JSON.parse(r.v); } catch { v = null; }
    if (!v || now - v.ts > 10 * 60e3) { await db.prepare("DELETE FROM line_kv WHERE k=?").bind(r.k).run().catch(() => {}); continue; }
    l.push({ m: r.k.slice(pre.length), ...v }); }
  return l.sort((a, b) => a.ts - b.ts);
}
export async function settleDone(db, chatId, msgId, splitId) {
  if (!msgId) return { mode: "solo" };
  await markImage(db, chatId, msgId, { k: "done", id: splitId });
  const me = await kv.json(db, imgKey(chatId, msgId), null);
  if (!me) return { mode: "solo" };
  const t0 = Date.now();
  let group = [];
  for (;;) {
    const l = await burstList(db, chatId), i = l.findIndex(x => x.m === msgId);
    if (i < 0) return { mode: "solo" };
    let a = i, b = i;
    while (a > 0 && l[a].ts - l[a - 1].ts <= BURST.gap) a--;
    while (b < l.length - 1 && l[b + 1].ts - l[b].ts <= BURST.gap) b++;
    group = l.slice(a, b + 1);
    const settled = Date.now() >= group[group.length - 1].ts + BURST.gap + 300 && group.every(x => x.out);
    if (settled || Date.now() - t0 > BURST.max) break;
    await new Promise(res => setTimeout(res, BURST.poll));
  }
  const ids = [...new Set(group.filter(x => x.out?.k === "done").map(x => x.out.id))];
  if (group.length < 2 || ids.length < 2 || !group.every(x => x.out?.k === "done")) return { mode: "solo" };
  // 同一批只讓一個人回話
  const c = await db.prepare("INSERT OR IGNORE INTO line_kv(k,v) VALUES(?,?)").bind(`split:burst:${chatId}:${group[0].m}`, msgId).run();
  if ((c.meta?.changes ?? 1) === 0) return { mode: "skip" };
  return { mode: "group", ids: ids.slice(0, 4) };
}
/* 同一批貼了好幾張別群拆好的單：問要合併、分開、還是重新修改 */
export async function pickMessages(db, ids) {
  const rows = [];
  for (const id of ids) { const r = await load(db, id); if (r && r.result) rows.push({ ...r, res: JSON.parse(r.result) }); }
  const pal = storeColors(rows.map(r => r.d.store || "帳單")), list = rows.map(r => r.id).join(",");
  const btn = (label, k, style) => ({ type: "button", style, ...(style === "primary" ? { color: C.brand } : {}), height: "sm", action: { type: "postback", label, data: `sp:pick:${k}:${list}`, displayText: label } });
  return [{ type: "flex", altText: `這 ${rows.length} 張單都已經拆過帳了，要合併還是分開？`, contents: { type: "bubble", size: "kilo",
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm", contents: [
      { type: "text", text: `這 ${rows.length} 張單都已經拆過帳了`, weight: "bold", size: "md", color: C.ink, wrap: true },
      ...rows.map(r => ({ type: "box", layout: "horizontal", margin: "sm", contents: [
        { type: "text", text: "● " + (r.d.store || "帳單") + (r.d.date ? "　" + r.d.date : ""), size: "sm", color: (pal[r.d.store || "帳單"] || {}).base || C.ink, weight: "bold", flex: 6 },
        { type: "text", text: "$" + fmt(r.res.total), size: "sm", color: C.ink, align: "end", flex: 4 }] })),
      { type: "text", text: "要合併成一張，還是分開貼？", size: "sm", color: C.sub, margin: "md", wrap: true }] },
    footer: { type: "box", layout: "vertical", paddingAll: "12px", paddingTop: "0px", spacing: "sm", contents: [
      { type: "box", layout: "horizontal", spacing: "sm", contents: [btn("合併", "m", "primary"), btn("分開", "s", "secondary")] },
      { type: "text", text: "重新修改 ›", size: "xs", color: C.sub, align: "center", margin: "md", action: { type: "postback", label: "重新修改", data: `sp:pick:r:${list}`, displayText: "重新修改" } }] } } }];
}
async function pickReply(db, chatId, mode, ids, origin, isAdmin) {
  ids = ids.split(",").slice(0, 4);
  if (mode === "m") { for (const id of ids) await recordShown(db, chatId, id); const c = await combinedFor(db, chatId, ids, origin); return [c || textMessage("找不到這幾張單。")]; }
  if (mode === "s") {
    const out = [];
    for (const id of ids) { const r = await load(db, id); if (r && r.status === "done" && r.result) out.push((await elsewhereMessages(db, r, origin || r.d.origin || "", chatId))[1]); }
    return out.length ? out : [textMessage("找不到這幾張單。")];
  }
  if (!isAdmin) return [textMessage("重新修改只有 Ben 能操作。")];
  const out = [];
  for (const id of ids) out.push(...(await splitHere(db, chatId, id, origin)));
  return out.slice(0, 5);
}
/* 「今天」＝早上 6 點到隔天早上 6 點（喝到半夜的單算同一天） */
const dayKey = ms => new Date(ms + 8 * 3600e3 - 6 * 3600e3).toISOString().slice(0, 10);
/* 這群今天貼過的請款卡：這群自己拆的＋別群拆好貼過來的 */
export async function todayBills(db, chatId, now = Date.now()) {
  const day = dayKey(now);
  const shown = (await kv.json(db, "split:shown:" + chatId, [])).filter(x => dayKey(x.ts) === day);
  const own = (await db.prepare("SELECT id, COALESCE(json_extract(data,'$.cardAt'), done_at) ts FROM line_splits WHERE chat_id=? AND status='done' AND result IS NOT NULL AND done_at>?").bind(chatId, now - 2 * 864e5).all()).results.filter(x => x.ts && dayKey(x.ts) === day);
  const seen = new Set(), rows = [];
  for (const x of [...own, ...shown].sort((a, b) => a.ts - b.ts)) {
    if (seen.has(x.id)) continue; seen.add(x.id);
    const r = await load(db, x.id);
    if (r && r.status === "done" && r.result) rows.push({ ...r, res: JSON.parse(r.result) });
  }
  return rows;
}
/* 貼完一張請款卡後：今天這群還有別張單 → 問「要跟前面的單合併嗎？」（每張本來就各自記錄，合併只是多一張加總的卡） */
export async function combineAskMessages(db, chatId, curId) {
  const others = (await todayBills(db, chatId)).filter(x => x.id !== curId).slice(-3);
  if (!others.length) return [];
  const pal = storeColors([...others.map(r => r.d.store || "帳單")]);
  return [{ type: "flex", altText: `要跟今天前面的單合併嗎？`, contents: { type: "bubble", size: "kilo",
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm", contents: [
      { type: "text", text: "要跟今天前面的單合併嗎？", weight: "bold", size: "md", color: C.ink, wrap: true },
      ...others.map(r => ({ type: "box", layout: "horizontal", margin: "sm", contents: [
        { type: "text", text: "● " + (r.d.store || "帳單") + (r.d.date ? "　" + r.d.date : ""), size: "sm", color: (pal[r.d.store || "帳單"] || {}).base || C.ink, weight: "bold", flex: 6 },
        { type: "text", text: "$" + fmt(r.res.total), size: "sm", color: C.ink, align: "end", flex: 4 }] })),
      { type: "text", text: "合併會多一張加總的請款卡，每張單還是各自記錄。", size: "xxs", color: C.sub, margin: "md", wrap: true }] },
    footer: { type: "box", layout: "horizontal", paddingAll: "12px", paddingTop: "0px", spacing: "sm", contents: [
      { type: "button", style: "primary", color: C.brand, height: "sm", action: { type: "postback", label: "合併", data: "sp:cmb:" + [...others.map(r => r.id), curId].join(","), displayText: "合併" } },
      { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "不用", data: "sp:nocmb", displayText: "不用合併" } }] } } }];
}
/* 指定幾張單 → 合併請款單（都是這群的就用這群的紀錄連結；有別群的就用公開的單張分享連結） */
export async function combinedFor(db, chatId, ids, origin) {
  const b = [];
  for (const id of ids.slice(0, 4)) { const r = await load(db, id); if (r && r.status === "done" && r.result) b.push({ ...r, res: JSON.parse(r.result) }); }
  if (b.length < 2) return null;
  origin = origin || b.find(x => x.d.origin)?.d.origin || "";
  let url = null;
  let share = null;
  if (origin) {
    const toks = (await Promise.all(b.map(x => shareToken(db, x.id)))).join(",");
    url = b.every(x => x.chat_id === chatId) ? `${origin}/split?t=${await splitToken(db, chatId)}&ids=${b.map(x => x.id).join(",")}` : `${origin}/split/v?m=${toks}`;
    share = `${origin}/split/share?m=${toks}`;
  }
  return combinedCard(b, url, share);
}
export async function elsewhereMessages(db, r, origin, chatId = null) {
  const res = JSON.parse(r.result), s = origin ? await shareToken(db, r.id) : null;
  const view = s ? `${origin}/split/v?s=${s}` : null, share = s ? `${origin}/split/share?s=${s}` : null;
  const card = resultCard(r, res, view, "", share);
  // 想照這群的人另外拆：卡片最下面一行小字（只有 Ben 能按）
  card.contents.footer.contents.push({ type: "text", text: "在這群重新拆 ›", size: "xxs", color: C.sub, align: "center", margin: "md",
    action: { type: "postback", label: "在這群重新拆", data: "sp:here:" + r.id, displayText: "在這群重新拆" } });
  const out = [textMessage("這張單已經拆好了，結果在這裡👇"), card];
  if (chatId) await recordShown(db, chatId, r.id);
  return out;
}
/* 說「合併」：今天這群貼過的單（最多 4 張）合併 */
export async function combinedForChat(db, chatId, origin) {
  const b = (await todayBills(db, chatId)).slice(-4);
  return b.length < 2 ? null : combinedFor(db, chatId, b.map(x => x.id), origin);
}
export const combineCmd = t => /^(請)?(幫我)?(把)?(這|這些|剛剛|上面)?(的)?([兩二三四五幾2-9])?張?(單|帳單|請款單)?(合併|合起來|併在一起|合在一起)(成一張)?(請款單|卡片|的卡)?(吧|一下)?[。!！~～]?$/.test(String(t || "").trim());
/* 「在這群重新拆」：把別群那張單（帳單內容、照片、上次填的人和分配）複製一份到這群，給表單改 */
async function splitHere(db, chatId, srcId, origin) {
  const src = await load(db, srcId);
  if (!src || src.status !== "done") return [textMessage("找不到原本那張單。")];
  const dup = await sameBill(db, chatId, src.bill_no);
  if (dup && dup.status !== "cancelled" && dup.status !== "done") return askMessages(dup, null, false, await formLink(db, origin, chatId, dup.id));
  const { cardAt, cardFix, formAt, payee, ...d } = src.d;
  const id = rid(8);
  await db.prepare("INSERT INTO line_splits(id,chat_id,bill_no,created,created_by,status,data) VALUES(?,?,?,?,?,?,?)").bind(id, chatId, src.bill_no || null, Date.now(), null, "ask", JSON.stringify({ ...d, from: src.id })).run();
  await db.prepare("INSERT INTO line_split_imgs(split_id,n,mime,data) SELECT ?,n,mime,data FROM line_split_imgs WHERE split_id=?").bind(id, src.id).run().catch(() => {});
  return askMessages({ id, chat_id: chatId, status: "ask", d }, null, false, await formLink(db, origin, chatId, id), { text: "好，複製一份到這群，上次填的人和分配都帶好了，改一改再送出就好～" });
}
/* 已經拆過的單又貼一次：問要不要重新拆（帶出上次填的內容，只改錯的地方） */
export function redoMessages(r, formUrl, say) {
  const d = r.d, sub = [d.store, d.date, d.bill_no ? "單號 " + d.bill_no : ""].filter(Boolean).join("｜"), text = say || "這張已經拆過帳了，要重新拆帳嗎？";
  return [{ type: "flex", altText: text, contents: { type: "bubble", size: "kilo",
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm", backgroundColor: C.soft, contents: [
      { type: "text", text, size: "md", weight: "bold", color: C.ink, wrap: true },
      ...(sub ? [{ type: "text", text: sub, size: "xs", color: C.sub, wrap: true }] : []),
      { type: "text", text: "會帶出上次填的內容，只改要改的地方就好", size: "xxs", color: C.sub, wrap: true, margin: "sm" }] },
    footer: { type: "box", layout: "horizontal", paddingAll: "12px", spacing: "sm", backgroundColor: C.soft, contents: [
      { type: "button", style: "primary", color: C.brand, height: "sm", action: { type: "uri", label: "重新拆帳", uri: formUrl } },
      { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "貼出請款單", data: "sp:post:" + r.id, displayText: "貼出請款單" } }] } } }];
}
/* 這個群組進行中的那張（24 小時內） */
export const openSplit = async (db, chatId) => {
  const r = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND status IN ('ask','pick') AND created>? ORDER BY created DESC LIMIT 1").bind(chatId, Date.now() - 24 * HOUR).first();
  if (r) r.d = JSON.parse(r.data || "{}");
  return r;
};

/* ---------- 讀帳單 ---------- */
const json = t => { try { return JSON.parse((String(t).match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch (e) { return {}; } };
async function ai(env, db, chatId, body) {
  const res = await claude(env, body);
  if (res.usage) await recordAI(env, db, { chatId, model: body.model, usage: res.usage }).catch(() => {});
  return (res.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
/* 自動模式：便宜的 Haiku 先看是不是帳單（約 US$0.002／張） */
export async function looksLikeBill(env, db, chatId, img, strict) {
  const t = await ai(env, db, chatId, { model: env.BG_MODEL || "claude-sonnet-5-5", max_tokens: 300,
    system: strict
      ? "判斷這張照片是不是酒店的消費帳單（結帳單或消費明細）。必須看得到小姐的代支／檯費：小姐名字加上坐檯、點檯、訪檯、框、出場這類字，或節數。只有酒水、包廂、餐點而沒有小姐代支的（一般 KTV、酒吧、夜店、餐廳）都不算；統一發票、電子發票、網購訂單、報表、對話截圖、菜單、報價單也不算；看不太出來就回 false。只回 JSON：{\"bill\":true或false,\"bill_no\":\"單號，看不到就空字串\"}"
      : "判斷這張照片是不是消費帳單：酒店、KTV、酒吧、餐廳的結帳單、消費明細、收據、簽單都算（有品項或費用名稱加上金額，手寫的也算）。只回 JSON：{\"bill\":true或false,\"bill_no\":\"單號，看不到就空字串\"}",
    messages: [{ role: "user", content: [...(await toBlocks(img.bytes, img.type, "帳單.jpg")), { type: "text", text: "這是消費帳單嗎？" }] }] });
  // 留最後一次的判斷，查問題用
  await kv.set(db, "split:diag:" + chatId, JSON.stringify({ ts: Date.now(), type: img.type, size: img.bytes.length, raw: String(t).slice(0, 300) })).catch(() => {});
  const j = json(t);
  const yes = j.bill === true || j.bill === "true" || (!("bill" in j) && /"?bill"?\s*[:：]\s*"?true/i.test(t));
  return yes ? { bill_no: String(j.bill_no || "").trim() } : null;
}
const EXTRACT = `你是酒店／KTV 帳單判讀。照片都是同一張帳單（可能分成「消費明細」和「結帳單」兩張）。只回 JSON，不要其他字：
{"store":"店名","bill_no":"單號","date":"M/D","guests_note":"帳單上的人數標示，例如 5+0","men":男客人數（數字，看不到就 null）,"women":女客人數（數字，看不到就 null）,
 "cash_total":現金價格（數字）,"card_total":刷卡價格（數字或 null）,
 "hostess":[{"name":"小姐名字（只寫印刷的字）","mark":"名字旁邊手寫的代號，沒有就空字串","type":"坐檯／點檯／小框／全場／外全／訪檯…","time":"時間","units":節數,"amount":金額}],
 "shared":[{"name":"品名","qty":數量,"price":單價,"amount":金額,"cat":"酒／餐／包廂／低消／雜支／小費／服務費／其他"}],
 "free":["招待或 0 元的品名"],
 "unsure":["印得模糊、沒把握的小姐名字或品名，照你讀到的寫；都清楚就空陣列"],
 "note":"一句話：有沒有看不清楚或對不上的地方"}
規則：
- hostess＝代支（小姐的檯費）每一行；同一位小姐有好幾行就分開列。
- shared＝其他所有要付錢的項目：明細裡非代支的每一行（酒、餐、煙、小費…），加上只出現在結帳單的項目（包廂費、人頭低消、服務費…）。
- 不要重複：結帳單上的「酒」「餐」「代支」「雜支」「小計」是明細的合計，明細裡已經有細項就不要再列；明細沒有的類別才用結帳單的金額。
- 招待、0 元的放 free。手寫的拆帳金額、手寫的總數不要算進任何項目。
- cash_total 用「現金價格」；沒有就用最後的總計。數字不要千分位。
- 小姐名字要一字不差：熱感紙常印得糊，逐字看筆畫，選最像的常見名字用字（例如柔、菲、娜、琳、恩）；只要有一個字沒把握，就把那個名字放進 unsure，不要假裝確定。`;
export async function extractBill(env, db, chatId, imgs) {
  const content = [];
  for (const [i, im] of imgs.entries()) { content.push({ type: "text", text: `第 ${i + 1} 張：` }, ...(await toBlocks(im.bytes, im.type, "帳單.jpg"))); }
  content.push({ type: "text", text: "請讀這張帳單。" });
  const t = await ai(env, db, chatId, { model: env.BILL_MODEL || "claude-opus-5-5", max_tokens: 16000, system: EXTRACT, messages: [{ role: "user", content }] });
  const d = normalize(json(t));
  d.store = await resolveStore(db, d.store).catch(() => d.store);   // 帳單上的簡稱對到店家資料的正式名稱
  return d;
}
/* 整理成可以拆的樣子：小姐依名字合併；加總和現金價格差一點（店家進位）就加一行「差額」平分 */
export function normalize(b) {
  const num = v => Math.round(Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0);
  const hs = new Map();
  for (const h of b.hostess || []) {
    const name = String(h.name || "").replace(/[\s*＊]/g, "").trim() || "小姐";
    const g = hs.get(name) || { name, marks: [], lines: [], amount: 0 };
    g.lines.push({ type: h.type || "", time: h.time || "", units: num(h.units), amount: num(h.amount) });
    g.amount += num(h.amount);
    if (h.mark && !g.marks.includes(String(h.mark).trim())) g.marks.push(String(h.mark).trim());
    hs.set(name, g);
  }
  const hostess = [...hs.values()].map((g, i) => ({ ...g, id: "h" + i, mark: g.marks.join("／"), guest: null }));
  const shared = (b.shared || []).map(s => ({ name: String(s.name || "項目"), qty: num(s.qty) || 1, price: num(s.price), amount: num(s.amount), cat: s.cat || "其他" })).filter(s => s.amount);
  const sum = hostess.reduce((a, h) => a + h.amount, 0) + shared.reduce((a, s) => a + s.amount, 0);
  const cash = num(b.cash_total) || sum, diff = cash - sum;
  let warn = b.note && !/沒有|無|對得上|正確/.test(b.note) ? String(b.note) : "";
  if (diff && Math.abs(diff) <= Math.max(1000, cash * 0.02)) shared.push({ name: diff > 0 ? "差額（店家進位）" : "差額（店家折讓）", qty: 1, price: diff, amount: diff, cat: "其他" });
  else if (diff) warn = `讀到的項目加起來 ${fmt(sum)}，跟現金價格 ${fmt(cash)} 差 ${fmt(diff)}，請看一下是不是有項目沒讀到。` + (warn ? "\n" + warn : "");
  const unsure = (Array.isArray(b.unsure) ? b.unsure : []).map(x => String(x).trim()).filter(Boolean);
  if (unsure.length) warn = `這幾個名字印得不太清楚，請幫我確認有沒有錯字：${unsure.join("、")}` + (warn ? "\n" + warn : "");
  shared.forEach((s, i) => { s.id = "s" + i; s.who = null; });   // who＝null 代表全部平分
  const pax = v => (v === null || v === undefined || v === "" ? null : Math.min(Math.max(num(v), 0), 12));
  return { store: b.store || "", bill_no: String(b.bill_no || "").trim(), date: b.date || "", guests_note: b.guests_note || "", men: pax(b.men), women: pax(b.women),
    cash, card: num(b.card_total) || null, hostess, shared, free: b.free || [], warn, sum: sum + (diff && Math.abs(diff) <= Math.max(1000, cash * 0.02) ? diff : 0) };
}

/* ---------- 開一張新的拆帳（或把第二張照片併進同一張） ---------- */
export async function startSplit(env, db, { chatId, userId, imgs, billNo, bot }) {
  const now = Date.now();
  // 同一張單的第二張照片（同單號，或 15 分鐘內沒單號）：併進去重讀
  const open = await openSplit(db, chatId);
  let r = open && ((billNo && open.bill_no && billNo.replace(/\s/g, "") === open.bill_no.replace(/\s/g, "")) || ((!billNo || !open.bill_no) && now - open.created < 15 * 60e3)) ? open : null;
  const old = r ? await db.prepare("SELECT n,mime,data FROM line_split_imgs WHERE split_id=? ORDER BY n").bind(r.id).all() : { results: [] };
  const all = [...old.results.map(x => ({ type: x.mime, bytes: new Uint8Array(x.data) })), ...imgs].slice(0, 4);
  const d = await extractBill(env, db, chatId, all);
  if (!d.hostess.length && !d.shared.length) return { error: "這張我讀不出帳單內容，可以再拍清楚一點嗎？" };
  if (r) {
    // 已經回答過的人名、指派保留
    const keep = r.d;
    d.guests = keep.guests || []; d.merge = keep.merge || {}; if (keep.bot) d.bot = keep.bot;
    for (const h of d.hostess) { const o = (keep.hostess || []).find(x => x.name === h.name); if (o) { h.guest = o.guest; if (o.split) h.split = o.split; } }
    for (const s of d.shared) { const o = (keep.shared || []).find(x => x.name === s.name && x.amount === s.amount); if (o) { s.who = o.who; if (o.byTime) s.byTime = true; } }
    r.d = d; await save(db, r);
  } else {
    r = { id: rid(8), status: "ask", d: { ...d, guests: [], merge: {}, ...(bot && bot !== "main" ? { bot } : {}) } };   // bot＝哪個帳號讀的（推播請款卡要用同一個帳號）
    await db.prepare("INSERT INTO line_splits(id,chat_id,bill_no,created,created_by,status,data) VALUES(?,?,?,?,?,?,?)").bind(r.id, chatId, d.bill_no || null, now, userId || null, "ask", JSON.stringify(r.d)).run();
  }
  let n = old.results.length;
  for (const im of imgs) if (n < 4 && im.bytes.length < 1.9 * 1024 * 1024) await db.prepare("INSERT OR REPLACE INTO line_split_imgs(split_id,n,mime,data) VALUES(?,?,?,?)").bind(r.id, n++, im.type || "image/jpeg", im.bytes.buffer.slice(im.bytes.byteOffset, im.bytes.byteOffset + im.bytes.byteLength)).run();   // D1：ArrayBuffer 存成 BLOB
  return { split: r, merged: !!open && r.id === open.id, photos: all.length };
}

/* ---------- 貼單後：只回一句＋「填寫拆帳表單」按鈕（不列帳目，人數照帳單在表單裡開好） ---------- */
export function askMessages(r, adminId, merged, formUrl, opt = {}) {
  const d = r.d, sub = [d.store, d.date, d.bill_no ? "單號 " + d.bill_no : ""].filter(Boolean).join("｜");
  const text = opt.text || (merged ? "第二張也讀進來了。如要拆單服務，請填寫表單。" : "如要拆單服務，請填寫表單。");
  if (!formUrl) return [textMessage((opt.tease ? opt.tease + "\n" : "") + text)];
  return [{ type: "flex", altText: (opt.tease ? opt.tease + " " : "") + text, contents: { type: "bubble", size: "kilo",
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm", backgroundColor: C.soft, contents: [
      ...(opt.tease ? [{ type: "text", text: opt.tease, size: "sm", color: C.brand, weight: "bold", wrap: true }] : []),
      { type: "text", text, size: "md", weight: "bold", color: C.ink, wrap: true },
      ...(sub ? [{ type: "text", text: sub, size: "xs", color: C.sub, wrap: true }] : [])] },
    footer: { type: "box", layout: "horizontal", paddingAll: "12px", spacing: "sm", backgroundColor: C.soft, contents: [
      { type: "button", style: "primary", color: C.brand, height: "sm", action: { type: "uri", label: "填寫拆帳表單", uri: formUrl } },
      { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "貼出請款單", data: "sp:post:" + r.id, displayText: "貼出請款單" } }] } } }];
}
/* ---------- 計算：精確分攤，最後四捨五入到個位數並讓加總剛好等於帳單 ---------- */
export function compute(d) {
  const ids = d.guests.map(g => g.id), raw = Object.fromEntries(ids.map(id => [id, { hostess: 0, shared: 0, items: [] }]));
  for (const h of d.hostess) {
    // split＝分給多人：[{u: 節數, who: [客人]}]，每段依節數比例算錢、段內平分
    const segs = (h.split || []).map(sg => ({ u: Number(sg.u) || 0, who: (sg.who || []).filter(id => raw[id]) })).filter(sg => sg.u > 0 && sg.who.length);
    if (segs.length) {
      const U = segs.reduce((a, sg) => a + sg.u, 0);
      for (const sg of segs) for (const id of sg.who) {
        const amt = h.amount * sg.u / U / sg.who.length;
        raw[id].hostess += amt;
        raw[id].items.push({ name: "小姐｜" + h.name + (segs.length > 1 ? `（${sg.u}節${sg.who.length > 1 ? "÷" + sg.who.length : ""}）` : sg.who.length > 1 ? `（÷${sg.who.length}）` : ""), amount: amt });
      }
    } else if (h.guest && raw[h.guest]) { raw[h.guest].hostess += h.amount; raw[h.guest].items.push({ name: "小姐｜" + h.name, amount: h.amount }); }
  }
  // 在場節數：整晚 night 節，減掉這個人晚到／早走的節數（late）
  const night = Number(d.night) || 0, here = id => { const g = d.guests.find(x => x.id === id); return Math.max(night - (Number(g?.late) || 0), 0); };
  for (const s of d.shared) {
    const who = (s.who && s.who.length ? s.who : ids).filter(id => raw[id]);
    const timed = s.byTime && night > 0 && who.some(id => here(id) < night);
    const W = timed ? who.reduce((a, id) => a + here(id), 0) : 0;
    for (const id of who) {
      const amt = timed ? (W ? s.amount * here(id) / W : 0) : s.amount / who.length;
      raw[id].shared += amt;
      raw[id].items.push({ name: s.name + (timed ? `（在場 ${here(id)}/${night} 節）` : who.length > 1 ? `（${who.length} 人分）` : ""), amount: amt });
    }
  }
  const exact = ids.map(id => raw[id].hostess + raw[id].shared), target = Math.round(exact.reduce((a, b) => a + b, 0));
  const fl = exact.map(Math.floor); let left = target - fl.reduce((a, b) => a + b, 0);
  exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { fl[i]++; left--; } });
  const people = d.guests.map((g, i) => {
    // 明細四捨五入後跟個人總額差的幾元，加在金額最大的公費項目上，讓明細加起來剛好等於總額
    const items = raw[g.id].items.map(x => ({ ...x, amount: Math.round(x.amount) }));
    const gap = fl[i] - items.reduce((a, x) => a + x.amount, 0);
    if (gap) { const pool = items.filter(x => !x.name.startsWith("小姐｜")); const big = (pool.length ? pool : items).reduce((a, x) => (x.amount > a.amount ? x : a), (pool.length ? pool : items)[0]); if (big) big.amount += gap; }
    const hostess = Math.round(raw[g.id].hostess);
    return { id: g.id, name: g.name, sex: g.sex, total: fl[i], hostess, shared: fl[i] - hostess, items };
  });
  const payers = [];
  for (const p of people) {
    const to = d.merge[p.id] || p.id;
    let pay = payers.find(x => x.id === to);
    if (!pay) { const g = people.find(x => x.id === to); pay = { id: to, name: g.name, total: 0, includes: [] }; payers.push(pay); }
    pay.total += p.total;
    if (to !== p.id) pay.includes.push({ name: p.name, total: p.total });
  }
  payers.sort((a, b) => d.guests.findIndex(g => g.id === a.id) - d.guests.findIndex(g => g.id === b.id));
  return { total: target, people, payers };
}
/* 請款卡：每位付款人底下直接列明細（併給他的人也列在下面） */
const short = n => String(n).replace(/（(\d+) 人分）/, " ÷$1").replace(/^小姐｜/, "小姐 ");
const itemRow = (x, indent) => ({ type: "box", layout: "horizontal", contents: [
  { type: "text", text: (indent ? "　" : "") + short(x.name), size: "xxs", color: C.sub, flex: 7, wrap: true },
  { type: "text", text: fmt(x.amount), size: "xxs", color: C.sub, align: "end", flex: 3 }] });
export function resultCard(r, res, url, editUrl, shareUrl) {
  const d = r.d;
  // 每個人只寫「小姐＋公帳分攤」兩個數字；整列點下去看自己的明細（網頁直接打開這個人那一段）
  // 這張單付最多的人（同額就都算）：恩客NO.1
  const top = res.payers.length > 1 ? Math.max(...res.payers.map(x => x.total)) : null;
  const rows = res.payers.flatMap((p, i) => {
    const person = res.people.find(x => x.id === p.id);
    const merged = res.people.filter(x => x.id !== p.id && (d.merge || {})[x.id] === p.id);
    const vip = top !== null && p.total === top && top > 0;
    const all = [person, ...merged], hostess = all.reduce((a, x) => a + (x.hostess || 0), 0), shared = all.reduce((a, x) => a + (x.shared || 0), 0);
    const link = url ? `${url}&p=${encodeURIComponent(p.id)}#p-${encodeURIComponent(p.id)}` : null;
    // 恩客NO.1：淡金底、金邊、橘色徽章，金額也換成金橘色
    return [...(i ? [{ type: "separator", color: C.line, margin: "md" }] : []), { type: "box", layout: "horizontal", alignItems: "center", spacing: "md", margin: i ? "md" : "none",
      paddingAll: "10px", ...(vip ? { backgroundColor: "#FFF6EA", cornerRadius: "14px", borderWidth: "1px", borderColor: "#F6C48F" } : {}),
      ...(link ? { action: { type: "uri", label: "明細", uri: link } } : {}), contents: [
      { type: "box", layout: "vertical", flex: 6, spacing: "xs", contents: [
        ...(vip ? [{ type: "box", layout: "horizontal", contents: [{ type: "box", layout: "vertical", flex: 0, backgroundColor: C.accent, cornerRadius: "999px", paddingStart: "8px", paddingEnd: "8px", paddingTop: "2px", paddingBottom: "2px",
          contents: [{ type: "text", text: "👑 恩客NO.1 ✨", size: "xxs", weight: "bold", color: "#FFFFFF" }] }] }] : []),
        { type: "text", text: p.name, size: "md", weight: "bold", color: vip ? "#9A4A0B" : C.ink, wrap: true },
        { type: "text", text: `小姐 ${fmt(hostess)}　公帳分攤 ${fmt(shared)}`, size: "xs", color: C.sub, wrap: true },
        ...(merged.length ? [{ type: "text", text: "含 " + merged.map(m => `${m.name} ${fmt(m.total)}`).join("、"), size: "xs", color: C.accent, wrap: true }] : [])] },
      { type: "box", layout: "vertical", flex: 4, alignItems: "flex-end", contents: [
        { type: "text", text: "$" + fmt(p.total), size: "lg", weight: "bold", color: vip ? "#D9731A" : storeColor(d.store).base, align: "end" },
        ...(link ? [{ type: "text", text: "明細 ›", size: "xs", color: C.accent, align: "end", weight: "bold" }] : [])] }] }];
  });
  const sc = storeColor(d.store);
  return { type: "flex", altText: "請款單：" + res.payers.map(p => `${p.name} $${fmt(p.total)}`).join("、"), contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: sc.base, background: { type: "linearGradient", angle: "135deg", startColor: sc.base, endColor: sc.deep }, paddingAll: "16px", contents: [
      { type: "text", text: sc.mark, position: "absolute", offsetEnd: "14px", offsetTop: "-4px", size: "5xl", weight: "bold", color: sc.deep },
      { type: "text", text: "請款單", color: sc.accent, size: "xs" },
      { type: "text", text: [d.store, d.date].filter(Boolean).join("｜") || "帳單", color: "#FFFFFF", weight: "bold", size: "lg", wrap: true },
      { type: "box", layout: "horizontal", margin: "md", contents: [
        { type: "text", text: "現金總額", color: sc.accent, size: "sm", flex: 1, gravity: "bottom" },
        { type: "text", text: "$" + fmt(res.total), color: "#FFFFFF", weight: "bold", size: "xl", align: "end", flex: 2 }] },
      ...(d.payee ? [{ type: "text", text: payeeLine(d.payee, res.payers, res.total), color: sc.accent, size: "sm", weight: "bold", margin: "sm", align: "end", wrap: true }] : [])] },
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "md", contents: rows },
    footer: { type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", spacing: "sm", contents: [
      { type: "text", text: `${d.guests.length} 人｜${d.hostess.length} 位小姐｜點名字看自己的明細`, size: "xxs", color: C.sub, align: "center" },
      { type: "box", layout: "horizontal", spacing: "sm", contents: [
        ...(url ? [{ type: "button", style: "primary", color: sc.base, height: "sm", action: { type: "uri", label: "整張明細", uri: url } }] : []),
        ...(shareUrl ? [{ type: "button", style: "secondary", color: sc.tint, height: "sm", action: { type: "uri", label: "分享", uri: shareUrl } }] : !url && editUrl ? [{ type: "button", style: "secondary", color: C.soft, height: "sm", action: { type: "uri", label: "修改", uri: editUrl } }] : [])] },
      ...(editUrl && (url || shareUrl) ? [{ type: "text", text: "修改拆帳 ›", size: "xxs", color: C.sub, align: "center", margin: "md", action: { type: "uri", label: "修改", uri: editUrl } }] : [])] } } };
}

/* ---------- 舊版卡片的按鈕（現在改用表單） ---------- */
export async function splitPostback(env, db, { chatId, data, isAdmin, origin }) {
  const pm = data.match(/^sp:post:(\w+)$/);
  if (pm) {
    const r = await load(db, pm[1]);
    if (!r || r.chat_id !== chatId) return [textMessage("找不到這張帳單。")];
    if (r.status !== "done") return [textMessage("表單還沒送出，填好按「送出結算」後再按一次。")];
    return replyCard(db, r);
  }
  const pk = data.match(/^sp:pick:([msr]):([\w,]+)$/);
  if (pk) return pickReply(db, chatId, pk[1], pk[2], origin, isAdmin);
  const cm = data.match(/^sp:cmb:([\w,]+)$/);
  if (cm) { const c = await combinedFor(db, chatId, cm[1].split(","), origin); return [c || textMessage("找不到這幾張單。")]; }
  if (data === "sp:nocmb") return [textMessage("好，分開就好～")];
  const m = data.match(/^sp:(\w+):/);
  if (!m) return null;
  if (!isAdmin) return [textMessage("拆帳只有 Ben 能操作。")];
  const hm = data.match(/^sp:here:(\w+)$/);
  if (hm) return splitHere(db, chatId, hm[1], origin);
  const r = await load(db, m[1]);
  if (!r || r.chat_id !== chatId) return [textMessage("找不到這張帳單。")];
  const url = await formLink(db, origin, chatId, r.id);
  return [textMessage("拆帳改成用表單填了，點這裡：\n" + url)];
}

/* ---------- 表單送出：套用名單、指派、分攤 → 結算 → @All 拆帳完畢＋請款卡（推播） ---------- */
export async function finishForm(env, db, line, { chatId, id, body, origin, defer }) {
  const r = await load(db, id);
  if (!r || r.chat_id !== chatId) return { error: "找不到這張帳單" };
  if (r.status === "cancelled") return { error: "這張已經取消了" };
  const { guests, merge } = cleanDraft(body);
  if (!guests.length) return { error: "至少要填一位客人" };
  const byName = n => guests.find(g => g.name === String(n || "").trim());
  const d = r.d, assign = body.hostess || {}, share = body.shared || {};
  const miss = [];
  for (const h of d.hostess) {
    const a = assign[h.id];
    h.guest = null; delete h.split;
    if (a && typeof a === "object" && !Array.isArray(a)) {
      // 多人平分 {even:[名字]}，或分段 {segs:[{u:節數, who:[名字]}]}
      const raw = Array.isArray(a.segs) ? a.segs : Array.isArray(a.even) ? [{ u: 1, who: a.even }] : [];
      const segs = raw.map(sg => ({ u: Math.max(0, Number(sg.u) || 0), who: [...new Set((sg.who || []).map(byName).filter(Boolean).map(g => g.id))] }));
      if (!segs.length || segs.some(sg => !sg.who.length)) { miss.push(h.name); continue; }
      if (segs.some(sg => !(sg.u > 0))) return { error: `「${h.name}」每一段都要填節數` };
      if (segs.length === 1 && segs[0].who.length === 1) h.guest = segs[0].who[0]; else h.split = segs;
    } else { const g = byName(a); if (g) h.guest = g.id; else miss.push(h.name); }
  }
  if (miss.length) return { error: "還有小姐沒選客人：" + miss.join("、") };
  // 整晚幾節、哪些公費照在場時間分
  d.night = Math.max(0, Math.min(200, Math.round(Number(body.night) || 0))) || undefined;
  if (guests.some(g => g.late) && !d.night) return { error: "有人晚到／早走，請填「整晚共幾節」" };
  if (guests.some(g => g.late >= d.night)) return { error: "晚到／早走的節數不能大於整晚節數" };
  const bt = body.byTime || {};
  for (const sh of d.shared) {
    if (bt[sh.id]) sh.byTime = true; else delete sh.byTime;
    const v = share[sh.id];
    if (!Array.isArray(v)) { sh.who = null; continue; }
    const ids = v.map(byName).filter(Boolean).map(g => g.id);
    if (!ids.length) return { error: `「${sh.name}」至少要有一個人分` };
    sh.who = ids.length === guests.length ? null : ids;
  }
  d.guests = guests; d.merge = merge;
  const payee = String(body.payee || "").replace(/\s+/g, " ").trim().slice(0, 20);   // 買單人（選填）：請款單寫「轉給 XX」
  if (payee) d.payee = payee; else delete d.payee;
  const res = compute(d), fix = r.status === "done";
  d.formAt = Date.now();
  await db.prepare("UPDATE line_splits SET data=?, status='done', result=?, done_at=? WHERE id=?").bind(JSON.stringify(d), JSON.stringify(res), Date.now(), r.id).run();
  // 請款卡不在這裡推播（推播要錢）：等有人在聊天室按「貼出請款單」或說「請款單」再用回覆貼（免費）；10 分鐘沒人按，計時器才推播
  d.origin = origin || d.origin; d.cardAt = null; d.cardFix = fix;
  await db.prepare("UPDATE line_splits SET data=? WHERE id=?").bind(JSON.stringify(d), r.id).run();
  if (!defer && line && env.SPLIT_PUSH_NOW === "1") await pushCard(db, clientFor(env, d.bot) || line, { ...r, d }).catch(e => console.log("split push failed", e.message));
  return { ok: true, posted: false, waiting: true, fix, total: res.total, payers: res.payers.map(p => ({ name: p.name, total: p.total, includes: p.includes })) };
}

/* 請款卡訊息：@All 拆帳完畢（更正）＋請款卡 */
export async function cardMessages(db, r) {
  const d = r.d, res = r.result ? (typeof r.result === "string" ? JSON.parse(r.result) : r.result) : compute(d), g = isGroup(r.chat_id), fix = !!d.cardFix, origin = d.origin || "";
  const url = origin ? `${origin}/split?t=${await splitToken(db, r.chat_id)}&id=${r.id}` : null;
  let head = fix ? "拆帳更正（以這張為準）" : "拆帳完畢";
  if (d.bot === "miao") head = await pick(db, r.chat_id, fix ? "fix" : "card");
  if (d.payee) head += "\n" + (d.bot === "miao" ? await pick(db, r.chat_id, "payee", { p: d.payee }) : "請轉給 " + d.payee);
  const share = origin ? `${origin}/split/share?s=${await shareToken(db, r.id)}` : null;
  return [g ? mentionMessage("{who} " + head, "all") : textMessage(head), resultCard(r, res, url, await formLink(db, origin, r.chat_id, r.id).catch(() => ""), share)];
}
const markPosted = (db, r) => { r.d.cardAt = Date.now(); return db.prepare("UPDATE line_splits SET data=? WHERE id=?").bind(JSON.stringify(r.d), r.id).run(); };
/* 用回覆貼請款卡（免費）：按鈕或「請款單」 */
export async function replyCard(db, r) {
  const fresh = await load(db, r.id);
  const msgs = await cardMessages(db, fresh);
  await markPosted(db, fresh);
  return [...msgs, ...(fresh.d.cardFix ? [] : await combineAskMessages(db, fresh.chat_id, fresh.id))];
}

/* 收款人（幹部）也在帳單裡：大家轉給他，他自己那份不用轉 → 要收＝總額－他自己的 */
export function payeeLine(payee, people, total) {
  const me = people.find(p => p.name.trim() === String(payee).trim());
  return me ? `請轉給 ${payee}：共 $${fmt(total - me.total)}（${payee} 自己的 ${fmt(me.total)} 不用轉）` : `請轉給 ${payee}：共 $${fmt(total)}`;
}
/* ---------- 一次貼好幾張單：各自拆完、各自貼完後，另外貼一張「合併請款單」 ---------- */
// 同一個聊天室、前後 20 分鐘內貼的帳單算同一批（一張接一張，間隔都在 20 分鐘內）
const BATCH_GAP = 20 * 60e3;
export async function batchOf(db, r) {
  const { results } = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND status!='cancelled' AND created BETWEEN ? AND ? ORDER BY created").bind(r.chat_id, r.created - 6 * 3600e3, r.created + 6 * 3600e3).all();
  const groups = [];
  for (const x of results) { const g = groups[groups.length - 1]; if (g && x.created - g[g.length - 1].created <= BATCH_GAP) g.push(x); else groups.push([x]); }
  return (groups.find(g => g.some(x => x.id === r.id)) || []).map(x => ({ ...x, d: JSON.parse(x.data || "{}"), res: x.result ? JSON.parse(x.result) : null }));
}
/* 合併：同名的人加總，每家店分開記（店名、小姐、公帳分攤、併給他的人） */
export function combine(bills) {
  const people = new Map();
  for (const b of bills) {
    const res = b.res, d = b.d;
    for (const p of res.payers) {
      const person = res.people.find(x => x.id === p.id), merged = res.people.filter(x => x.id !== p.id && (d.merge || {})[x.id] === p.id), all = [person, ...merged];
      const key = p.name.trim();
      if (!people.has(key)) people.set(key, { name: p.name, total: 0, stores: [] });
      const e = people.get(key);
      e.total += p.total;
      e.stores.push({ id: b.id, store: d.store || "帳單", date: d.date || "", total: p.total, hostess: all.reduce((a, x) => a + (x.hostess || 0), 0), shared: all.reduce((a, x) => a + (x.shared || 0), 0), includes: merged.map(m => ({ name: m.name, total: m.total })) });
    }
  }
  const list = [...people.values()];
  return { people: list, total: bills.reduce((a, b) => a + b.res.total, 0), top: list.length > 1 ? Math.max(...list.map(x => x.total)) : null };
}
export function combinedCard(bills, url, shareUrl = null) {
  const c = combine(bills), stores = bills.map(b => b.d.store || "帳單"), pal = storeColors(stores), storeColor = n => pal[n || "帳單"] || pal[n];
  const payee = [...new Set(bills.map(b => b.d.payee).filter(Boolean))];
  const rows = c.people.flatMap((p, i) => {
    const vip = c.top !== null && p.total === c.top && c.top > 0;
    const link = url ? `${url}&p=${encodeURIComponent(p.name)}#p-${encodeURIComponent(p.name)}` : null;
    return [...(i ? [{ type: "separator", color: C.line, margin: "md" }] : []), { type: "box", layout: "horizontal", alignItems: "center", spacing: "md", margin: i ? "md" : "none",
      paddingAll: "10px", ...(vip ? { backgroundColor: "#FFF6EA", cornerRadius: "14px", borderWidth: "1px", borderColor: "#F6C48F" } : {}),
      ...(link ? { action: { type: "uri", label: "明細", uri: link } } : {}), contents: [
      { type: "box", layout: "vertical", flex: 6, spacing: "xs", contents: [
        ...(vip ? [{ type: "box", layout: "horizontal", contents: [{ type: "box", layout: "vertical", flex: 0, backgroundColor: C.accent, cornerRadius: "999px", paddingStart: "8px", paddingEnd: "8px", paddingTop: "2px", paddingBottom: "2px",
          contents: [{ type: "text", text: "👑 恩客NO.1 ✨", size: "xxs", weight: "bold", color: "#FFFFFF" }] }] }] : []),
        { type: "text", text: p.name + (payee.length === 1 && payee[0].trim() === p.name.trim() ? "（收款人，自己的不用轉）" : ""), size: "md", weight: "bold", color: vip ? "#9A4A0B" : C.ink, wrap: true },
        ...p.stores.map(s => ({ type: "text", wrap: true, contents: [
          { type: "span", text: "● ", size: "xs", color: storeColor(s.store).base },
          { type: "span", text: s.store + "　", size: "xs", weight: "bold", color: storeColor(s.store).base },
          { type: "span", text: fmt(s.total) + (s.includes.length ? "（含 " + s.includes.map(x => x.name).join("、") + "）" : ""), size: "xs", color: C.sub }] }))] },
      { type: "box", layout: "vertical", flex: 4, alignItems: "flex-end", contents: [
        { type: "text", text: "$" + fmt(p.total), size: "lg", weight: "bold", color: vip ? "#D9731A" : C.brand, align: "end" },
        ...(link ? [{ type: "text", text: "明細 ›", size: "xs", color: C.accent, align: "end", weight: "bold" }] : [])] }] }];
  });
  return { type: "flex", altText: "合併請款單：" + c.people.map(p => `${p.name} $${fmt(p.total)}`).join("、"), contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: "#0E3F3D", paddingAll: "16px", contents: [
      { type: "text", text: `合併請款單（${bills.length} 張）`, color: "#FFD9B0", size: "xs", weight: "bold" },
      { type: "text", text: stores.join("＋"), color: "#FFFFFF", weight: "bold", size: "lg", wrap: true },
      { type: "box", layout: "horizontal", margin: "md", contents: [
        { type: "text", text: "合計", color: "#CFE3E1", size: "sm", flex: 1, gravity: "bottom" },
        { type: "text", text: "$" + fmt(c.total), color: "#FFFFFF", weight: "bold", size: "xl", align: "end", flex: 2 }] },
      ...bills.map(b => ({ type: "box", layout: "horizontal", margin: "xs", alignItems: "center", contents: [
        { type: "box", layout: "vertical", flex: 0, backgroundColor: storeColor(b.d.store).tint, cornerRadius: "999px", paddingStart: "8px", paddingEnd: "8px", paddingTop: "1px", paddingBottom: "1px",
          contents: [{ type: "text", text: b.d.store || "帳單", color: storeColor(b.d.store).base, size: "xxs", weight: "bold" }] },
        { type: "filler" },
        { type: "text", text: "$" + fmt(b.res.total), color: "#CFE3E1", size: "xxs", align: "end", flex: 0 }] })),
      ...(payee.length === 1 ? [{ type: "text", text: payeeLine(payee[0], c.people, c.total), color: "#FFD9B0", size: "sm", weight: "bold", margin: "sm", align: "end", wrap: true }] : [])] },
    body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "md", contents: rows },
    footer: { type: "box", layout: "vertical", paddingAll: "16px", paddingTop: "0px", spacing: "sm", contents: [
      { type: "text", text: "每張單各自的請款卡照舊；這張是全部加起來，點名字看每家店的明細", size: "xxs", color: C.sub, align: "center", wrap: true },
      { type: "box", layout: "horizontal", spacing: "sm", contents: [
        ...(url ? [{ type: "button", style: "primary", color: C.brand, height: "sm", action: { type: "uri", label: "整份合併明細", uri: url } }] : []),
        ...(shareUrl ? [{ type: "button", style: "secondary", color: C.soft, height: "sm", action: { type: "uri", label: "分享", uri: shareUrl } }] : [])] }] } } };
}
/* 這一批每張都拆完、都貼過請款卡了，就附上合併請款單（跟最後一張一起貼，不多花推播） */
export async function combinedMessages(db, r) {
  const b = await batchOf(db, r);
  if (b.length < 2 || b.some(x => x.status !== "done" || !x.res || (x.id !== r.id && !x.d.cardAt))) return [];
  const origin = r.d.origin || b.find(x => x.d.origin)?.d.origin || "";
  const url = origin ? `${origin}/split?t=${await splitToken(db, r.chat_id)}&ids=${b.map(x => x.id).join(",")}` : null;
  const share = origin ? `${origin}/split/share?m=${(await Promise.all(b.map(x => shareToken(db, x.id)))).join(",")}` : null;
  return [combinedCard(b, url, share)];
}
/* ---------- 給聊天 AI 的拆帳資料：最近拆完的帳單、每個人要付多少、合併後多少（AI 不要自己重讀照片算） ---------- */
export async function splitContext(db, chatId) {
  const { results } = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND status='done' AND result IS NOT NULL AND created>? ORDER BY created DESC LIMIT 6").bind(chatId, Date.now() - 36 * 3600e3).all();
  if (!results.length) return "";
  const latest = { ...results[0], d: JSON.parse(results[0].data || "{}") };
  const batch = await batchOf(db, latest);
  const ids = new Set(batch.map(b => b.id));
  const one = r => { const d = JSON.parse(r.data || "{}"), res = JSON.parse(r.result); return `【${d.store || "帳單"}｜${d.date || ""}｜現金總額 ${fmt(res.total)}${d.payee ? "｜收款人 " + d.payee : ""}】` + res.payers.map(p => { const pe = res.people.find(x => x.id === p.id); return `${p.name} ${fmt(p.total)}（小姐 ${fmt(pe.hostess)}、公帳分攤 ${fmt(pe.shared)}${p.includes.length ? "、含 " + p.includes.map(x => x.name + " " + fmt(x.total)).join("、") : ""}）`; }).join("；"); };
  let t = `\n\n這個聊天室最近拆好的帳單（已經用表單算好，金額以這裡為準；不要再自己看照片重算，也不要猜誰是幹部）：\n${results.filter(r => ids.has(r.id)).map(one).join("\n")}`;
  if (batch.length > 1) { const c = combine(batch); t += `\n這幾張是同一批，合併後每人：${c.people.map(p => `${p.name} ${fmt(p.total)}`).join("、")}；合計 ${fmt(c.total)}。`; }
  t += `\n算錢規則：有人（通常是幹部）負責收錢時，其他人把自己的金額轉給他；收款人自己那份是他自己出的，不用轉給自己。所以「要付給收款人的總額＝合計－收款人自己的金額」，每個人要轉的就是他自己的金額。老闆說錢交給某人／某人收款時，用 split_payee 設定收款人（會貼出寫好「請轉給誰、共多少」的請款卡），再用一兩句說結果。`;
  return t;
}
export const SPLIT_TOOLS = [{ name: "split_payee", description: "設定最近這一批拆好的帳單由誰收款（例如「錢都交給蚊子」）。會算好每個人要轉給他多少、他自己那份不用轉、總共要收多少，並貼出新的請款卡。name 要是帳單上的名字。", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }];
export async function runSplitTool(ctx, name, input) {
  if (name !== "split_payee") return null;
  const { db, chatId } = ctx;
  const latest = await db.prepare("SELECT * FROM line_splits WHERE chat_id=? AND status='done' AND result IS NOT NULL AND created>? ORDER BY created DESC LIMIT 1").bind(chatId, Date.now() - 36 * 3600e3).first();
  if (!latest) return { error: "這裡最近沒有拆好的帳單" };
  const batch = await batchOf(db, { ...latest, d: JSON.parse(latest.data || "{}") });
  const all = batch.flatMap(b => b.res.payers.map(p => p.name.trim()));
  const want = String(input.name || "").trim();
  const who = all.find(n => n === want) || all.find(n => n.includes(want) || want.includes(n)) || want;
  for (const b of batch) { b.d.payee = who; await db.prepare("UPDATE line_splits SET data=? WHERE id=?").bind(JSON.stringify(b.d), b.id).run(); }
  const people = batch.length > 1 ? combine(batch).people : batch[0].res.payers, total = batch.reduce((a, b) => a + b.res.total, 0);
  const me = people.find(p => p.name.trim() === who);
  const origin = batch.find(b => b.d.origin)?.d.origin || "";
  if (batch.length > 1) { const url = origin ? `${origin}/split?t=${await splitToken(db, chatId)}&ids=${batch.map(x => x.id).join(",")}` : null; (ctx.cards ||= []).push(combinedCard(batch, url)); }
  else { const r = batch[0]; const url = origin ? `${origin}/split?t=${await splitToken(db, chatId)}&id=${r.id}` : null; (ctx.cards ||= []).push(resultCard(r, r.res, url, "", origin ? `${origin}/split/share?s=${await shareToken(db, r.id)}` : null)); }
  return { ok: true, payee: who, payee_in_bill: !!me, payee_own: me ? me.total : 0, total_bills: total, collect_total: total - (me ? me.total : 0), each_transfer: people.filter(p => p.name.trim() !== who).map(p => ({ name: p.name, amount: p.total })), note: "請款卡已附在回覆後面，只要用一兩句說結果" };
}
/* 推播（要錢）：10 分鐘沒人按「貼出請款單」的備援 */
export async function pushCard(db, line, r) {
  const fresh = await load(db, r.id);
  const msgs = [...(await cardMessages(db, fresh)), ...(fresh.d.cardFix ? [] : await combineAskMessages(db, fresh.chat_id, fresh.id))];
  await line.push(fresh.chat_id, msgs);
  await markPosted(db, fresh);
  await recordPush(db, fresh.chat_id, isGroup(fresh.chat_id) ? await line.memberCount(fresh.chat_id).catch(() => 1) : 1).catch(() => {});
}
/* 帳單是哪個帳號讀的，就用哪個帳號發（main＝小幫手） */
export const clientFor = (env, bot) => bot === "miao" ? (env.MIAO_CHANNEL_TOKEN ? lineClient(env.MIAO_CHANNEL_TOKEN) : null) : env.LINE_CHANNEL_TOKEN ? lineClient(env.LINE_CHANNEL_TOKEN) : null;
export async function pendingCards(env, db, line, now = Date.now()) {
  const wait = (Number(env.SPLIT_CARD_WAIT_MIN) || 10) * 60e3;
  const { results } = await db.prepare("SELECT * FROM line_splits WHERE status='done' AND done_at BETWEEN ? AND ?").bind(now - 864e5, now - wait).all();
  let n = 0;
  for (const r of results) {
    const d = JSON.parse(r.data || "{}");
    if (d.cardAt !== null || !d.formAt) continue;   // 已經貼過，或舊資料
    const ln = d.bot ? clientFor(env, d.bot) : line;   // 拆帳喵讀的單要用拆帳喵推播（小幫手不在那個群組）
    if (!ln) continue;
    try { await pushCard(db, ln, r); n++; } catch (e) { console.log("card push failed", e.message); }
  }
  return n;
}

/* 表單的客人名單：去重、併給的人一路找到最後付錢的人 */
export function cleanDraft(input) {
  const rows = (Array.isArray(input?.guests) ? input.guests : []).slice(0, 12);
  const guests = [], seen = new Set();
  for (const g of rows) { const name = String(g.name || "").replace(/\s+/g, " ").trim().slice(0, 20); if (name && !seen.has(name)) { seen.add(name); const late = Math.max(0, Math.min(200, Math.round(Number(g.late) || 0))); guests.push({ id: "g" + guests.length, name, sex: g.sex === "女" ? "女" : g.sex === "男" ? "男" : "", to: String(g.to || "").trim(), ...(late ? { late } : {}) }); } }
  const merge = {};
  for (const g of guests) {
    // 併給的人如果自己也併給別人，一路找到最後付錢的人（避免繞圈）
    let to = guests.find(x => x.name === g.to), hops = 0;
    while (to && to.to && hops++ < 12) { const nx = guests.find(x => x.name === to.to); if (!nx || nx.id === g.id) break; to = nx; }
    if (to && to.id !== g.id) merge[g.id] = to.id;
  }
  return { guests: guests.map(({ to, ...g }) => g), merge };
}
export { load as loadSplit };
