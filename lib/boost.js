// 「全開模式」群組（Ben 說「開啟全開模式」）：
// ・回話一律用最強的模型（DEEP_MODEL，預設 Opus）
// ・記得比較久：跟小幫手的對話 7 天／40 輪；群組背景 24 小時／60 則
// ・照片、檔案（PDF、Excel、Word、PPT、CSV）一傳上來就先讀過，把重點記進群組紀錄；不回話，之後被 @ 問就知道內容
// ・每週一早上 9 點，私訊管理員上週的 AI 開銷
import { claude, kv, ymd } from "./assistant.js";
import { recordAI, notifyAdmins, rateTWD, budgetUSD } from "./usage.js";
import { toBlocks } from "./files.js";

export const boostOn = async (db, chatId) => (await kv.get(db, "boost:" + chatId)) === "1";
export const deepModel = env => env.DEEP_MODEL || "claude-opus-5-5";

const READ_SYS = `你是工作群組的助理，負責先把大家傳的照片或檔案看過、記重點，之後有人問起才答得出來。這段記錄只給你自己之後參考，不會直接給人看。
寫法：
- 第一句說這是什麼（例如「Meta 廣告管理員截圖，11/20–11/26，3 個廣告組合」「餐廳菜單」「聊天截圖」）。
- 接著列重點：數字、金額、日期、名稱、指標（花費、曝光、點擊、CTR、CPC、CPM、轉換、ROAS…）照原樣抄，不要四捨五入、不要自己換算。
- 看不清楚的寫「看不清楚」，不要猜。
- 純生活照、貼圖、梗圖：一句話帶過就好。
- 最多 600 字，繁體中文，不要 Markdown。`;

/* 照片或檔案先讀過，把重點寫回 line_msgs（群組背景會帶到）；失敗就算了，原本的「［傳了…］」還在 */
export async function autoRead(env, db, line, chatId, msg) {
  const isImg = msg.type === "image";
  const name = msg.fileName || (isImg ? "照片.jpg" : "檔案");
  if (!isImg && !/\.(pdf|xlsx|xlsm|docx|pptx|csv|tsv|txt|png|jpe?g|webp)$/i.test(name)) return null;
  const f = await line.content(msg.id, isImg ? 4.5 * 1024 * 1024 : 20 * 1024 * 1024);
  const blocks = await toBlocks(f.bytes, f.type, name);
  const model = deepModel(env);
  const res = await claude(env, { model, max_tokens: 1200, system: READ_SYS, messages: [{ role: "user", content: [...blocks, { type: "text", text: isImg ? "這張照片的重點？" : `這個檔案「${name}」的重點？` }] }] }, 25000);
  if (res.usage) await recordAI(env, db, { chatId, model, usage: res.usage }).catch(() => {});
  const t = (res.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!t) return null;
  const text = (isImg ? "［傳了一張照片，內容：" : `［傳了檔案「${name}」，內容：`) + t.slice(0, 1800) + "］";
  await db.prepare("UPDATE line_msgs SET text=? WHERE chat_id=? AND media IN (?,?)").bind(text, chatId, msg.id, "file:" + msg.id).run();
  return text;
}

