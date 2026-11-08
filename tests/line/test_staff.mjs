// 疏文人員管理：法會行事曆、排班自動記錄＋排班卡、工作表現、撤回、提醒、群組個性
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
const G = "Cstaff", today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const add = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const R1 = add(today, 6), R2 = add(today, 9);   // 一般法會、做牙
let calls = [], extract = null, claudeBodies = [], plan = null;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, body });
  const J = (j, s = 200) => new Response(JSON.stringify(j), { status: s });
  if (url.includes("96iching.com")) return new Response(`<html><body><table><tr><td>${+R1.slice(5, 7)}/${+R1.slice(8)}</td><td>藥師佛聖誕法會</td></tr><tr><td>${+R2.slice(5, 7)}/${+R2.slice(8)}</td><td>做牙・福德正神法會</td></tr></table></body></html>`, { status: 200 });
  if (/\/members\/count/.test(url)) return J({ count: 3 });
  if (/\/member\/(\w+)/.test(url)) return J({ displayName: url.includes("U_ben") ? "Ben Wu" : "甯Q" });
  if (url.endsWith("/message/reply") || url.endsWith("/message/push")) return J({ sentMessages: [] });
  if (url.includes("api.anthropic.com")) {
    claudeBodies.push(body);
    const sys = JSON.stringify(body.system || "");
    if (/有日期的法會/.test(sys)) return J({ content: [{ type: "text", text: JSON.stringify([{ date: `${+R1.slice(5, 7)}/${+R1.slice(8)}`, name: "藥師佛聖誕法會" }, { date: `${+R2.slice(5, 7)}/${+R2.slice(8)}`, name: "做牙・福德正神法會" }]) }], usage: { input_tokens: 5, output_tokens: 5 } });
    if (/排班秘書/.test(sys)) return J({ content: [{ type: "text", text: JSON.stringify(extract || {}) }], usage: { input_tokens: 5, output_tokens: 5 } });
    const last = JSON.stringify(body.messages.at(-1));
    if (plan && !last.includes("tool_result")) return J({ content: [{ type: "tool_use", id: "t1", name: plan.name, input: plan.input }], stop_reason: "tool_use", usage: {} });
    return J({ content: [{ type: "text", text: "好的～" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } });
  }
  return J({});
};
const env = { DB: db, LINE_CHANNEL_TOKEN: "t", LINE_CHANNEL_SECRET: "s", ANTHROPIC_API_KEY: "a", LONG_RUN: "1" };
const wh = await import(R + "/functions/api/line/webhook.js");
const S = await import(R + "/lib/staffing.js");
let n = 0;
const send = async ev => { const body = JSON.stringify({ events: [{ webhookEventId: "e" + (n++), replyToken: "rt", timestamp: Date.now(), ...ev }] }); calls = []; claudeBodies = [];
  await wh.onRequestPost({ request: new Request("https://x.dev/api/line/webhook", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "s").update(body).digest("base64"), "x-from-queue": "1" } }), env });
  const r = calls.find(c => c.url.endsWith("/message/reply")); return r ? r.body.messages : []; };
const say = (u, text, at = false) => send({ type: "message", source: { type: "group", groupId: G, userId: u }, message: { type: "text", id: "m" + n, text: at ? "@小幫手 " + text : text, ...(at ? { mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } : {}) } });
const js = ms => JSON.stringify(ms);
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };

