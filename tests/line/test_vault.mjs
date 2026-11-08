// 私人助理群：不用 @、照片檔案自動存檔、找東西傳回來、記事本、秘書個性只在私人空間
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
try { sq.exec("ALTER TABLE line_memory ADD COLUMN chat_id TEXT"); } catch (e) {}
sq.prepare("INSERT OR IGNORE INTO line_reports(month,data,created) VALUES(?,?,?)").run(new Date(Date.now() + 8 * 3600e3 - 2 * 864e5).toISOString().slice(0, 7), "{}", Date.now());
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v instanceof ArrayBuffer ? new Uint8Array(v) : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
sq.prepare("INSERT INTO line_kv VALUES('admins',?)").run(JSON.stringify(["U_ben"]));
sq.prepare("INSERT INTO line_kv VALUES('gas:conf',?)").run(JSON.stringify({ url: "https://gas.example/exec", key: "k" }));
const P = "Cpriv", G = "Cwork";
const members = { [P]: 1, [G]: 3 };
let calls = [], claudeBodies = [], gasOk = true, plan = null, sentN = 0;
const JPG = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]);
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  const m = url.match(/\/group\/(\w+)\/members\/count/); if (m) return J({ count: members[m[1]] || 1 });
  if (/\/group\/\w+\/member\/(\w+)/.test(url) || /\/profile\//.test(url)) return J({ displayName: url.includes("U_ben") ? "Ben" : "Amy" });
  if (url.includes("/content")) return new Response(JPG, { status: 200, headers: { "content-type": "image/jpeg" } });
  if (url.endsWith("/message/reply") || url.endsWith("/message/push")) return J({ sentMessages: (body.messages || []).map(() => ({ id: "s" + (++sentN) })) });
  if (url.startsWith("https://gas.example")) {
    if (body.fn === "saveFile") return gasOk ? J({ ok: true, result: { id: "D1", url: "https://drive.google.com/file/d/D1/view", name: body.args[0] } }) : J({ ok: false, error: "unknown fn" });
    if (body.fn === "readFile") return J({ ok: true, result: { kind: "blob", mime: "image/jpeg", data: Buffer.from(JPG).toString("base64") } });
    return J({ ok: true, result: {} });
  }
  if (url.includes("api.anthropic.com")) {
    claudeBodies.push(body);
    if (/描述這張照片/.test(JSON.stringify(body.messages))) return J({ content: [{ type: "text", text: "黃色疏文，蓋了紅色印章" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    const last = JSON.stringify(body.messages.at(-1));
    if (plan && !last.includes("tool_result")) { const p = plan; return J({ content: [{ type: "tool_use", id: "t1", name: p.name, input: p.input }], stop_reason: "tool_use", usage: {} }); }
    if (plan && last.includes("tool_result") && plan.next) { const p = plan.next; plan = { ...plan, next: null }; return J({ content: [{ type: "tool_use", id: "t2", name: p.name, input: p.input(last) }], stop_reason: "tool_use", usage: {} }); }
    return J({ content: [{ type: "text", text: "好的老闆～" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
let n = 0;
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", ...ev }] }); calls = []; claudeBodies = [];
  await wh.onRequestPost({ request: new Request("https://x.dev/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); return r ? r.body.messages : []; };
const say = (g, u, text, at = false) => send({ type: "message", source: { type: "group", groupId: g, userId: u }, message: { type: "text", id: "m" + n, text: at ? "@小幫手 " + text : text, ...(at ? { mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } : {}) } });
const pic = (g, u, id) => send({ type: "message", source: { type: "group", groupId: g, userId: u }, message: { type: "image", id } });
const txt = ms => ms.map(m => m.text || m.altText || m.type).join("\n");
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

// 1. 設定：只有 Ben、只有兩個人的群組
t(/只有 Ben/.test(txt(await say(P, "U_amy", "設成私人助理群", true))), "non-admin can't set");
t(/還有別人/.test(txt(await say(G, "U_ben", "設成私人助理群", true))), "group with others refused");
t(/私人助理群了/.test(txt(await say(P, "U_ben", "設成私人助理群", true))), "set private");
// 2. 不用 @ 也回；秘書個性只在私人空間
let ms = await say(P, "U_ben", "今天四點確認信件");
t(ms.length && claudeBodies.length && /貼身女秘書/.test(JSON.stringify(claudeBodies[0].system)) && /find_files/.test(JSON.stringify(claudeBodies[0].tools)), "no @ needed + persona + vault tools");
ms = await say(G, "U_ben", "隨便問", true);
t(claudeBodies.length && !/貼身女秘書/.test(JSON.stringify(claudeBodies[0].system)) && !/find_files/.test(JSON.stringify(claudeBodies[0].tools)), "no private persona in work group");
t(/任盈盈的氣質/.test(JSON.stringify(claudeBodies[0].system)) && /女性：溫和得體/.test(JSON.stringify(claudeBodies[0].system)), "group charm persona on by default, gender-aware");
sq.prepare("INSERT INTO line_kv VALUES(?, 'off')").run("persona:" + G);
await say(G, "U_ben", "再問一次", true);
t(!/任盈盈的氣質/.test(JSON.stringify(claudeBodies[0].system)), "persona off per group");
sq.prepare("DELETE FROM line_kv WHERE k=?").run("persona:" + G);
sq.prepare("INSERT INTO line_kv VALUES(?, 'yingmin')").run("persona:" + G);
await say(G, "U_ben", "試試", true);
t(/趙敏/.test(JSON.stringify(claudeBodies[0].system)), "per-group persona experiment (yingmin)");
sq.prepare("DELETE FROM line_kv WHERE k=?").run("persona:" + G);
await say(G, "U_ben", "再試", true);
t(!/喝酒的群組/.test(JSON.stringify(claudeBodies[0].system)), "normal group not boozy");
sq.prepare("INSERT INTO line_kv VALUES(?, '週五威士忌小酌群')").run("name:" + G);
await say(G, "U_ben", "今晚喝什麼", true);
t(/喝酒的群組/.test(JSON.stringify(claudeBodies[0].system)) && /絕對不要硬講/.test(JSON.stringify(claudeBodies[0].system)), "booze group: more playful, short");
sq.prepare("DELETE FROM line_kv WHERE k=?").run("name:" + G);
ms = await say(G, "U_ben", "沒叫它");
t(!ms.length, "work group still needs @");
// 3. 照片先不存、不回；說「存 標題」才存進同名資料夾，不用 AI 看照片
ms = await pic(P, "U_ben", "img1");
t(!ms.length && sq.prepare("SELECT COUNT(*) n FROM line_files").get().n === 0 && !claudeBodies.some(b => /描述這張照片/.test(JSON.stringify(b))), "photo not auto-saved, no reply, no caption AI");
await pic(P, "U_ben", "img1b");
ms = await say(P, "U_ben", "存 疏文蓋章");
let f = sq.prepare("SELECT * FROM line_files").all();
t(f.length === 2 && f.every(x => x.caption === "疏文蓋章" && x.drive_id === "D1" && x.chat_id === "admin" && !x.data) && /存好了：2 張照片，放在「疏文蓋章」/.test(txt(ms)), "saved 2 on command " + txt(ms));
t(calls.filter(c => c.body?.fn === "saveFile" && c.body.args[3] === "私人存檔/疏文蓋章").length === 2 && /^疏文蓋章-\d{8}-\d{4}-1\.jpg$/.test(calls.find(c => c.body?.fn === "saveFile").body.args[0]), "into 私人存檔/標題, named by title");
t(!claudeBodies.length, "save command uses no AI");
// 存過的不會再存；沒有待存的「存…」交給 AI（可能是記事）
ms = await say(P, "U_ben", "存 疏文蓋章");
t(sq.prepare("SELECT COUNT(*) n FROM line_files").get().n === 2 && claudeBodies.length, "nothing pending -> AI");
// 回覆某張照片說存：只存那張
await pic(P, "U_ben", "img5"); await pic(P, "U_ben", "img6");
await send({ type: "message", source: { type: "group", groupId: P, userId: "U_ben" }, message: { type: "text", id: "mq", text: "存起來：合約", quotedMessageId: "img6" } });
t(sq.prepare("SELECT COUNT(*) n FROM line_files WHERE caption='合約'").get().n === 1, "quoted only");
// 問句不是存
await say(P, "U_ben", "存在哪裡？");
t(sq.prepare("SELECT COUNT(*) n FROM line_files").get().n === 3, "question not save");
// 雲端硬碟還沒接好 → 先存資料庫
gasOk = false; ms = await say(P, "U_ben", "存 雜項"); gasOk = true;
f = sq.prepare("SELECT * FROM line_files ORDER BY ts DESC").all();
t(f.length === 4 && f.some(x => !x.drive_id && x.data && x.caption === "雜項") && /還沒接好/.test(txt(ms)), "fallback to db " + txt(ms));
// 工作群的照片不存
await pic(G, "U_ben", "img3"); await say(G, "U_ben", "存 工作", true); t(sq.prepare("SELECT COUNT(*) n FROM line_files").get().n === 4, "work group photo not archived");
// 4. 找照片、傳回來
plan = { name: "find_files", input: { query: "疏文" }, next: { name: "send_files", input: last => ({ ids: [(last.match(/\\"id\\":\\"(\w+)\\"/) || [])[1]] }) } };
ms = await say(P, "U_ben", "找疏文蓋章的照片"); plan = null;
const img = ms.find(m => m.type === "image");
t(img && /\/api\/line\/file\?id=\w+&s=\w+/.test(img.originalContentUrl), "photo sent back " + JSON.stringify(ms).slice(0, 300));
const fh = await import(R + "/functions/api/line/file.js");
let fr = await fh.onRequestGet({ request: new Request(img.originalContentUrl), env });
t(fr.status === 200 && (await fr.arrayBuffer()).byteLength === JPG.length, "file endpoint serves from drive");
fr = await fh.onRequestGet({ request: new Request(img.originalContentUrl.replace(/s=\w+/, "s=bad")), env }); t(fr.status === 404, "bad signature 404");
// 5. 記事本
plan = { name: "save_note", input: { text: "shop 的信 11/3 四點要確認" } }; await say(P, "U_ben", "記一下 shop 的信 11/3 四點要確認"); plan = null;
t(sq.prepare("SELECT text FROM line_notes WHERE chat_id='admin'").get()?.text === "shop 的信 11/3 四點要確認", "note saved");
plan = { name: "search_notes", input: { query: "shop" } }; await say(P, "U_ben", "我記過 shop 什麼"); plan = null;
t(calls.some(c => c.url.includes("anthropic") && /shop 的信 11\/3/.test(JSON.stringify(c.body.messages))), "note found");
// 6. 30 天清理不刪私人助理群
sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts) VALUES(?,?,?,?,?)").run(P, "U_ben", "Ben", "很久以前", Date.now() - 40 * 864e5);
sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts) VALUES(?,?,?,?,?)").run(G, "U_ben", "Ben", "很久以前", Date.now() - 40 * 864e5);
const keepPriv = "chat_id NOT IN (SELECT substr(k, 9) FROM line_kv WHERE k LIKE 'private:%' AND v='1')";
sq.prepare(`DELETE FROM line_msgs WHERE ts<? AND ${keepPriv}`).run(Date.now() - 30 * 864e5);
t(sq.prepare("SELECT COUNT(*) n FROM line_msgs WHERE text='很久以前'").get().n === 1 && sq.prepare("SELECT chat_id FROM line_msgs WHERE text='很久以前'").get().chat_id === P, "private history kept");
// 7. 取消
t(/變回一般群組/.test(txt(await say(P, "U_ben", "取消私人助理群", true))), "unset");
t(!(await say(P, "U_ben", "沒 @")).length, "needs @ again");
console.log(`${ok} passed, ${bad} failed`);