/* 每週一台北 09:00 後：私訊管理員上週（週一到週日）的開銷 */
export async function weeklyCost(env, db, now = Date.now()) {
  const tp = new Date(now + 8 * 3600e3);
  if (tp.getUTCDay() !== 1 || tp.getUTCHours() < 9) return false;
  const today = ymd(now);
  if ((await kv.get(db, "costweek:last")) === today) return false;
  await kv.set(db, "costweek:last", today);
  const startTp = Date.UTC(tp.getUTCFullYear(), tp.getUTCMonth(), tp.getUTCDate()) - 8 * 3600e3;   // 今天台北 00:00
  const from = startTp - 7 * 864e5, to = startTp;
  const rate = rateTWD(env), nt = usd => "NT$" + Math.round(usd * rate).toLocaleString("en-US");
  const row = async (sql, ...b) => (await db.prepare(sql).bind(...b).first()) || {};
  const all = await row("SELECT COALESCE(SUM(usd),0) s, COUNT(*) n FROM line_usage WHERE kind='ai' AND ts>=? AND ts<?", from, to);
  const prev = await row("SELECT COALESCE(SUM(usd),0) s FROM line_usage WHERE kind='ai' AND ts>=? AND ts<?", from - 7 * 864e5, from);
  const { results: groups } = await db.prepare("SELECT chat_id, SUM(usd) s, COUNT(*) n FROM line_usage WHERE kind='ai' AND ts>=? AND ts<? GROUP BY chat_id ORDER BY s DESC LIMIT 6").bind(from, to).all();
  const { results: boosted } = await db.prepare("SELECT substr(k,7) id FROM line_kv WHERE k LIKE 'boost:%' AND v='1'").all();
  const name = async id => !id ? "背景作業" : /^U/.test(id) ? "私訊" : (await kv.get(db, "name:" + id)) || "群組";
  const lines = [`上週 AI 開銷（${md(from)}–${md(to - 1)}）`, `全部：US$${all.s.toFixed(2)}（約 ${nt(all.s)}），${all.n} 次呼叫` + (prev.s ? `；前一週 US$${prev.s.toFixed(2)}` : "")];
  for (const b of boosted) {
    const g = await row("SELECT COALESCE(SUM(usd),0) s, COUNT(*) n FROM line_usage WHERE kind='ai' AND chat_id=? AND ts>=? AND ts<?", b.id, from, to);
    const { results: ms } = await db.prepare("SELECT model, SUM(usd) s, COUNT(*) n FROM line_usage WHERE kind='ai' AND chat_id=? AND ts>=? AND ts<? GROUP BY model ORDER BY s DESC").bind(b.id, from, to).all();
    const reads = await row("SELECT COUNT(*) n FROM line_msgs WHERE chat_id=? AND ts>=? AND ts<? AND (text LIKE '［傳了一張照片，內容：%' OR text LIKE '［傳了檔案「%」，內容：%')", b.id, from, to);
    lines.push("", `「${await name(b.id)}」（全開模式）：US$${g.s.toFixed(2)}（約 ${nt(g.s)}），${g.n} 次`, ...ms.map(m => `・${short(m.model)} US$${m.s.toFixed(2)}（${m.n} 次）`), `・自動讀了 ${reads.n || 0} 張照片／檔案`);
  }
  if (groups.length) { lines.push("", "花最多的："); for (const g of groups) lines.push(`・${await name(g.chat_id)} US$${g.s.toFixed(2)}`); }
  const m = ymd(now).slice(0, 7), mm = await row("SELECT COALESCE(SUM(usd),0) s FROM line_usage WHERE kind='ai' AND month=?", m);
  lines.push("", `這個月到目前 US$${mm.s.toFixed(2)}／上限 US$${budgetUSD(env)}`);
  await notifyAdmins(env, db, lines.join("\n"));
  return true;
}
const md = ms => { const d = new Date(ms + 8 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const short = m => /opus/.test(m) ? "Opus" : /sonnet/.test(m) ? "Sonnet" : /haiku/.test(m) ? "Haiku" : m;

/* ---------- 主動插話（全開模式的群組；Ben 說「關閉插話」可以關） ----------
   沒人叫它時，每則文字訊息先用中階模型判斷：有人說法不合邏輯、數字或事實講錯、同一件事講不聽、
   氣氛僵了需要緩頰，或它有值得一提的不同看法，才出面。冷卻 20 分鐘、每天最多 8 次、半夜不插話。 */
export const interjectOn = async (db, chatId) => (await boostOn(db, chatId)) && (await kv.get(db, "ij:off:" + chatId)) !== "1";
const IJ_GAP = 20 * 60e3, IJ_MAX = 8;

export async function shouldInterject(env, db, { chatId, name, text, ts = Date.now(), isAdmin }) {
  const t = String(text || "").trim();
  if (t.length < 6 || t.length > 1500 || !env.ANTHROPIC_API_KEY) return null;
  const h = new Date(ts + 8 * 3600e3).getUTCHours();
  if (h >= 1 && h < 8) return null;   // 台北 01:00–08:00 不插話
  if (ts - Number((await kv.get(db, "ij:last:" + chatId)) || 0) < IJ_GAP) return null;
  if (Number((await kv.get(db, `ij:n:${chatId}:${ymd(ts)}`)) || 0) >= IJ_MAX) return null;
  const msgs = (await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts>? ORDER BY id DESC LIMIT 25").bind(chatId, ts - 3 * 3600e3).all()).results;
  const bot = (await db.prepare("SELECT text,ts FROM line_history WHERE chat_id=? AND role='assistant' AND ts>? ORDER BY id DESC LIMIT 6").bind(chatId, ts - 3 * 3600e3).all()).results.map(r => ({ name: "（你）", text: r.text, ts: r.ts }));
  const convo = [...msgs, ...bot].sort((a, b) => a.ts - b.ts).slice(-28).map(m => `${m.name}（${hmTP(m.ts)}）：${String(m.text).slice(0, 300)}`).join("\n");
  const profile = await kv.json(db, "profile:" + chatId, null);
  const sys = `你是 LINE 工作群組裡的 AI 成員（有自己的個性和主見，不是只會聽命的工具）。現在沒有人叫你，你在旁邊看大家聊天，要決定這一刻要不要主動出面講話。
${profile?.members ? "群組成員：" + profile.members.map(m => m.name + (m.role ? "（" + m.role + "）" : "")).join("、") : ""}
該出面的情況（要明確，不是模糊地覺得可以說點什麼）：
- 有人的說法不合邏輯、因果顛倒、數字或事實講錯（例如算錯、把 CTR 和轉換率搞混、拿不能比的東西比）
- 同一件事來回講不聽、雞同鴨講，需要有人把話講清楚
- 氣氛僵了、有人在指責或情緒上來，需要緩頰打圓場
- 大家在做決定，而你有明確、有根據、值得提的不同看法
不要出面的情況：閒聊、打招呼、貼圖式回應、單純通知、大家已經講得很好、有人已經在處理、你剛剛才講過話、只是想附和或稱讚、老闆在下指令。
寧可少講：拿不準就不要。只回 JSON：{"speak":true或false,"kind":"糾正／釐清／緩頰／不同看法","why":"一句話：哪裡有問題、你要講什麼","confidence":0到1}`;
  const body = { model: env.CHAT_MODEL || "claude-sonnet-5-5", max_tokens: 200, system: sys, messages: [{ role: "user", content: `最近的對話：\n${convo}\n\n最新一則：\n${name}${isAdmin ? "（老闆）" : ""}：${t}` }] };
  try {
    const res = await claude(env, body);
    if (res.usage) await recordAI(env, db, { chatId, model: body.model, usage: res.usage }).catch(() => {});
    const j = JSON.parse((res.content || []).map(b => b.text || "").join("").match(/\{[\s\S]*\}/)[0]);
    if (!j.speak || Number(j.confidence) < 0.75) return null;
    // 先佔住冷卻，免得同時進來的幾則都插話
    if (ts - Number((await kv.get(db, "ij:last:" + chatId)) || 0) < IJ_GAP) return null;
    await kv.set(db, "ij:last:" + chatId, String(ts));
    const nk = `ij:n:${chatId}:${ymd(ts)}`;
    await kv.set(db, nk, String(Number((await kv.get(db, nk)) || 0) + 1));
    return { kind: String(j.kind || ""), why: String(j.why || "").slice(0, 300) };
  } catch (e) { console.log("interject", e.message); return null; }
}
export const interjectAsk = (who, text, d) => `（沒有人叫你。你在旁邊看群組對話，覺得該出面了——${d.kind}：${d.why}
最新一則是 ${who} 說的：「${String(text).slice(0, 500)}」
用你的身分自然地插話：你有自己的看法，不必附和任何人；指出不合邏輯的地方要有理有據、給人台階；有人講不聽或氣氛僵了，就出面把話講清楚或打圓場。
不要說是誰叫你來的，不要提「系統」「判斷」「插話」這些字；簡短，2 到 4 句，只講一個重點。）`;
const hmTP = ms => { const d = new Date(ms + 8 * 3600e3); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