// 1. 法會行事曆：讀官網
t(await S.syncRites(env, db) === 2, "sync rites");
const rites = sq.prepare("SELECT * FROM line_rites ORDER BY date").all();
t(rites.length === 2 && rites[0].date === R1 && rites[0].kind === "normal" && rites[1].kind === "yaya", "rites stored " + js(rites));
t(S.needs(rites[1]).length === 1 && S.needs(rites[1])[0].min === 2 && S.needs(rites[0]).length === 4, "needs per rite");
// 2. 開啟（只有 Ben）
t(/只有 Ben/.test(js(await say("U_q", "開啟人員管理", true))), "non-admin can't enable");
t(/開始管人員/.test(js(await say("U_ben", "開啟人員管理", true))), "enable");
// 3. 一般聊天不記、不回
extract = {}; let ms = await say("U_q", "今天好冷喔，明天要下雨");
t(!ms.length && !claudeBodies.length, "chat without schedule words: no AI call");
extract = {}; ms = await say("U_q", "我明天 3 點要去看醫生");
t(!ms.length && claudeBodies.length === 1, "schedule-ish but nothing to record: silent");
// 4. 排班：不用 @，記下並貼排班卡
const d1 = add(R1, -3), d2 = add(R1, -2);
extract = { shifts_add: [{ date: d1, person: "陳小明", role: "蓋章", start: "10:00", end: "18:00" }, { date: d1, person: "林小美", role: "蓋章", start: "13:00", end: "18:00" }] };
ms = await say("U_q", `${+d1.slice(5, 7)}/${+d1.slice(8)} 陳小明 10-18、林小美 13-18 蓋章`);
t(sq.prepare("SELECT COUNT(*) n FROM line_shifts WHERE status='ok'").get().n === 2 && /更新好了/.test(js(ms)) && ms[1]?.type === "flex" && /還缺 1 人/.test(js(ms[1])) && /陳小明/.test(js(ms[1])), "shifts recorded + roster card shows shortage " + js(ms).slice(0, 200));
// 5. 改時間＝取消舊的＋新增
const id1 = sq.prepare("SELECT id FROM line_shifts WHERE person='林小美'").get().id;
extract = { shifts_cancel: [id1], shifts_add: [{ date: d1, person: "林小美", role: "蓋章", start: "10:00", end: "15:00" }] };
ms = await say("U_q", "小美改成 10 點到 15 點");
t(sq.prepare("SELECT COUNT(*) n FROM line_shifts WHERE person='林小美' AND status='ok' AND start='10:00'").get().n === 1 && sq.prepare("SELECT status FROM line_shifts WHERE id=?").get(id1).status === "cancelled" && /取消/.test(js(ms)), "change time");
// 6. 撤回
extract = { undo: true };
ms = await say("U_ben", "剛剛那筆不用記");
t(sq.prepare("SELECT status FROM line_shifts WHERE id=?").get(id1).status === "ok" && sq.prepare("SELECT COUNT(*) n FROM line_shifts WHERE person='林小美' AND status='ok'").get().n === 1 && /撤回/.test(js(ms)), "undo restores previous " + js(sq.prepare("SELECT person,start,status FROM line_shifts").all()));
// 7. 工作表現
extract = { perf: [{ date: today, person: "陳小明", per_hour: 300, errors: 30, total: 2400, hours: 8 }, { date: today, person: "林小美", total: 1000, hours: 5, errors: 20 }] };
ms = await say("U_ben", "陳小明每小時 300 張錯 30 張，今天做 8 小時；小美 5 小時蓋 1000 張錯 20");
const pf = sq.prepare("SELECT person,per_hour,errors FROM line_perf ORDER BY id").all();
t(pf.length === 2 && pf[1].per_hour === 200 && /記下了/.test(js(ms)) && ms.length === 1, "perf recorded, per_hour computed " + js(pf));
// AI 看懂意思再決定貼哪張卡（不是固定指令）
extract = {}; sq.prepare("DELETE FROM line_perf WHERE id>2").run();
plan = { name: "staff_card", input: { kind: "perf" } }; ms = await say("U_q", "誰蓋得最快？錯誤多不多", true); plan = null;
t(ms.some(m => m.type === "flex" && /陳小明/.test(JSON.stringify(m)) && /300\/時/.test(JSON.stringify(m)) && /錯 1.3%/.test(JSON.stringify(m)) && /共 2,400 張、錯 30 張/.test(JSON.stringify(m))), "perf card via AI tool, totals shown " + js(ms).slice(0, 300));
t(/速度不扣錯誤/.test(js(ms)), "speed not reduced by errors (stated)");
plan = { name: "staff_card", input: { kind: "roster" } }; ms = await say("U_q", "接下來人都排好了嗎", true); plan = null;
t(ms.some(m => m.type === "flex" && m.contents.type === "carousel"), "roster card via AI tool");
plan = { name: "rite_set", input: { date: add(today, 20), name: "冬至祈福法會", kind: "normal" } }; await say("U_ben", "新增一場冬至祈福法會", true); plan = null;
t(sq.prepare("SELECT COUNT(*) n FROM line_rites WHERE name='冬至祈福法會'").get().n === 1, "rite added by talking");
plan = { name: "rite_delete", input: { date: add(today, 20) } }; await say("U_ben", "冬至那場取消", true); plan = null;
t(sq.prepare("SELECT COUNT(*) n FROM line_rites WHERE name='冬至祈福法會'").get().n === 0, "rite deleted by talking");
plan = null; await say("U_q", "隨便問問", true);
t(claudeBodies.some(b => (b.tools || []).some(x => x.name === "staff_card")), "staff tools offered");
// 8. 群組個性：開了才有，只對老闆微撩
sq.prepare("INSERT INTO line_kv VALUES(?,?)").run("persona:" + G, "charm");
extract = {}; await say("U_ben", "誰最快", true);
const sys = JSON.stringify(claudeBodies.find(b => !/排班秘書/.test(JSON.stringify(b.system)))?.system || "");
t(/像盈盈對令狐沖/.test(sys) && /女性：溫和得體/.test(sys) && /已排的班：.*陳小明/.test(sys) && /工作表現：.*陳小明 每小時 300/.test(sys), "persona + staff data in prompt");
// 9. 提醒：前一天 18:00、09:00 缺人
const L = (await import(R + "/lib/line.js")).lineClient("t");
const at = (d, h) => Date.parse(d + "T00:00:00Z") - 8 * 3600e3 + h * 3600e3 + 60e3;
calls = []; await S.staffTick(env, db, L, at(add(d1, -1), 18));
let p = calls.filter(c => c.url.endsWith("/message/push"));
t(p.length === 1 && /明天/.test(p[0].body.messages[0].text) && /陳小明（10:00–18:00）/.test(p[0].body.messages[0].text) && /還缺 1 人/.test(p[0].body.messages[0].text), "evening reminder " + js(p.map(x => x.body.messages[0].text)));
calls = []; await S.staffTick(env, db, L, at(add(d1, -1), 18)); t(!calls.some(c => c.url.endsWith("/message/push")), "evening only once");
calls = []; await S.staffTick(env, db, L, at(add(d1, -1), 9));
p = calls.filter(c => c.url.endsWith("/message/push"));
t(p.length === 1 && /還沒排滿/.test(p[0].body.messages[0].text) && p[0].body.messages[0].substitution?.m0?.mentionee?.userId === "U_ben", "shortage alert @Ben");
// 隔天不是法會工作日：18:00 不提醒；法會 3 天前以外：09:00 不提醒缺人
calls = []; await S.staffTick(env, db, L, at(add(R1, -8), 18)); t(!calls.some(c => c.url.endsWith("/message/push")), "no evening reminder on non-work day");
calls = []; await S.staffTick(env, db, L, at(add(R1, -8), 9)); t(!calls.some(c => c.url.endsWith("/message/push")), "no shortage alert more than 3 days out");
calls = []; await S.staffTick(env, db, L, at(add(R1, -8), 6)); t(!calls.some(c => c.url.includes("96iching")), "no daily website sync");
// 法會當天也是隔天法會的蓋章日：蓋章算在隔天那場，不會跑到「其他排班」，當天那張卡會提一句
{
  const sl = S.slots([{ date: "2027-03-10", name: "甲", kind: "normal" }, { date: "2027-03-11", name: "乙", kind: "yaya" }]);
  const d10 = sl.filter(n => n.date === "2027-03-10");
  t(d10.length === 2 && d10.find(n => n.role === "現場").rites[0].name === "甲" && d10.find(n => n.role === "蓋章").rites[0].name === "乙" && d10.find(n => n.role === "蓋章").min === 2, "rite day doubles as next rite's stamp day");
  const sl2 = S.slots([{ date: "2027-03-10", name: "甲", kind: "normal" }, { date: "2027-03-12", name: "丙", kind: "normal" }]);
  const d9 = sl2.filter(n => n.date === "2027-03-09");
  t(d9.length === 1 && d9[0].rites.length === 2 && d9[0].min === 3, "overlapping stamp day counted once");
  sq.prepare("INSERT INTO line_rites(date,name,kind,updated) VALUES(?,?,?,?)").run("2027-03-10", "甲法會", "normal", Date.now());
  sq.prepare("INSERT INTO line_rites(date,name,kind,updated) VALUES(?,?,?,?)").run("2027-03-11", "乙做牙", "yaya", Date.now());
  sq.prepare("INSERT INTO line_shifts(chat_id,date,person,role,status,ts) VALUES(?,?,?,?,?,?)").run(G, "2027-03-10", "邱姝怡", "蓋章", "ok", Date.now());
  const card = JSON.stringify(await S.rosterCard(db, G, "2027-03-05"));
  const bs = JSON.parse(card).contents.contents;
  t(!/其他排班/.test(card) && JSON.stringify(bs.find(b => /乙做牙/.test(JSON.stringify(b)))).includes("邱姝怡") && /這天也要蓋章/.test(JSON.stringify(bs.find(b => /甲法會/.test(JSON.stringify(b))))), "card puts stamp under next rite " + card.slice(0, 200));
}
// 表現回覆寫清楚：總張數、每小時、總共錯幾張、錯誤率；用聊天的模型，不用最便宜的
{
  extract = { perf: [{ date: today, person: "陳汶琪", total: 669, hours: 6.5, errors: 20 }] };
  ms = await say("U_q", "陳汶琪-6小時30分鐘669張  出錯率20張");
  t(/陳汶琪：6 小時 30 分鐘共 669 張，平均每小時 103 張，總共錯 20 張（錯誤率 3.0%）/.test(js(ms)) && ms.length === 1, "perf line clear " + js(ms));
  t(/sonnet/.test(claudeBodies.find(b => /排班秘書/.test(JSON.stringify(b.system))).model), "staff uses chat model");
  const pid = sq.prepare("SELECT id FROM line_perf WHERE person='陳汶琪' ORDER BY id DESC").get().id;
  // 回覆小幫手更正：看得到被回覆的那句、最近的紀錄；本來就記對 → 只說明，不撤回、不貼排班卡
  sq.prepare("INSERT INTO line_kv VALUES('sent:bot1',?)").run(JSON.stringify({ t: "記下了～ 陳汶琪 表現：每小時 103 張，錯 20 張", ts: Date.now() }));
  extract = { reply: "錯 20 張是整段的總數，錯誤率 3.0%，已經這樣記了。" };
  ms = await send({ type: "message", source: { type: "group", groupId: G, userId: "U_ben" }, message: { type: "text", id: "mq1", text: "20張應該是總共的錯誤數，不是每小時", quotedMessageId: "bot1" } });
  const sb = claudeBodies.find(b => /排班秘書/.test(JSON.stringify(b.system)));
  t(sb && /回覆小幫手的這句/.test(JSON.stringify(sb.messages)) && new RegExp("#" + pid + " ").test(JSON.stringify(sb.system)), "correction sees quote + perf ids");
  t(ms.length === 1 && /整段的總數/.test(js(ms)) && sq.prepare("SELECT status FROM line_perf WHERE id=?").get(pid).status === "ok", "explain only, no undo, no roster " + js(ms));
  // 真的要改：perf_fix 只改那筆
  extract = { perf_fix: [{ id: pid, hours: 7 }] };
  ms = await send({ type: "message", source: { type: "group", groupId: G, userId: "U_ben" }, message: { type: "text", id: "mq2", text: "應該是7小時", quotedMessageId: "bot1" } });
  const r2 = sq.prepare("SELECT hours,per_hour,errors,status FROM line_perf WHERE id=?").get(pid);
  t(r2.hours === 7 && r2.per_hour === 96 && r2.errors === 20 && /改好了 陳汶琪：7 小時共 669 張/.test(js(ms)) && ms.length === 1, "perf fixed " + js(r2) + js(ms));
  extract = null;
}
// 每次表現都記一筆；當天累計的扣掉之前的；回覆跟上一次比；個人紀錄卡看進步退步
{
  sq.prepare("DELETE FROM line_perf").run();
  extract = { perf: [{ date: today, person: "王小華", total: 175, hours: 1.5, errors: 5 }] };
  ms = await say("U_q", "王小華-90分鐘175張 出錯5張");
  t(/第一次記錄/.test(js(ms)), "first record " + js(ms));
  extract = { perf: [{ date: today, person: "王小華", total: 669, hours: 6.5, errors: 20, cumulative: true }] };
  ms = await say("U_q", "王小華-6小時30分鐘669張 出錯20張");
  const segs = sq.prepare("SELECT total,hours,errors,per_hour,note FROM line_perf WHERE person='王小華' AND status='ok' ORDER BY id").all();
  t(segs.length === 2 && segs[1].total === 494 && segs[1].hours === 5 && segs[1].errors === 15 && segs[1].per_hour === 99 && /當天累計/.test(segs[1].note), "cumulative split into segment " + js(segs));
  t(/這一段 王小華：5 小時共 494 張/.test(js(ms)) && /今天累計 6 小時 30 分鐘 669 張/.test(js(ms)) && /比上次：速度 ↓ 每小時少 18 張/.test(js(ms)), "reply shows segment + trend " + js(ms));
  const pc = JSON.stringify(await S.personCard(db, G, "小華"));
  t(/王小華 的表現紀錄/.test(pc) && /第 2 次/.test(pc) && /117 → 99/.test(pc), "person card " + pc.slice(0, 300));
  extract = null;
}
// 回覆照片說「這張圖是法會日期，幫忙新增」：不給排班判讀攔走，交給看得到圖片的一般對話
{
  sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts,media) VALUES(?,?,?,?,?,?)").run(G, "U_ben", "Ben", "［傳了一張照片］", Date.now() - 60e3, "imgcal");
  extract = { reply: "我看不到圖片內容" };
  ms = await send({ type: "message", source: { type: "group", groupId: G, userId: "U_ben" }, message: { type: "text", id: "mqi", text: "@小幫手 這張圖是今年其他需要人手的日期，幫忙新增。", quotedMessageId: "imgcal", mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] } } });
  t(!claudeBodies.some(b => /排班秘書/.test(JSON.stringify(b.system))) && !/看不到圖片/.test(js(ms)), "quoted image goes to chat " + js(ms).slice(0, 200));
  extract = null;
}
console.log(`${ok} passed, ${bad} failed`);
