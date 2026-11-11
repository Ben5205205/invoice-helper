// 群組裡沒 @ 也聽得懂：回覆小幫手、開頭叫小幫手、剛講完接著說、依上下文判斷；群組成員和關係
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
try { sq.exec("ALTER TABLE line_memory ADD COLUMN chat_id TEXT"); } catch (e) {}
sq.prepare("INSERT OR IGNORE INTO line_reports(month,data,created) VALUES(?,?,?)").run(new Date(Date.now() + 8 * 3600e3 - 2 * 864e5).toISOString().slice(0, 7), "{}", Date.now());
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
sq.prepare("INSERT INTO line_kv VALUES('admins',?)").run(JSON.stringify(["U_ben"]));
const G = "Cfriends";
let calls = [], bodies = [], forBot = false, sentN = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, body });
  const J = j => new Response(JSON.stringify(j), { status: 200 });
  if (/\/members\/count/.test(url)) return J({ count: 4 });
  if (/\/member\/|\/profile\//.test(url)) return J({ displayName: url.includes("U_ben") ? "Ben Wu" : "IF" });
  if (url.endsWith("/message/reply") || url.endsWith("/message/push")) return J({ sentMessages: (body.messages || []).map(() => ({ id: "s" + (++sentN) })) });
  if (url.includes("api.anthropic.com")) {
    bodies.push(body);
    const sys = JSON.stringify(body.system);
    if (/是不是在對「小幫手」/.test(sys)) return J({ content: [{ type: "text", text: JSON.stringify({ to_bot: forBot, confidence: 0.9 }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    if (/整理一個 LINE 群組/.test(sys)) return J({ content: [{ type: "text", text: JSON.stringify({ members: [{ name: "蚊子", gender: "男", role: "幹部", notes: "負責收錢" }, { name: "IF", gender: "男", role: "朋友" }], relations: "一起喝酒的朋友", bot_role: "幫忙拆帳、算錢" }) }], stop_reason: "end_turn", usage: {} });
    return J({ content: [{ type: "text", text: "好的" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
let n = 0;
const send = async (u, text, extra = {}, chat = G) => { const ev = { type: "message", source: { type: "group", groupId: chat, userId: u }, message: { type: "text", id: "m" + n, text, ...extra } };
  const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", timestamp: Date.now(), ...ev }] }); calls = []; bodies = [];
  await wh.onRequestPost({ request: new Request("https://x.dev/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  return calls.filter(c => c.url.endsWith("/message/reply")).flatMap(c => c.body.messages); };
const judged = () => bodies.some(b => /是不是在對「小幫手」/.test(JSON.stringify(b.system)));
const chatted = () => bodies.find(b => b.tools);
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

// 閒聊、沒在問：不花錢判斷、不回
t(!(await send("U_if", "哈哈哈 今天好累")).length && !judged(), "chit-chat ignored, no AI");
// B：開頭叫小幫手
let ms = await send("U_ben", "小幫手，幫我查一下明天的待辦");
t(ms.length && chatted() && !judged() && /明天的待辦/.test(JSON.stringify(chatted().messages.at(-1))) && !/小幫手，/.test(JSON.stringify(chatted().messages.at(-1))), "B: name call");
// A：回覆小幫手的訊息
const sid = "s" + sentN;
ms = await send("U_if", "那這樣對嗎", { quotedMessageId: sid });
t(ms.length && chatted() && !judged(), "A: reply to bot");
// 像在問，但是問朋友：判斷後不回
sq.prepare("DELETE FROM line_history").run();
forBot = false; ms = await send("U_if", "你們等等幾點到？");
t(judged() && !ms.length, "asky but to friends → silent");
// 判斷是在問小幫手 → 回
forBot = true; ms = await send("U_if", "你可以幫我算一下我要付多少嗎");
t(judged() && ms.length && chatted(), "asky to bot → answers");
// C：剛跟小幫手講完，接著說（不像問句也判斷）
sq.prepare("DELETE FROM line_history").run();
sq.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").run(G, "user", "Ben Wu：幫我記一下", Date.now() - 60e3);
sq.prepare("INSERT INTO line_history(chat_id,role,text,ts) VALUES(?,?,?,?)").run(G, "assistant", "記好了", Date.now() - 50e3);
forBot = true; ms = await send("U_ben", "那就這樣");
t(judged() && ms.length && /剛剛（5 分鐘內）才回過這個人/.test(JSON.stringify(bodies.find(b => /是不是在對/.test(JSON.stringify(b.system))).system)), "C: follow-up judged");
// 別人接話不算 C（不像問句就不判斷）
ms = await send("U_if", "那就這樣");
t(!judged() && !ms.length, "follow-up only for the same person");
// 判斷用一般模型，不用 haiku
t(!JSON.stringify(calls).includes("haiku"), "no haiku");
// 廠商群組：只認 A、B，不自動判斷
sq.prepare("INSERT INTO line_kv VALUES('flows',?)").run(JSON.stringify([{ notify: "Cvendor" }]));
forBot = true; ms = await send("U_if", "可以幫我查一下嗎？", {}, "Cvendor");
t(!judged() && !ms.length, "vendor group: no auto judge");
// 群組成員和關係：整理後放進聊天的提示
for (let i = 0; i < 10; i++) sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts) VALUES(?,?,?,?,?)").run(G, "U_if", "IF", "乾杯 " + i, Date.now() - 3600e3);
const A = await import(R + "/lib/address.js");
const p = await A.buildProfile(env, db, G);
t(p && p.members[0].role === "幹部", "profile built");
ms = await send("U_ben", "小幫手 誰負責收錢");
t(/蚊子（男）：幹部，負責收錢/.test(JSON.stringify(chatted().system)) && /小幫手在這裡的角色：幫忙拆帳、算錢/.test(JSON.stringify(chatted().system)), "profile in chat prompt");
// 引用群組裡別人說的話再 @小幫手：AI 看得到被引用的那句和誰說的
{ await send("U_ben", "看到羽霏又想去舔腳了 麻煩");
  const qid = "m" + (n - 1);
  await send("U_if", "@小幫手 怎麼處理", { quotedMessageId: qid, mention: { mentionees: [{ type: "user", isSelf: true, index: 0, length: 4 }] } });
  const last = JSON.stringify(chatted()?.messages?.at(-1) || "");
  t(/引用了 Ben Wu 說的這句話/.test(last) && /羽霏又想去舔腳/.test(last), "quoted human message given to AI " + last.slice(0, 160));
  await send("U_if", "@小幫手 這是什麼意思", { quotedMessageId: "unknown123", mention: { mentionees: [{ type: "user", isSelf: true, index: 0, length: 4 }] } });
  t(/看不到內容/.test(JSON.stringify(chatted()?.messages?.at(-1) || "")), "unknown quoted message: AI told it can't see it"); }
console.log(`${ok} passed, ${bad} failed`);
