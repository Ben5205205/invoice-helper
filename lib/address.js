// 群組裡沒 @ 也聽得懂是在跟小幫手說話：
//   A. 回覆小幫手的訊息　B. 開頭叫「小幫手」　C. 剛跟小幫手講完話（5 分鐘內）接著說
//   其他情況：看起來像在問人、拜託人做事的訊息，才請 AI 依上下文和群組關係判斷是不是對小幫手說的
// 另外每天整理一次「群組成員和關係」，讓小幫手知道誰是誰、自己在這群扮演什麼角色。
import { kv, claude, hm } from "./assistant.js";
import { recordAI } from "./usage.js";

const MODEL = env => env.CHAT_MODEL || "claude-sonnet-5-5";
const FOLLOW_MS = 5 * 60e3;
export const callsName = t => /^\s*(小幫手|小秘書)(?=[\s,，:：!！~～、。?？]|$)/.test(String(t || ""));
export const stripName = t => String(t || "").replace(/^\s*(小幫手|小秘書)[\s,，:：!！~～、。]*/, "").trim();
// 像在問問題或拜託人做事（沒有這些就不花錢判斷）
const ASKY = /[?？]|幫我|幫忙|幫.{0,4}(查|算|看|記|找|改|做|問|訂|排)|請你|麻煩|你(可以|會|能|覺得|知道|看|說|記得|有沒有)|算一下|查一下|記一下|看一下|提醒|多少|幾點|幾號|哪裡|哪家|怎麼|為什麼|是不是|對不對|要不要|有沒有|可以嗎|好嗎|呢$/;

/* 小幫手上一次在這裡回話：什麼時候、回誰 */
async function lastTurn(db, chatId) {
  const { results } = await db.prepare("SELECT role,text,ts FROM line_history WHERE chat_id=? ORDER BY id DESC LIMIT 2").bind(chatId).all();
  const a = results.find(r => r.role === "assistant"), u = results.find(r => r.role === "user");
  return a ? { ts: a.ts, who: u ? String(u.text).split("：")[0] : "" } : null;
}

