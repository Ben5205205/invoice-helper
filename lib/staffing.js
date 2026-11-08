// 疏文人員管理（「甯-疏文人員管理」這類群組）：
// 法會行事曆（Ben 跟小幫手說；也可以用 syncRites 從官網讀一次）→ 自動算要幾個人；群組裡貼排班、貼工作表現不用 @，便宜的 AI 看懂後記下來並貼排班卡；
// 隔天是法會工作日才在前一天 18:00 提醒，法會前 3 天內還沒排滿就提醒。
import { kv, ymd, hm, claude, isGroup, rememberSent, quotedBot } from "./assistant.js";
import { recordAI, recordPush } from "./usage.js";
import { textMessage, mentionMessage } from "./line.js";

const DAY = 864e5;
const C = { brand: "#12524F", ink: "#1F2937", sub: "#6B7280", soft: "#EEF2F1", line: "#E5E7EB", warn: "#B45309", ok: "#15803D", red: "#DC2626", accent: "#F28C28" };
const WEEK = "日一二三四五六";
export const STAFF_SQL = `CREATE TABLE IF NOT EXISTS line_rites (date TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, updated INTEGER, PRIMARY KEY (date, name));
CREATE TABLE IF NOT EXISTS line_shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, date TEXT NOT NULL, person TEXT NOT NULL, role TEXT NOT NULL, start TEXT, end TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'ok', batch TEXT, by TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_shifts_chat ON line_shifts(chat_id, date);
CREATE TABLE IF NOT EXISTS line_perf (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, date TEXT NOT NULL, person TEXT NOT NULL, per_hour REAL, errors INTEGER, total INTEGER, hours REAL, note TEXT, status TEXT NOT NULL DEFAULT 'ok', batch TEXT, by TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS line_perf_chat ON line_perf(chat_id, date);`;

export const staffOn = async (db, chatId) => isGroup(chatId) && (await kv.get(db, "staff:on:" + chatId)) === "1";
const wd = d => WEEK[new Date(d + "T00:00:00Z").getUTCDay()];
const md = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const isYaya = name => /做牙/.test(name);

/* 每場法會要的人力：做牙＝前 1 天 2 位蓋章；其他＝前 3 天每天 3–5 位蓋章，當天 1–2 位現場 */
export function needs(rite) {
  if (rite.kind === "yaya") return [{ date: addDays(rite.date, -1), role: "蓋章", min: 2, max: 2 }];
  return [-3, -2, -1].map(n => ({ date: addDays(rite.date, n), role: "蓋章", min: 3, max: 5 })).concat([{ date: rite.date, role: "現場", min: 1, max: 2 }]);
}

/* 好幾場法會的工作日疊在一起時（例如 11/23 是法會當天、也是 11/24 法會的蓋章日），同一天同一種工作只算一次：
   人數取最多的那場；排在最早那場的卡片上，rites 記下這天是為了哪幾場 */
export function slots(rites) {
  const m = new Map();
  for (const r of [...rites].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) for (const n of needs(r)) {
    const k = n.date + "|" + n.role, o = m.get(k);
    if (o) { o.min = Math.max(o.min, n.min); o.max = Math.max(o.max, n.max); o.rites.push(r); }
    else m.set(k, { ...n, rites: [r] });
  }
  return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.role === "現場" ? -1 : 1));
}

/* ---------- 法會行事曆：每天讀一次官網，用便宜的 AI 抽出日期和名稱 ---------- */
export async function syncRites(env, db, now = Date.now()) {
  const url = env.RITES_URL || "https://96iching.com/product.php?cid=2";
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("rites " + r.status);
  const text = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").slice(0, 20000);
  const body = { model: env.BG_MODEL || "claude-sonnet-5-5", max_tokens: 800,
    system: "從網頁文字裡找出所有有日期的法會，只回 JSON 陣列：[{\"date\":\"MM/DD\",\"name\":\"法會名稱\"}]。沒列日期的組合、大禮包不要列。",
    messages: [{ role: "user", content: text }] };
  const res = await claude(env, body);
  if (res.usage) await recordAI(env, db, { chatId: "system", model: body.model, usage: res.usage }).catch(() => {});
  let list = [];
  try { list = JSON.parse((res.content || []).map(b => b.text || "").join("").match(/\[[\s\S]*\]/)[0]); } catch (e) { return 0; }
  const today = ymd(now);
  let n = 0;
  for (const x of list) {
    const m = String(x.date || "").match(/(\d{1,2})\D+(\d{1,2})/);
    if (!m || !x.name) continue;
    let y = +today.slice(0, 4), d = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (d < addDays(today, -60)) d = `${y + 1}${d.slice(4)}`;   // 已經過很久的月份＝明年
    await db.prepare("INSERT INTO line_rites(date,name,kind,updated) VALUES(?,?,?,?) ON CONFLICT(date,name) DO UPDATE SET updated=excluded.updated").bind(d, String(x.name).slice(0, 60), isYaya(x.name) ? "yaya" : "normal", now).run();
    n++;
  }
  return n;
}
const upcoming = async (db, today, days = 45) => (await db.prepare("SELECT date,name,kind FROM line_rites WHERE date>=? AND date<=? ORDER BY date").bind(today, addDays(today, days)).all()).results;

