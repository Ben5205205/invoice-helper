// 疏文法會名冊：讀表、排順序、刪名字、確認卡、確定製作會叫 GitHub
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
const G = "Croster";
const rows = [
  ["NB-月繳", "", "", "", "", "NK", "", "", "", "", "J", "", "", "", "", "福田︱尊榮富足大老闆", "", "", "", "", "J", "", "", "", ""],
  ["NO.", "訂單號", "姓名", "檔名", "備註", "NO.", "訂單號", "姓名", "檔名", "備註", "NO.", "訂單號", "姓名", "檔名", "備註", "NO.", "訂單號", "姓名", "檔名", "備註", "NO.", "訂單號", "姓名", "檔名", "備註"],
  ["1", "x", "王小明", "", "", "1", "x", "陳大華", "", "", "1", "x", "林一", "", "", "1", "x", "胡靖韋", "", "", "1", "x", "張三", "", ""],
  ["2", "x", "淞海水產有限公司", "", "", "2", "x", "李四", "", "", "", "", "", "", "", "2", "x", "劉雅菱", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "3", "x", "曾寶儀", "", "", "", "", "", "", ""],
];
let calls = [], aiOut = null, sentN = 0, dispatchOk = true;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, body, init });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  if (/\/members\/count/.test(url)) return J({ count: 2 });
  if (/\/member\/|\/profile\//.test(url)) return J({ displayName: "Ben" });
  if (url.endsWith("/message/reply") || url.endsWith("/message/push")) return J({ sentMessages: (body.messages || []).map(() => ({ id: "s" + (++sentN) })) });
  if (url.startsWith("https://gas.example")) { if (body.fn === "readTab") return J({ ok: true, result: { title: "疏文", name: "11/08列印明細", rows } }); return J({ ok: true, result: {} }); }
  if (url.includes("api.github.com")) return new Response(null, { status: dispatchOk ? 204 : 401 });
  if (url.includes("api.anthropic.com")) return J({ content: [{ type: "text", text: JSON.stringify(aiOut || {}) }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } });
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1", GH_DISPATCH_TOKEN: "ghp_x" };
const wh = await import(R + "/functions/api/line/webhook.js");
const RO = await import(R + "/lib/roster.js");
let n = 0;
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", timestamp: Date.now(), ...ev }] }); calls = [];
  await wh.onRequestPost({ request: new Request("https://x.dev/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); return r ? r.body.messages : []; };
const say = (u, text, extra = {}) => send({ type: "message", source: { type: "group", groupId: G, userId: u }, message: { type: "text", id: "m" + n, text, ...extra } });
const pb = (u, data) => send({ type: "postback", source: { type: "group", groupId: G, userId: u }, postback: { data } });
const js = x => JSON.stringify(x);
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

// 1. 讀表：方案和「姓名」欄
const plans = RO.parseTab(rows);
t(plans.length === 5 && plans[0].names.join() === "王小明,淞海水產有限公司" && plans[3].names.length === 3, "parse " + js(plans));
// 2. 預設順序：福田在前、J 最後（兩欄 J 合併）
const ord = RO.defaultOrder(["NB-月繳", "NK", "J", "福田︱尊榮富足大老闆"], RO.DEFAULT_RULES);
t(js(ord) === js(["福田︱尊榮富足大老闆", "NK", "NB-月繳", "J"]), "default order " + js(ord));
const ap = RO.applyConfig(plans, { order: ord, remove: [{ name: "胡靖韋", plan: "" }, { name: "不存在", plan: "" }] });
t(ap.plans[0].names.join() === "劉雅菱,曾寶儀" && ap.plans[3].names.join() === "林一,張三" && ap.missing.join() === "不存在", "apply " + js(ap));
sq.prepare("INSERT INTO line_kv VALUES(?, '1')").run("staff:on:" + G);   // 名冊群組同時也是疏文人員群組
// 3. 沒開名冊的群組貼連結不理
const link = "https://docs.google.com/spreadsheets/d/1lPglD_WsRwb_quNhDmgGyY32SA6uo1-xZs7PxClu6HU/edit?gid=2120649206#gid=2120649206";
t(!(await say("U_ben", link)).length, "off by default");
t(/只有 Ben/.test(js(await say("U_amy", "@小幫手 開啟名冊", { mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } }))), "only admin can enable");
t(/可以做名冊/.test(js(await say("U_ben", "@小幫手 開啟名冊", { mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } }))), "enable");
// 4. 貼連結＋交代 → 讀那一頁、確認卡
aiOut = { title: "11-08名冊", order: ["福田︱尊榮富足大老闆", "NK", "NB-月繳", "J"], remove: [{ name: "胡靖韋", plan: "福田︱尊榮富足大老闆" }], split: { parts: 2, first_extra: 1, company_weight: 2 }, note: "" };
let ms = await say("U_ben", "11/08 名冊，刪掉胡靖韋，分兩份第一份多 1 " + link);
const rt = calls.find(c => c.body?.fn === "readTab");
t(!calls.some(c => /排班秘書/.test(JSON.stringify(c.body?.system || ""))), "staff watcher skipped for sheet link");
t(rt && rt.body.args[0] === "1lPglD_WsRwb_quNhDmgGyY32SA6uo1-xZs7PxClu6HU" && rt.body.args[1] === "2120649206", "reads that tab");
t(ms[0]?.type === "flex" && /名冊確認｜11-08名冊/.test(js(ms)) && /1\. 福田︱尊榮富足大老闆/.test(js(ms)) && /刪除：胡靖韋/.test(js(ms)) && /分 2 份/.test(js(ms)), "confirm card " + js(ms).slice(0, 300));
const job = sq.prepare("SELECT * FROM line_roster_jobs").get();
t(job && job.status === "draft", "draft saved");
// 5. 別人不能按確定；Ben 按 → 叫 GitHub
t(/只有 Ben/.test(js(await pb("U_amy", "roster:go:" + job.id))), "only admin confirms");
ms = await pb("U_ben", "roster:go:" + job.id);
const dp = calls.find(c => c.url.includes("api.github.com"));
t(dp && /roster\.yml\/dispatches/.test(dp.url) && dp.body.inputs.job === job.id && /開始排版/.test(js(ms)), "dispatched " + js(ms));
t(sq.prepare("SELECT status FROM line_roster_jobs").get().status === "queued", "queued");
t(/已經在做/.test(js(await pb("U_ben", "roster:go:" + job.id))), "no double dispatch");
// 6. 回覆確認卡修改（草稿才可以）
sq.prepare("UPDATE line_roster_jobs SET status='draft'").run();
const card = sq.prepare("SELECT k,v FROM line_kv WHERE k LIKE 'roster:card:%'").get();
aiOut = { title: "11-08名冊", order: ["NK", "福田︱尊榮富足大老闆", "NB-月繳", "J"], remove: [], split: null, note: "NK 改到最前面" };
ms = await say("U_ben", "NK 放最前面，不用分份", { quotedMessageId: card.k.slice(12) });
t(/1\. NK/.test(js(ms)) && /不分份/.test(js(ms)) && /NK 改到最前面/.test(js(ms)), "reconfig by reply " + js(ms).slice(0, 300));
// 7. 金鑰不對：退回草稿
dispatchOk = false; ms = await pb("U_ben", "roster:go:" + job.id); dispatchOk = true;
t(/叫不起來/.test(js(ms)) && sq.prepare("SELECT status FROM line_roster_jobs").get().status === "draft", "dispatch fail stays draft");
// 8. Actions 端點：沒有 GitHub 身分一律拒絕
const jobEp = await import(R + "/functions/api/roster/job.js");
const r403 = await jobEp.onRequestGet({ request: new Request("https://x/api/roster/job?id=" + job.id, { headers: { authorization: "Bearer a.b.c" } }), env });
t(r403.status === 403, "runner needs OIDC");
// 9. 做好：推播下載卡
const L = (await import(R + "/lib/line.js")).lineClient("t");
calls = [];
await RO.finishRoster(env, db, L, { ...job, config: JSON.stringify({ title: "11-08名冊" }) }, { ok: true, summary: { total: 7, people: 6, companies: 1 }, files: [{ label: "完整名冊", pages: 1, first: "a", last: "b", url: "https://drive.google.com/x" }] });
const push = calls.find(c => c.url.endsWith("/message/push"));
t(push && /名冊做好了｜11-08名冊/.test(js(push.body)) && /drive\.google\.com\/x/.test(js(push.body)), "result pushed");
console.log(`${ok} passed, ${bad} failed`);