export async function isForBot(env, db, { chatId, userId, name, text, ts = Date.now(), isAdmin }) {
  const t = String(text || "").trim();
  if (!t || t.length > 400 || !env.ANTHROPIC_API_KEY) return false;
  const last = await lastTurn(db, chatId);
  const follow = !!last && ts - last.ts < FOLLOW_MS && last.who === name;
  if (!follow && !ASKY.test(t)) return false;
  const profile = await kv.json(db, "profile:" + chatId, null);
  // 最近的對話（群組訊息＋小幫手的回覆，照時間排）
  const msgs = (await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts<? ORDER BY ts DESC LIMIT 14").bind(chatId, ts - 200).all()).results;
  const bot = (await db.prepare("SELECT text,ts FROM line_history WHERE chat_id=? AND role='assistant' AND ts>? ORDER BY id DESC LIMIT 6").bind(chatId, ts - 3 * 3600e3).all()).results.map(r => ({ name: "小幫手", text: r.text, ts: r.ts }));
  const convo = [...msgs, ...bot].sort((a, b) => a.ts - b.ts).slice(-16).map(m => `${m.name}（${hm(m.ts)}）：${String(m.text).slice(0, 200)}`).join("\n");
  const sys = `你在判斷 LINE 群組裡的最新一則訊息，是不是在對「小幫手」（群組裡的 AI 秘書）說話、要它回應或做事。沒有 @ 它。
${profile ? "這個群組：" + profileText(profile) : ""}
${follow ? "小幫手剛剛（5 分鐘內）才回過這個人，他很可能在接著跟小幫手講話；但如果他明顯轉頭在跟別人說話，就不是。" : "小幫手最近沒有在跟這個人對話，除非內容明顯是在問小幫手、或要它查／算／記／提醒，否則當作在跟群組其他人說話。"}
朋友之間互問「多少錢？」「幾點？」通常是在問彼此，不是問小幫手；問帳單、拆帳、排班、提醒、群組以前講過什麼、要整理資料，比較可能是問小幫手。
只回 JSON：{"to_bot":true或false,"confidence":0到1}`;
  const body = { model: MODEL(env), max_tokens: 60, system: sys, messages: [{ role: "user", content: `${convo ? "前面的對話：\n" + convo + "\n\n" : ""}最新一則：\n${name}${isAdmin ? "（老闆）" : ""}：${t}` }] };
  try {
    const res = await claude(env, body);
    if (res.usage) await recordAI(env, db, { chatId, userId, model: body.model, usage: res.usage }).catch(() => {});
    const j = JSON.parse((res.content || []).map(b => b.text || "").join("").match(/\{[\s\S]*\}/)[0]);
    return !!j.to_bot && Number(j.confidence) >= (follow ? 0.6 : 0.8);
  } catch (e) { console.log("isForBot", e.message); return false; }
}

/* ---------- 群組成員和關係（每天整理一次，老闆教的記憶優先） ---------- */
export function profileText(p) {
  if (!p) return "";
  return `${(p.members || []).map(m => `${m.name}${m.gender && m.gender !== "?" ? "（" + m.gender + "）" : ""}${m.role ? "：" + m.role : ""}${m.notes ? "，" + m.notes : ""}`).join("；")}${p.relations ? "。關係：" + p.relations : ""}${p.bot_role ? "。小幫手在這裡的角色：" + p.bot_role : ""}`;
}
export async function buildProfile(env, db, chatId, now = Date.now()) {
  const msgs = (await db.prepare("SELECT name,text FROM line_msgs WHERE chat_id=? AND ts>? ORDER BY ts DESC LIMIT 200").bind(chatId, now - 30 * 864e5).all()).results.reverse();
  if (msgs.length < 8) return null;
  const members = (await db.prepare("SELECT name FROM line_members WHERE chat_id=? AND name IS NOT NULL").bind(chatId).all()).results.map(r => r.name);
  const mem = (await db.prepare("SELECT text FROM line_memory WHERE chat_id=? OR chat_id IS NULL ORDER BY updated DESC LIMIT 30").bind(chatId).all().catch(() => ({ results: [] }))).results.map(r => r.text);
  const name = (await kv.get(db, "name:" + chatId)) || "";
  const old = await kv.json(db, "profile:" + chatId, null);
  const body = { model: MODEL(env), max_tokens: 1200,
    system: `整理一個 LINE 群組「${name}」的成員和彼此關係，給群組裡的 AI 秘書「小幫手」參考。看對話內容推斷：每個人可能是男是女、在這群的身分（例如老闆、幹部、朋友、同事、員工、廠商、客人）、大家怎麼稱呼他、彼此的關係，以及小幫手在這群主要負責什麼。老闆教過的事（記憶）優先、一定要照著寫；看不出來的寫「?」，不要亂猜。只回 JSON：
{"members":[{"name":"","gender":"男/女/?","role":"","notes":"外號、稱呼、重要的事，一句話"}],"relations":"一兩句說這群人的關係和氣氛","bot_role":"一句話說小幫手在這群主要做什麼、該扮演什麼角色"}`,
    messages: [{ role: "user", content: `成員：${members.join("、") || "（不明）"}\n老闆教過的事：${mem.join("；") || "無"}\n${old ? "上次整理的：" + JSON.stringify(old) + "\n" : ""}最近的對話：\n${msgs.map(m => `${m.name}：${String(m.text).slice(0, 160)}`).join("\n")}` }] };
  const res = await claude(env, body);
  if (res.usage) await recordAI(env, db, { chatId, userId: null, model: body.model, usage: res.usage }).catch(() => {});
  const j = JSON.parse((res.content || []).map(b => b.text || "").join("").match(/\{[\s\S]*\}/)[0]);
  const p = { members: (j.members || []).slice(0, 40), relations: String(j.relations || "").slice(0, 300), bot_role: String(j.bot_role || "").slice(0, 200), ts: now };
  await kv.set(db, "profile:" + chatId, JSON.stringify(p));
  return p;
}
/* 每天清晨：最近有在聊的群組重新整理一次（一次最多 15 群） */
export async function refreshProfiles(env, db, now = Date.now()) {
  const { results } = await db.prepare("SELECT chat_id, COUNT(*) n FROM line_msgs WHERE ts>? AND chat_id LIKE 'C%' GROUP BY chat_id HAVING n>=5 ORDER BY n DESC LIMIT 15").bind(now - 864e5).all();
  let n = 0;
  for (const r of results) { try { if (await buildProfile(env, db, r.chat_id, now)) n++; } catch (e) { console.log("profile", r.chat_id, e.message); } }
  return n;
}
