// 全開模式：照片／檔案自動讀過寫回群組紀錄、每週一 09:00 私訊上週開銷（只發一次）、開關
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const calls = [], pushes = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.includes("anthropic")) { const b = JSON.parse(init.body); calls.push(b); return new Response(JSON.stringify({ content: [{ type: "text", text: "Meta 廣告截圖，花費 1,234、CTR 2.1%" }], usage: { input_tokens: 1500, output_tokens: 100 } })); }
  if (url.includes("/content")) return new Response(new Uint8Array([255, 216, 255, 0]), { headers: { "content-type": "image/jpeg" } });
  if (url.includes("/push")) { pushes.push(JSON.parse(init.body)); return new Response(JSON.stringify({ sentMessages: [{ id: "1" }] })); }
  return new Response("{}");
};
const env = { ANTHROPIC_API_KEY: "x", LINE_CHANNEL_TOKEN: "x" };
const B = await import(R + "/lib/boost.js"), A = await import(R + "/lib/assistant.js"), L = await import(R + "/lib/line.js");
const line = L.lineClient("x");
t(!(await B.boostOn(db, "C1")), "off by default");
await A.kv.set(db, "boost:C1", "1");
t(await B.boostOn(db, "C1"), "on");
sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts,media) VALUES(?,?,?,?,?,?)").run("C1", "U1", "旻", "［傳了一張照片］", Date.now(), "m1");
await B.autoRead(env, db, line, "C1", { type: "image", id: "m1" });
const row = sq.prepare("SELECT text FROM line_msgs WHERE media='m1'").get();
t(row.text.startsWith("［傳了一張照片，內容：Meta 廣告截圖") && row.text.endsWith("］"), "photo text replaced " + row.text);
t(calls[0].model === "claude-opus-5-5" && calls[0].messages[0].content[0].type === "image", "uses opus + image block");
t(sq.prepare("SELECT COUNT(*) n FROM line_usage WHERE chat_id='C1'").get().n === 1, "usage recorded");
t((await B.autoRead(env, db, line, "C1", { type: "file", id: "f1", fileName: "a.zip" })) === null, "skip unknown file");
// 每週開銷：週一 08:59 不發、09:00 發一次、再跑不重發、週二不發
await A.kv.set(db, "admins", JSON.stringify(["Uadmin"]));
await A.kv.set(db, "name:C1", "96廣告分析");
const mon9 = Date.UTC(2026, 10, 30, 1, 0);   // 台北 11/30（一）09:00
sq.prepare("INSERT INTO line_usage(ts,month,kind,chat_id,model,usd) VALUES(?,?,?,?,?,?)").run(mon9 - 2 * 864e5, "2026-11", "ai", "C1", "claude-opus-5-5", 1.5);
sq.prepare("INSERT INTO line_usage(ts,month,kind,chat_id,model,usd) VALUES(?,?,?,?,?,?)").run(mon9 - 3 * 864e5, "2026-11", "ai", "C2", "claude-sonnet-5-5", 0.5);
sq.prepare("INSERT INTO line_usage(ts,month,kind,chat_id,model,usd) VALUES(?,?,?,?,?,?)").run(mon9 - 9 * 864e5, "2026-11", "ai", "C1", "claude-opus-5-5", 9);   // 上上週，不算
t(!(await B.weeklyCost(env, db, mon9 - 60e3)), "not before 9");
t(await B.weeklyCost(env, db, mon9 + 60e3), "sends at 9");
t(!(await B.weeklyCost(env, db, mon9 + 3600e3)), "only once");
t(!(await B.weeklyCost(env, db, mon9 + 864e5)), "not tuesday");
const txt = pushes[0]?.messages?.[0]?.text || "";
t(pushes.length === 1 && pushes[0].to === "Uadmin", "pushed to admin once");
t(/上週 AI 開銷（11\/23–11\/29）/.test(txt) && /全部：US\$2\.0\d/.test(txt) && /「96廣告分析」（全開模式）：US\$1\.5\d/.test(txt) && /Opus US\$1\.5\d/.test(txt) && /自動讀了 [01] 張/.test(txt) && !/US\$9\.00（/.test(txt), "report text\n" + txt);
// 主動插話：判斷要出面才出面、3 分鐘內不連發、半夜也可以、關掉就不插、短訊息不判斷
let judge = { speak: true, kind: "釐清", why: "CTR 和轉換率搞混了", confidence: 0.9 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).includes("anthropic") && JSON.parse(init.body).max_tokens === 200
  ? new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(judge) }], usage: { input_tokens: 800, output_tokens: 40 } })) : realFetch(url, init);
const day = Date.UTC(2026, 10, 28, 6, 0);   // 台北 14:00
t(await B.interjectOn(db, "C1") && !(await B.interjectOn(db, "C9")), "interject follows boost");
let d = await B.shouldInterject(env, db, { chatId: "C1", name: "旻", text: "CTR 高就代表賣得好啊", ts: day });
t(d && /CTR/.test(d.why), "speaks when judged");
t(!(await B.shouldInterject(env, db, { chatId: "C1", name: "旻", text: "CTR 高就代表賣得好啊", ts: day + 60e3 })), "no double within 3 min");
t(!!(await B.shouldInterject(env, db, { chatId: "C1", name: "旻", text: "CTR 高就代表賣得好啊", ts: day + 4 * 60e3 })), "after 3 min");
t(!(await B.shouldInterject(env, db, { chatId: "C1", name: "旻", text: "好", ts: day + 60 * 60e3 })), "short msg skipped");
t(!!(await B.shouldInterject(env, db, { chatId: "C1", name: "旻", text: "CTR 高就代表賣得好啊", ts: Date.UTC(2026, 10, 28, 19, 0) })), "midnight ok (03:00)");
judge = { speak: false, confidence: 0.9 };
t(!(await B.shouldInterject(env, db, { chatId: "C1", name: "旻", text: "今天午餐吃什麼好呢大家", ts: day + 120 * 60e3 })), "stays quiet when judged no");
judge = { speak: true, kind: "緩頰", why: "x", confidence: 0.5 };
t(!(await B.shouldInterject(env, db, { chatId: "C1", name: "旻", text: "你到底有沒有在聽啊", ts: day + 180 * 60e3 })), "low confidence quiet");
await A.kv.set(db, "ij:off:C1", "1");
t(!(await B.interjectOn(db, "C1")), "off switch");
t(/不必附和/.test(B.interjectAsk("旻", "x", { kind: "k", why: "y" })) && /不拖大/.test(B.interjectAsk("旻", "CTR 高就代表賣得好啊", { kind: "釐清", why: "y" })), "ask text");
// 周瑜個性
t(A.groupPersona("zhouyu", "Ben", false).includes("美周郎"), "zhouyu persona");
console.log(`${ok} passed, ${bad} failed`); if (bad) process.exit(1);