/* ---------- 被動偵測：像排班或工作表現的訊息才交給 AI（約 US$0.001／則） ---------- */
const LOOKS = /(\d{1,2}\s*[/／月]\s*\d{1,2}|\d{1,2}\s*[:：點]\s*\d{0,2}|明天|後天|今天|週[一二三四五六日]|禮拜|星期|排班|上班|請假|取消|不能來|改成|換成|張|錯|每小時|小時|蓋章|現場|不用記|記錯|刪掉)/;
const EXTRACT = (today, rites, roster, perfs) => `你是排班秘書，幫忙記錄「疏文」工作的人員安排和工作表現。今天是 ${today}（週${wd(today)}）。
近期法會：${rites.map(r => `${r.date} ${r.name}`).join("；") || "（沒有資料）"}
目前已排的班：${roster.map(s => `#${s.id} ${s.date} ${s.person} ${s.role} ${s.start || ""}-${s.end || ""}`).join("；") || "（還沒有）"}
最近記的工作表現：${perfs.map(p => `#${p.id} ${p.date} ${p.person} 總張數${p.total ?? "?"} 時數${p.hours ?? "?"} 每小時${p.per_hour ?? "?"} 錯誤${p.errors ?? "?"}張（整段工作的總錯誤數）${p.status === "ok" ? "" : "［已撤回］"}`).join("；") || "（還沒有）"}
讀「最新一則訊息」（前面的對話只是參考，已經處理過，不要重複記），判斷要做什麼，只回 JSON：
{"shifts_add":[{"date":"YYYY-MM-DD","person":"名字","role":"蓋章或現場","start":"HH:MM或空","end":"HH:MM或空"}],
 "shifts_cancel":[已排班的 #id],
 "perf":[{"date":"YYYY-MM-DD","person":"名字","total":總張數或null,"hours":工作小時數或null,"per_hour":每小時張數或null,"errors":錯誤張數或null,"cumulative":true或false}],
 "perf_fix":[{"id":表現紀錄的 #id,"total":…,"hours":…,"per_hour":…,"errors":…,"restore":true或false}],
 "perf_delete":[表現紀錄的 #id],
 "undo":true或false,
 "reply":"只有在不用改任何資料、但要回答或說明時才填一句話，否則空字串"}
規則：
- 「明天」「週五」換算成日期；沒寫年份就是最近的那天。沒寫角色就是蓋章；說「現場」「法會現場」才是現場。
- 同一個人同一天已經有班，改時間＝取消舊的 #id 再新增新的。說誰不能來、請假、取消＝shifts_cancel。
- 工作表現：「陳小明 6小時30分鐘 669張 出錯率20張」→ total 669、hours 6.5、errors 20（「出錯率 20 張」「錯 20 張」都是這段工作總共錯 20 張，不是每小時）。per_hour 可以留 null，系統會算。
- 有人更正或解釋某筆表現（例如「20 張是總錯誤數，不是每小時」「應該是 7 小時」）：用 perf_fix 改那筆的 #id，只填要改的欄位；如果那筆其實本來就記對了，不用改，在 reply 用一句話說明目前怎麼記的（例如「錯 20 張是整段的總數，錯誤率 3%」）。被撤回的那筆要恢復，restore 填 true。
- 每次報的表現都要記成一筆（要看每個人每次是進步還是退步）。同一個人同一天又報一次，而且時數和張數都比之前那筆多：通常是當天累計（後面的數字已經包含前面），照原數字列在 perf，並加 "cumulative": true，系統會扣掉之前的、算出這一段。訊息有說「另外」「再加」「下午又做了」就是新的一段，cumulative false。
- 只有明確說「剛剛那筆不用記」「記錯了，刪掉」「不要記」才是 undo true（或 perf_delete 指定 #id）。更正數字不是 undo。
- 一般聊天、問問題、跟排班和表現無關的訊息，全部回空陣列、undo false、reply 空字串。拿不準就不要記。
- 訊息在講照片、圖片、檔案（例如「這張圖」「附件」）或要新增／修改法會日期：全部回空陣列、reply 空字串，交給其他功能處理。絕對不要說你看不到圖片。`;

const num = v => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
/* 表現的那一句：時數、總張數、每小時、錯幾張（總數）、錯誤率 */
export function perfLine(p) {
  const ph = num(p.per_hour), tot = num(p.total), hrs = num(p.hours), err = num(p.errors);
  const parts = [];
  if (tot !== null) parts.push(`${hrs !== null ? fmtH(hrs) + "共 " : "共 "}${tot} 張`);
  else if (hrs !== null) parts.push(fmtH(hrs));
  if (ph !== null) parts.push(`平均每小時 ${ph} 張`);
  if (err !== null) parts.push(`總共錯 ${err} 張${tot ? `（錯誤率 ${(err / tot * 100).toFixed(1)}%）` : ""}`);
  return `${p.person}：${parts.join("，")}`;
}
const rateOf = r => (r && num(r.errors) !== null && num(r.total) ? num(r.errors) / num(r.total) * 100 : null);
/* 跟上一次比：速度快了／慢了幾張、錯誤率高了／低了 */
export function trendText(prev, cur) {
  if (!prev) return "\n（第一次記錄）";
  const out = [];
  if (prev.per_hour && cur.per_hour) { const d = Math.round(cur.per_hour - prev.per_hour); out.push(d > 0 ? `速度 ↑ 每小時多 ${d} 張` : d < 0 ? `速度 ↓ 每小時少 ${-d} 張` : "速度持平"); }
  const a = rateOf(prev), b = rateOf(cur);
  if (a !== null && b !== null) { const d = Math.round((b - a) * 10) / 10; out.push(d < 0 ? `錯誤率 ↓ ${a.toFixed(1)}% → ${b.toFixed(1)}%` : d > 0 ? `錯誤率 ↑ ${a.toFixed(1)}% → ${b.toFixed(1)}%` : "錯誤率持平"); }
  return out.length ? `\n比上次：${out.join("，")}` : "";
}
const fmtH = h => { const m = Math.round(h * 60); return [Math.floor(m / 60) ? Math.floor(m / 60) + " 小時" : "", m % 60 ? (m % 60) + " 分鐘" : ""].filter(Boolean).join(" "); };

export async function watchStaff(env, db, line, { chatId, userId, name, text, replyToken, ts = Date.now(), quotedId = null }) {
  // 要同時有「日期／時間／排班字眼」和「數字或排班動作」才判斷，閒聊不花錢；回覆小幫手的訊息（更正）一律判斷
  const quoted = quotedId ? await quotedBot(db, quotedId) : null;
  if (!text || text.length > 1500 || !env.ANTHROPIC_API_KEY) return false;
  if (!quoted && (!LOOKS.test(text) || !/\d|班|蓋章|現場|張|錯|請假|取消|改成|換成|不能來|不用記|記錯|刪掉/.test(text))) return false;
  const today = ymd(ts);
  const rites = await upcoming(db, today);
  const roster = (await db.prepare("SELECT id,date,person,role,start,end FROM line_shifts WHERE chat_id=? AND status='ok' AND date>=? ORDER BY date LIMIT 80").bind(chatId, addDays(today, -1)).all()).results;
  const perfs = (await db.prepare("SELECT id,date,person,per_hour,errors,total,hours,status FROM line_perf WHERE chat_id=? AND ts>? ORDER BY ts DESC LIMIT 12").bind(chatId, ts - 7 * DAY).all()).results;
  // 前面幾則對話（含小幫手的回覆）讓 AI 看懂「這是在更正哪一筆」
  const recent = (await db.prepare("SELECT name,text,ts FROM line_msgs WHERE chat_id=? AND ts<? AND ts>? ORDER BY ts DESC LIMIT 8").bind(chatId, ts - 500, ts - 6 * 3600e3).all()).results.reverse();
  const ctx = recent.map(m => `${m.name}（${hm(m.ts)}）：${String(m.text).slice(0, 300)}`).join("\n");
  const content = `${ctx ? "前面的對話：\n" + ctx + "\n\n" : ""}${quoted ? "最新一則是回覆小幫手的這句：「" + quoted.slice(0, 300) + "」\n" : ""}最新一則訊息：\n${name}（${hm(ts)}）：${text}`;
  // 排班和表現要看懂意思，用跟聊天一樣的模型（不用最便宜的）
  const body = { model: env.STAFF_MODEL || env.CHAT_MODEL || "claude-sonnet-5-5", max_tokens: 900, system: EXTRACT(today, rites, roster, perfs), messages: [{ role: "user", content }] };
  let res;
  try { res = await claude(env, body); }
  catch (e) { console.log("staff model fallback", e.message); body.model = env.BG_MODEL || "claude-sonnet-5-5"; res = await claude(env, body); }
  if (res.usage) await recordAI(env, db, { chatId, userId, model: body.model, usage: res.usage }).catch(() => {});
  let j; try { j = JSON.parse((res.content || []).map(b => b.text || "").join("").match(/\{[\s\S]*\}/)[0]); } catch (e) { return false; }
  const batch = crypto.randomUUID().slice(0, 8), changes = [];
  let shiftChanged = false;
  if (j.undo) {
    const last = await kv.get(db, "staff:last:" + chatId);
    if (last) {
      const a = await db.prepare("UPDATE line_shifts SET status='undone' WHERE chat_id=? AND batch=? AND status='ok'").bind(chatId, last).run();
      const b = await db.prepare("UPDATE line_perf SET status='undone' WHERE chat_id=? AND batch=? AND status='ok'").bind(chatId, last).run();
      // 上一批取消掉的班也還原
      const c = await db.prepare("UPDATE line_shifts SET status='ok' WHERE chat_id=? AND status='cancelled' AND note=?").bind(chatId, "cancel:" + last).run();
      if ((a.meta?.changes || 0) + (c.meta?.changes || 0)) shiftChanged = true;
      if ((a.meta?.changes || 0) + (b.meta?.changes || 0) + (c.meta?.changes || 0)) changes.push("撤回剛剛那筆");
    }
  }
  for (const id of (j.shifts_cancel || []).map(Number).filter(Boolean)) {
    const r = await db.prepare("UPDATE line_shifts SET status='cancelled', note=? WHERE id=? AND chat_id=? AND status='ok'").bind("cancel:" + batch, id, chatId).run();
    if (r.meta?.changes) { shiftChanged = true; const s = roster.find(x => x.id === id); if (s) changes.push(`取消 ${md(s.date)} ${s.person}`); }
  }
  const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
  const okTime = t => (/^\d{1,2}:\d{2}$/.test(t || "") ? t.padStart(5, "0") : null);
  for (const s of j.shifts_add || []) {
    if (!okDate(s.date) || !s.person) continue;
    const role = /現場/.test(s.role || "") ? "現場" : "蓋章";
    await db.prepare("INSERT INTO line_shifts(chat_id,date,person,role,start,end,status,batch,by,ts) VALUES(?,?,?,?,?,?,'ok',?,?,?)").bind(chatId, s.date, String(s.person).trim().slice(0, 20), role, okTime(s.start), okTime(s.end), batch, userId || null, ts).run();
    shiftChanged = true;
    changes.push(`${md(s.date)} ${s.person} ${role}${okTime(s.start) ? " " + okTime(s.start) + (okTime(s.end) ? "–" + okTime(s.end) : "") : ""}`);
  }
  let perfN = 0;
  for (const p of j.perf || []) {
    if (!p.person) continue;
    const person = String(p.person).trim().slice(0, 20), date = okDate(p.date) ? p.date : today;
    let seg = { total: num(p.total), hours: num(p.hours), errors: num(p.errors), per_hour: num(p.per_hour) }, note = null, dayTotal = "";
    // 當天累計：扣掉今天已經記的，這一段才是這次的表現
    if (p.cumulative) {
      const d = await db.prepare("SELECT SUM(total) t, SUM(hours) h, SUM(errors) e FROM line_perf WHERE chat_id=? AND person=? AND date=? AND status='ok'").bind(chatId, person, date).first();
      if (d && d.t && seg.total > d.t && (!seg.hours || !d.h || seg.hours > d.h)) {
        note = `當天累計 ${seg.hours ?? "?"} 小時 ${seg.total} 張 錯 ${seg.errors ?? "?"} 張`;
        dayTotal = `\n（今天累計 ${seg.hours !== null ? fmtH(seg.hours) + " " : ""}${seg.total} 張${seg.errors !== null ? "，錯 " + seg.errors + " 張" : ""}）`;
        seg = { total: seg.total - d.t, hours: seg.hours !== null && d.h ? Math.round((seg.hours - d.h) * 100) / 100 : seg.hours, errors: seg.errors !== null ? Math.max(0, seg.errors - (d.e || 0)) : null, per_hour: null };
      }
    }
    seg.per_hour = seg.per_hour ?? (seg.total && seg.hours ? Math.round(seg.total / seg.hours) : null);
    if (seg.per_hour === null && seg.total === null && seg.errors === null) continue;
    const prev = await db.prepare("SELECT per_hour,errors,total FROM line_perf WHERE chat_id=? AND person=? AND status='ok' ORDER BY date DESC, ts DESC LIMIT 1").bind(chatId, person).first();
    await db.prepare("INSERT INTO line_perf(chat_id,date,person,per_hour,errors,total,hours,note,status,batch,by,ts) VALUES(?,?,?,?,?,?,?,?,'ok',?,?,?)").bind(chatId, date, person, seg.per_hour, seg.errors, seg.total, seg.hours, note, batch, userId || null, ts).run();
    perfN++;
    changes.push((note ? "這一段 " : "") + perfLine({ person, ...seg }) + dayTotal + trendText(prev, seg));
  }
  // 更正某一筆表現：只改講到的欄位，每小時照新的總張數／時數重算
  for (const f of j.perf_fix || []) {
    const o = perfs.find(x => x.id === Number(f.id));
    if (!o) continue;
    const n = { total: num(f.total) ?? o.total, hours: num(f.hours) ?? o.hours, errors: num(f.errors) ?? o.errors };
    n.per_hour = num(f.per_hour) ?? (n.total && n.hours ? Math.round(n.total / n.hours) : o.per_hour);
    await db.prepare("UPDATE line_perf SET total=?, hours=?, errors=?, per_hour=?" + (f.restore || o.status !== "ok" ? ", status='ok'" : "") + " WHERE id=? AND chat_id=?").bind(n.total, n.hours, n.errors, n.per_hour, o.id, chatId).run();
    perfN++;
    changes.push("改好了 " + perfLine({ person: o.person, ...n }));
  }
  for (const id of (j.perf_delete || []).map(Number).filter(Boolean)) {
    const o = perfs.find(x => x.id === id);
    const r = await db.prepare("UPDATE line_perf SET status='undone' WHERE id=? AND chat_id=? AND status='ok'").bind(id, chatId).run();
    if (r.meta?.changes && o) { perfN++; changes.push(`刪掉 ${o.person} ${md(o.date)} 那筆表現`); }
  }
  const say = String(j.reply || "").trim().slice(0, 300);
  if (!changes.length && !say) return false;
  if (changes.some(c => !c.startsWith("撤回"))) await kv.set(db, "staff:last:" + chatId, batch);
  const msgs = [textMessage(changes.length ? (perfN && !shiftChanged ? `記下了～ ${changes.join("\n")}` : `更新好了：${changes.join("；")}`) + (say ? "\n" + say : "") : say)];
  if (shiftChanged) msgs.push(await rosterCard(db, chatId, today));
  if (replyToken) { const r = await line.reply(replyToken, msgs).catch(e => console.log("staff reply", e.message)); await rememberSent(db, r, msgs).catch(() => {}); }
  return true;
}

/* ---------- 排班卡：每場法會一張，依日期列出誰、幾點，缺人標紅 ---------- */
export async function rosterCard(db, chatId, today = ymd()) {
  const rites = (await upcoming(db, today, 40)).slice(0, 5);
  const shifts = (await db.prepare("SELECT date,person,role,start,end FROM line_shifts WHERE chat_id=? AND status='ok' AND date>=? ORDER BY date, start").bind(chatId, addDays(today, -1)).all()).results;
  const chip = (t, color) => ({ type: "box", layout: "vertical", backgroundColor: color, cornerRadius: "10px", paddingStart: "8px", paddingEnd: "8px", paddingTop: "2px", paddingBottom: "2px", flex: 0, contents: [{ type: "text", text: t, size: "xxs", color: "#FFFFFF", weight: "bold" }] });
  const all = slots(rites);
  const bubbles = rites.map(r => {
    const mine = all.filter(n => n.rites[0] === r && n.date >= today);
    // 法會當天另有別場的蓋章：在這張卡提一句，人排在那場的卡上
    const also = all.filter(n => n.date === r.date && n.rites[0] !== r && n.date >= today);
    const rows = mine.flatMap((n, i) => {
      const who = shifts.filter(s => s.date === n.date && s.role === n.role);
      const short = n.min - who.length;
      return [...(i ? [{ type: "separator", color: C.line, margin: "md" }] : []),
        { type: "box", layout: "horizontal", margin: "md", alignItems: "center", contents: [
          { type: "text", text: `${md(n.date)}（${wd(n.date)}）${n.role}`, size: "sm", weight: "bold", color: C.ink, flex: 1 },
          short > 0 ? chip(`還缺 ${short} 人`, C.red) : chip(`✓ ${who.length} 人`, C.ok)] },
        { type: "text", text: `需要 ${n.min === n.max ? n.min : n.min + "–" + n.max} 人` + (n.rites.length > 1 ? `・也是 ${n.rites.slice(1).map(x => md(x.date)).join("、")} 法會的蓋章` : ""), size: "xxs", color: C.sub, wrap: true },
        ...(who.length ? who.map(s => ({ type: "box", layout: "horizontal", contents: [
          { type: "text", text: s.person, size: "sm", color: C.ink, flex: 5 },
          { type: "text", text: s.start ? `${s.start}${s.end ? "–" + s.end : ""}` : "時間未定", size: "xs", color: s.start ? C.sub : C.warn, align: "end", flex: 5 }] }))
          : [{ type: "text", text: "還沒有人", size: "xs", color: C.sub }])];
    });
    return { type: "bubble", size: "kilo",
      header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
        { type: "text", text: `${md(r.date)}（${wd(r.date)}）${r.kind === "yaya" ? "做牙" : "法會"}`, color: "#CFE3E1", size: "xs" },
        { type: "text", text: r.name, color: "#FFFFFF", weight: "bold", size: "sm", wrap: true, maxLines: 2 }] },
      body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "xs", contents: [...(rows.length ? rows : [{ type: "text", text: "工作日都過了", size: "xs", color: C.sub }]),
        ...also.map(n => ({ type: "text", text: `這天也要${n.role}（${n.rites.map(x => md(x.date)).join("、")} 法會），見下一張`, size: "xxs", color: C.warn, margin: "md", wrap: true }))] } };
  });
  const extra = shifts.filter(s => !all.some(n => n.date === s.date && n.role === s.role));
  if (extra.length) bubbles.push({ type: "bubble", size: "kilo",
    header: { type: "box", layout: "vertical", backgroundColor: C.accent, paddingAll: "14px", contents: [{ type: "text", text: "其他排班", color: "#FFFFFF", weight: "bold", size: "sm" }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "xs", contents: extra.slice(0, 20).map(s => ({ type: "text", text: `${md(s.date)}（${wd(s.date)}）${s.person} ${s.role} ${s.start || ""}${s.end ? "–" + s.end : ""}`, size: "xs", color: C.ink, wrap: true })) } });
  if (!bubbles.length) return textMessage("近期沒有法會資料，也還沒有人排班。");
  return { type: "flex", altText: "疏文人員排班", contents: { type: "carousel", contents: bubbles.slice(0, 10) } };
}

/* ---------- 表現統計卡：平均每小時、錯誤率、做過幾天，從快到慢 ---------- */
export async function perfCard(db, chatId) {
  // 平均速度＝總張數÷總時數（每段時間長短不同，不直接平均每小時）；沒有時數的才用每小時的平均
  const { results } = await db.prepare("SELECT person, COUNT(DISTINCT date) days, COALESCE(SUM(CASE WHEN hours>0 AND total>0 THEN total END) * 1.0 / NULLIF(SUM(CASE WHEN hours>0 AND total>0 THEN hours END), 0), AVG(per_hour)) ph, SUM(errors) err, SUM(COALESCE(total, per_hour * hours)) tot, COUNT(*) n FROM line_perf WHERE chat_id=? AND status='ok' GROUP BY person ORDER BY ph DESC").bind(chatId).all();
  if (!results.length) return textMessage("還沒有工作表現的紀錄。有人說「陳小明每小時 300 張、錯 30 張」我就會記。");
  const rows = results.map((r, i) => {
    const rate = r.err !== null && r.tot ? Math.round(r.err / r.tot * 1000) / 10 : null;
    return { type: "box", layout: "horizontal", margin: "md", alignItems: "center", contents: [
      { type: "text", text: `${i + 1}. ${r.person}`, size: "sm", weight: "bold", color: C.ink, flex: 5 },
      { type: "text", text: r.ph ? `${Math.round(r.ph)}/時` : "–", size: "sm", color: C.brand, align: "end", flex: 3, weight: "bold" },
      { type: "text", text: rate !== null ? `錯 ${rate}%` : "–", size: "xs", color: rate !== null && rate > 8 ? C.red : C.sub, align: "end", flex: 3 },
      { type: "text", text: `${r.n} 次`, size: "xxs", color: C.sub, align: "end", flex: 2 }] };
  });
  const detail = results.map(r => ({ type: "text", text: `${r.person}：共 ${r.tot ? Math.round(r.tot).toLocaleString("en-US") : "?"} 張${r.err !== null ? `、錯 ${r.err} 張` : ""}`, size: "xxs", color: C.sub, wrap: true }));
  const rows2 = rows.map((row, i) => ({ type: "box", layout: "vertical", contents: [row, detail[i]] }));
  return perfBubble(rows2);
}
/* 一個人的每次表現：看進步還是退步 */
export async function personCard(db, chatId, person) {
  const name = String(person || "").trim();
  let { results } = await db.prepare("SELECT date,per_hour,errors,total,hours,ts FROM line_perf WHERE chat_id=? AND status='ok' AND person=? ORDER BY date, ts").bind(chatId, name).all();
  if (!results.length && name) results = (await db.prepare("SELECT date,per_hour,errors,total,hours,ts,person FROM line_perf WHERE chat_id=? AND status='ok' AND person LIKE ? ORDER BY date, ts").bind(chatId, `%${name}%`).all()).results;
  if (!results.length) return textMessage(`還沒有 ${name} 的表現紀錄。`);
  const who = results[0].person || name;
  const arrow = (d, goodUp) => (d > 0 ? (goodUp ? "↑" : "↑") : d < 0 ? "↓" : "→");
  const col = (d, goodUp) => (!d ? C.sub : (d > 0) === goodUp ? C.ok : C.red);
  const rows = results.map((r, i) => {
    const p = results[i - 1], rate = rateOf(r), pr = p ? rateOf(p) : null;
    const dv = p && p.per_hour && r.per_hour ? r.per_hour - p.per_hour : 0, de = rate !== null && pr !== null ? Math.round((rate - pr) * 10) / 10 : 0;
    return { type: "box", layout: "horizontal", margin: "md", alignItems: "center", contents: [
      { type: "box", layout: "vertical", flex: 4, contents: [
        { type: "text", text: `第 ${i + 1} 次｜${md(r.date)}（${wd(r.date)}）`, size: "xs", weight: "bold", color: C.ink },
        { type: "text", text: `${r.hours ? fmtH(r.hours) + "・" : ""}${r.total ?? "?"} 張`, size: "xxs", color: C.sub }] },
      { type: "text", text: r.per_hour ? `${r.per_hour}/時 ${p ? arrow(dv) : ""}` : "–", size: "sm", weight: "bold", color: p ? col(dv, true) : C.brand, align: "end", flex: 3 },
      { type: "text", text: rate !== null ? `錯 ${rate.toFixed(1)}% ${p && pr !== null ? arrow(de) : ""}` : "–", size: "xs", color: p && pr !== null ? col(de, false) : C.sub, align: "end", flex: 3 }] };
  }).reverse();
  const f = results[0], l = results[results.length - 1];
  const sum = results.length > 1 && f.per_hour && l.per_hour ? `從第 1 次到最近一次：每小時 ${f.per_hour} → ${l.per_hour} 張${rateOf(f) !== null && rateOf(l) !== null ? `，錯誤率 ${rateOf(f).toFixed(1)}% → ${rateOf(l).toFixed(1)}%` : ""}` : "記到第二次之後就看得出進步或退步";
  return { type: "flex", altText: `${who} 的表現紀錄`, contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
      { type: "text", text: `${who} 的表現紀錄`, color: "#FFFFFF", weight: "bold", size: "md" },
      { type: "text", text: sum, color: "#CFE3E1", size: "xxs", wrap: true }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", contents: [
      { type: "text", text: "綠色＝比上一次好（速度變快、錯誤變少），紅色＝變差", size: "xxs", color: C.sub, wrap: true },
      ...rows.slice(0, 20)] } } };
}
function perfBubble(rows) {
  return { type: "flex", altText: "蓋章人員表現統計", contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
      { type: "text", text: "蓋章人員表現", color: "#FFFFFF", weight: "bold", size: "md" },
      { type: "text", text: "平均每小時張數｜錯誤率（錯誤張數÷總張數，速度不扣錯誤）｜記了幾次", color: "#CFE3E1", size: "xxs", wrap: true }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows.slice(0, 25) } } };
}
/* ---------- 提醒：明天是法會工作日才在前一天 18:00 貼班表；法會前 3 天內還沒排滿，每天 09:00 提醒一次 ---------- */
export async function staffTick(env, db, line, now = Date.now()) {
  const t = new Date(now + 8 * 3600e3), h = t.getUTCHours(), mi = t.getUTCMinutes(), today = ymd(now);
  const { results } = await db.prepare("SELECT substr(k, 10) id FROM line_kv WHERE k LIKE 'staff:on:%' AND v='1'").all();
  let sent = 0;
  for (const { id: chatId } of results) {
    if (h === 18 && mi < 5 && !(await kv.get(db, `staff:eve:${chatId}:${today}`))) {
      await kv.set(db, `staff:eve:${chatId}:${today}`, "1");
      const tm = addDays(today, 1);
      const sh = (await db.prepare("SELECT person,role,start,end FROM line_shifts WHERE chat_id=? AND status='ok' AND date=? ORDER BY role, start").bind(chatId, tm).all()).results;
      const need = slots(await upcoming(db, today, 5)).filter(n => n.date === tm);
      if (need.length) {   // 只有明天是法會的工作日（蓋章日或法會當天）才提醒
        const lines = ["蓋章", "現場"].map(role => { const w = sh.filter(s => s.role === role); const n = need.find(x => x.role === role); if (!w.length && !n) return null;
          return `${role}：${w.map(s => s.person + (s.start ? `（${s.start}${s.end ? "–" + s.end : ""}）` : "")).join("、") || "還沒有人"}${n && w.length < n.min ? `，還缺 ${n.min - w.length} 人` : ""}`; }).filter(Boolean);
        await line.push(chatId, [textMessage(`明天 ${md(tm)}（${wd(tm)}）的班表～\n${lines.join("\n")}\n大家早點休息，明天見✨`)]).then(() => recordPush(db, chatId, 1)).catch(e => console.log("staff eve", e.message));
        sent++;
      }
    }
    if (h === 9 && mi < 5 && !(await kv.get(db, `staff:short:${chatId}:${today}`))) {
      await kv.set(db, `staff:short:${chatId}:${today}`, "1");
      const sh = (await db.prepare("SELECT date,role FROM line_shifts WHERE chat_id=? AND status='ok' AND date>=?").bind(chatId, today).all()).results;
      const lack = slots(await upcoming(db, today, 6)).filter(n => n.date >= today && n.date <= addDays(today, 3)).map(n => ({ ...n, have: sh.filter(s => s.date === n.date && s.role === n.role).length })).filter(n => n.have < n.min);
      if (lack.length) {
        const adm = (await kv.json(db, "admins", []))[0];
        const txt = `{who} 人手還沒排滿喔：\n${lack.map(n => `・${md(n.date)}（${wd(n.date)}）${n.role} 還缺 ${n.min - n.have} 人`).join("\n")}`;
        await line.push(chatId, [adm ? mentionMessage(txt, adm) : textMessage(txt.replace("{who} ", "")), await rosterCard(db, chatId, today)]).then(() => recordPush(db, chatId, 1)).catch(e => console.log("staff short", e.message));
        sent++;
      }
    }
  }
  return sent;
}

/* ---------- AI 工具（疏文人員管理群）：AI 看懂意思後決定要貼哪張卡、怎麼改法會 ---------- */
export const STAFF_TOOLS = [
  { name: "staff_card", description: "在群組貼出疏文人員的卡片。kind=roster：接下來各場法會已排定的人手、時間、還缺幾人（問「接下來誰上班」「人排好了沒」「還缺誰」「排班狀況」時用）；kind=perf：所有蓋章人員的表現排名（速度、錯誤率）；kind=person：某一個人每一次的表現和進步／退步（問「小美最近有進步嗎」「陳汶琪的紀錄」時用，要填 person）。", input_schema: { type: "object", properties: { kind: { type: "string", enum: ["roster", "perf", "person"] }, person: { type: "string" } }, required: ["kind"] } },
  { name: "rites_list", description: "查近期法會的日期、名稱、是不是做牙，以及每場需要的人力。", input_schema: { type: "object", properties: {} } },
  { name: "rite_set", description: "新增或修改一場法會（老闆說法會改期、新增、改名時用）。改期要給 old_date。kind：做牙＝yaya，其他＝normal。", input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, name: { type: "string" }, kind: { type: "string", enum: ["yaya", "normal"] }, old_date: { type: "string" } }, required: ["date", "name"] } },
  { name: "rite_delete", description: "取消一場法會。", input_schema: { type: "object", properties: { date: { type: "string" }, name: { type: "string" } }, required: ["date"] } },
];
export async function runStaffTool(ctx, name, input) {
  const { db, chatId } = ctx, today = ymd();
  if (name === "staff_card") { (ctx.cards ||= []).push(input.kind === "perf" ? await perfCard(db, chatId) : input.kind === "person" ? await personCard(db, chatId, input.person) : await rosterCard(db, chatId, today)); return { ok: true, note: "卡片會接在你的回覆後面，你只要說一句簡短的話" }; }
  if (name === "rites_list") return { rites: (await upcoming(db, today, 120)).map(r => ({ ...r, needs: needs(r).map(n => `${n.date} ${n.role} ${n.min === n.max ? n.min : n.min + "–" + n.max} 人`) })) };
  if (name === "rite_set") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || "") || !input.name) return { error: "日期要 YYYY-MM-DD、要有名稱" };
    if (input.old_date) await db.prepare("DELETE FROM line_rites WHERE date=? AND (name=? OR ?='')").bind(input.old_date, input.name, input.old_date ? "" : "x").run();
    const kind = input.kind || (isYaya(input.name) ? "yaya" : "normal");
    await db.prepare("INSERT INTO line_rites(date,name,kind,updated) VALUES(?,?,?,?) ON CONFLICT(date,name) DO UPDATE SET kind=excluded.kind, updated=excluded.updated").bind(input.date, String(input.name).slice(0, 60), kind, Date.now()).run();
    return { ok: true, needs: needs({ date: input.date, kind }).map(n => `${n.date} ${n.role} ${n.min === n.max ? n.min : n.min + "–" + n.max} 人`) };
  }
  if (name === "rite_delete") {
    const r = await db.prepare("DELETE FROM line_rites WHERE date=? AND (? IS NULL OR name LIKE ?)").bind(input.date, input.name || null, "%" + (input.name || "") + "%").run();
    return r.meta?.changes ? { ok: true } : { error: "找不到這天的法會" };
  }
  return null;
}
