// 疏文人員管理（「甯-疏文人員管理」這類群組）：
// 法會行事曆（每天讀官網）→ 自動算要幾個人；群組裡貼排班、貼工作表現不用 @，便宜的 AI 看懂後記下來並貼排班卡；
// 前一天 18:00 提醒明天誰上班，法會前 5 天還沒排滿就提醒。
import { kv, ymd, hm, claude, isGroup } from "./assistant.js";
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

/* ---------- 法會行事曆：每天讀一次官網，用便宜的 AI 抽出日期和名稱 ---------- */
export async function syncRites(env, db, now = Date.now()) {
  const url = env.RITES_URL || "https://96iching.com/product.php?cid=2";
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("rites " + r.status);
  const text = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").slice(0, 20000);
  const body = { model: env.BG_MODEL || "claude-haiku-5-5", max_tokens: 800,
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
const EXTRACT = (today, rites, roster) => `你是排班秘書，幫忙記錄「疏文」工作的人員安排和工作表現。今天是 ${today}（週${wd(today)}）。
近期法會：${rites.map(r => `${r.date} ${r.name}`).join("；") || "（沒有資料）"}
目前已排的班：${roster.map(s => `#${s.id} ${s.date} ${s.person} ${s.role} ${s.start || ""}-${s.end || ""}`).join("；") || "（還沒有）"}
讀這則群組訊息，判斷有沒有要記錄的事，只回 JSON：
{"shifts_add":[{"date":"YYYY-MM-DD","person":"名字","role":"蓋章或現場","start":"HH:MM或空","end":"HH:MM或空"}],
 "shifts_cancel":[已排班的 #id 數字],
 "perf":[{"date":"YYYY-MM-DD","person":"名字","per_hour":每小時張數或null,"total":總張數或null,"errors":錯誤張數或null,"hours":小時數或null}],
 "undo":true或false}
規則：
- 「明天」「週五」換算成日期；沒寫年份就是最近的那天。沒寫角色就是蓋章；說「現場」「法會現場」才是現場。
- 同一個人同一天已經有班，改時間＝取消舊的 #id 再新增新的。說誰不能來、請假、取消＝shifts_cancel。
- 工作表現：「陳小明每小時 300 張，錯 30 張」→ perf。只說總張數和工作時數也可以，per_hour 留 null。
- 說「剛剛那筆不用記」「記錯了」「刪掉剛剛的」＝undo true；如果同時給了正確的內容，也照樣列出來。
- 一般聊天、問問題、跟排班和表現無關的訊息，全部回空陣列、undo false。拿不準就不要記。`;

export async function watchStaff(env, db, line, { chatId, userId, name, text, replyToken, ts = Date.now() }) {
  // 要同時有「日期／時間／排班字眼」和「數字或排班動作」才判斷，閒聊不花錢
  if (!text || text.length > 1500 || !LOOKS.test(text) || !/\d|班|蓋章|現場|張|錯|請假|取消|改成|換成|不能來|不用記|記錯|刪掉/.test(text) || !env.ANTHROPIC_API_KEY) return false;
  const today = ymd(ts);
  const rites = await upcoming(db, today);
  const roster = (await db.prepare("SELECT id,date,person,role,start,end FROM line_shifts WHERE chat_id=? AND status='ok' AND date>=? ORDER BY date LIMIT 80").bind(chatId, addDays(today, -1)).all()).results;
  const body = { model: env.BG_MODEL || "claude-haiku-5-5", max_tokens: 900, system: EXTRACT(today, rites, roster), messages: [{ role: "user", content: `${name}（${hm(ts)}）：${text}` }] };
  const res = await claude(env, body);
  if (res.usage) await recordAI(env, db, { chatId, userId, model: body.model, usage: res.usage }).catch(() => {});
  let j; try { j = JSON.parse((res.content || []).map(b => b.text || "").join("").match(/\{[\s\S]*\}/)[0]); } catch (e) { return false; }
  const batch = crypto.randomUUID().slice(0, 8), changes = [];
  if (j.undo) {
    const last = await kv.get(db, "staff:last:" + chatId);
    if (last) {
      const a = await db.prepare("UPDATE line_shifts SET status='undone' WHERE chat_id=? AND batch=? AND status='ok'").bind(chatId, last).run();
      const b = await db.prepare("UPDATE line_perf SET status='undone' WHERE chat_id=? AND batch=? AND status='ok'").bind(chatId, last).run();
      // 上一批取消掉的班也還原
      const c = await db.prepare("UPDATE line_shifts SET status='ok' WHERE chat_id=? AND status='cancelled' AND note=?").bind(chatId, "cancel:" + last).run();
      if ((a.meta?.changes || 0) + (b.meta?.changes || 0) + (c.meta?.changes || 0)) changes.push("撤回剛剛那筆");
    }
  }
  for (const id of (j.shifts_cancel || []).map(Number).filter(Boolean)) {
    const r = await db.prepare("UPDATE line_shifts SET status='cancelled', note=? WHERE id=? AND chat_id=? AND status='ok'").bind("cancel:" + batch, id, chatId).run();
    if (r.meta?.changes) { const s = roster.find(x => x.id === id); if (s) changes.push(`取消 ${md(s.date)} ${s.person}`); }
  }
  const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
  const okTime = t => (/^\d{1,2}:\d{2}$/.test(t || "") ? t.padStart(5, "0") : null);
  for (const s of j.shifts_add || []) {
    if (!okDate(s.date) || !s.person) continue;
    const role = /現場/.test(s.role || "") ? "現場" : "蓋章";
    await db.prepare("INSERT INTO line_shifts(chat_id,date,person,role,start,end,status,batch,by,ts) VALUES(?,?,?,?,?,?,'ok',?,?,?)").bind(chatId, s.date, String(s.person).trim().slice(0, 20), role, okTime(s.start), okTime(s.end), batch, userId || null, ts).run();
    changes.push(`${md(s.date)} ${s.person} ${role}${okTime(s.start) ? " " + okTime(s.start) + (okTime(s.end) ? "–" + okTime(s.end) : "") : ""}`);
  }
  const perf = [];
  for (const p of j.perf || []) {
    if (!p.person) continue;
    const num = v => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
    const ph = num(p.per_hour) ?? (num(p.total) && num(p.hours) ? Math.round(num(p.total) / num(p.hours)) : null);
    if (ph === null && num(p.total) === null && num(p.errors) === null) continue;
    await db.prepare("INSERT INTO line_perf(chat_id,date,person,per_hour,errors,total,hours,status,batch,by,ts) VALUES(?,?,?,?,?,?,?,'ok',?,?,?)").bind(chatId, okDate(p.date) ? p.date : today, String(p.person).trim().slice(0, 20), ph, num(p.errors), num(p.total), num(p.hours), batch, userId || null, ts).run();
    perf.push(p.person);
    changes.push(`${p.person} 表現：${ph ? "每小時 " + ph + " 張" : ""}${num(p.errors) !== null ? "，錯 " + num(p.errors) + " 張" : ""}`);
  }
  if (!changes.length) return false;
  if (changes.some(c => !c.startsWith("撤回"))) await kv.set(db, "staff:last:" + chatId, batch);
  const msgs = [textMessage(perf.length && !(j.shifts_add || []).length && !(j.shifts_cancel || []).length ? `記下了～ ${changes.join("；")}` : `更新好了：${changes.join("；")}`)];
  if ((j.shifts_add || []).length || (j.shifts_cancel || []).length || j.undo) msgs.push(await rosterCard(db, chatId, today));
  if (replyToken) await line.reply(replyToken, msgs).catch(e => console.log("staff reply", e.message));
  return true;
}

/* ---------- 排班卡：每場法會一張，依日期列出誰、幾點，缺人標紅 ---------- */
export async function rosterCard(db, chatId, today = ymd()) {
  const rites = (await upcoming(db, today, 40)).slice(0, 5);
  const shifts = (await db.prepare("SELECT date,person,role,start,end FROM line_shifts WHERE chat_id=? AND status='ok' AND date>=? ORDER BY date, start").bind(chatId, addDays(today, -1)).all()).results;
  const chip = (t, color) => ({ type: "box", layout: "vertical", backgroundColor: color, cornerRadius: "10px", paddingStart: "8px", paddingEnd: "8px", paddingTop: "2px", paddingBottom: "2px", flex: 0, contents: [{ type: "text", text: t, size: "xxs", color: "#FFFFFF", weight: "bold" }] });
  const bubbles = rites.map(r => {
    const rows = needs(r).filter(n => n.date >= today).flatMap((n, i) => {
      const who = shifts.filter(s => s.date === n.date && s.role === n.role);
      const short = n.min - who.length;
      return [...(i ? [{ type: "separator", color: C.line, margin: "md" }] : []),
        { type: "box", layout: "horizontal", margin: "md", alignItems: "center", contents: [
          { type: "text", text: `${md(n.date)}（${wd(n.date)}）${n.role}`, size: "sm", weight: "bold", color: C.ink, flex: 1 },
          short > 0 ? chip(`還缺 ${short} 人`, C.red) : chip(`✓ ${who.length} 人`, C.ok)] },
        { type: "text", text: `需要 ${n.min === n.max ? n.min : n.min + "–" + n.max} 人`, size: "xxs", color: C.sub },
        ...(who.length ? who.map(s => ({ type: "box", layout: "horizontal", contents: [
          { type: "text", text: s.person, size: "sm", color: C.ink, flex: 5 },
          { type: "text", text: s.start ? `${s.start}${s.end ? "–" + s.end : ""}` : "時間未定", size: "xs", color: s.start ? C.sub : C.warn, align: "end", flex: 5 }] }))
          : [{ type: "text", text: "還沒有人", size: "xs", color: C.sub }])];
    });
    return { type: "bubble", size: "kilo",
      header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
        { type: "text", text: `${md(r.date)}（${wd(r.date)}）${r.kind === "yaya" ? "做牙" : "法會"}`, color: "#CFE3E1", size: "xs" },
        { type: "text", text: r.name, color: "#FFFFFF", weight: "bold", size: "sm", wrap: true, maxLines: 2 }] },
      body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "xs", contents: rows.length ? rows : [{ type: "text", text: "工作日都過了", size: "xs", color: C.sub }] } };
  });
  const extra = shifts.filter(s => !rites.some(r => needs(r).some(n => n.date === s.date && n.role === s.role)));
  if (extra.length) bubbles.push({ type: "bubble", size: "kilo",
    header: { type: "box", layout: "vertical", backgroundColor: C.accent, paddingAll: "14px", contents: [{ type: "text", text: "其他排班", color: "#FFFFFF", weight: "bold", size: "sm" }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", spacing: "xs", contents: extra.slice(0, 20).map(s => ({ type: "text", text: `${md(s.date)}（${wd(s.date)}）${s.person} ${s.role} ${s.start || ""}${s.end ? "–" + s.end : ""}`, size: "xs", color: C.ink, wrap: true })) } });
  if (!bubbles.length) return textMessage("近期沒有法會資料，也還沒有人排班。");
  return { type: "flex", altText: "疏文人員排班", contents: { type: "carousel", contents: bubbles.slice(0, 10) } };
}

/* ---------- 表現統計卡：平均每小時、錯誤率、做過幾天，從快到慢 ---------- */
export async function perfCard(db, chatId) {
  const { results } = await db.prepare("SELECT person, COUNT(DISTINCT date) days, AVG(per_hour) ph, SUM(errors) err, SUM(COALESCE(total, per_hour * hours)) tot, COUNT(*) n FROM line_perf WHERE chat_id=? AND status='ok' GROUP BY person ORDER BY ph DESC").bind(chatId).all();
  if (!results.length) return textMessage("還沒有工作表現的紀錄。有人說「陳小明每小時 300 張、錯 30 張」我就會記。");
  const rows = results.map((r, i) => {
    const rate = r.err !== null && r.tot ? Math.round(r.err / r.tot * 1000) / 10 : null;
    return { type: "box", layout: "horizontal", margin: "md", alignItems: "center", contents: [
      { type: "text", text: `${i + 1}. ${r.person}`, size: "sm", weight: "bold", color: C.ink, flex: 5 },
      { type: "text", text: r.ph ? `${Math.round(r.ph)}/時` : "–", size: "sm", color: C.brand, align: "end", flex: 3, weight: "bold" },
      { type: "text", text: rate !== null ? `錯 ${rate}%` : "–", size: "xs", color: rate !== null && rate > 8 ? C.red : C.sub, align: "end", flex: 3 },
      { type: "text", text: `${r.days} 天`, size: "xxs", color: C.sub, align: "end", flex: 2 }] };
  });
  return { type: "flex", altText: "蓋章人員表現統計", contents: { type: "bubble", size: "mega",
    header: { type: "box", layout: "vertical", backgroundColor: C.brand, paddingAll: "14px", contents: [
      { type: "text", text: "蓋章人員表現", color: "#FFFFFF", weight: "bold", size: "md" },
      { type: "text", text: "平均每小時張數｜錯誤率｜做過幾天", color: "#CFE3E1", size: "xxs" }] },
    body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows.slice(0, 25) } } };
}

/* ---------- 提醒：前一天 18:00 明天誰上班；法會前 5 天內還沒排滿，每天 09:00 提醒一次 ---------- */
export async function staffTick(env, db, line, now = Date.now()) {
  const t = new Date(now + 8 * 3600e3), h = t.getUTCHours(), mi = t.getUTCMinutes(), today = ymd(now);
  const { results } = await db.prepare("SELECT substr(k, 10) id FROM line_kv WHERE k LIKE 'staff:on:%' AND v='1'").all();
  let sent = 0;
  for (const { id: chatId } of results) {
    if (h === 18 && mi < 5 && !(await kv.get(db, `staff:eve:${chatId}:${today}`))) {
      await kv.set(db, `staff:eve:${chatId}:${today}`, "1");
      const tm = addDays(today, 1);
      const sh = (await db.prepare("SELECT person,role,start,end FROM line_shifts WHERE chat_id=? AND status='ok' AND date=? ORDER BY role, start").bind(chatId, tm).all()).results;
      const need = (await upcoming(db, today, 5)).flatMap(needs).filter(n => n.date === tm);
      if (sh.length || need.length) {
        const lines = ["蓋章", "現場"].map(role => { const w = sh.filter(s => s.role === role); const n = need.find(x => x.role === role); if (!w.length && !n) return null;
          return `${role}：${w.map(s => s.person + (s.start ? `（${s.start}${s.end ? "–" + s.end : ""}）` : "")).join("、") || "還沒有人"}${n && w.length < n.min ? `，還缺 ${n.min - w.length} 人` : ""}`; }).filter(Boolean);
        await line.push(chatId, [textMessage(`明天 ${md(tm)}（${wd(tm)}）的班表～\n${lines.join("\n")}\n大家早點休息，明天見✨`)]).then(() => recordPush(db, chatId, 1)).catch(e => console.log("staff eve", e.message));
        sent++;
      }
    }
    if (h === 9 && mi < 5 && !(await kv.get(db, `staff:short:${chatId}:${today}`))) {
      await kv.set(db, `staff:short:${chatId}:${today}`, "1");
      const sh = (await db.prepare("SELECT date,role FROM line_shifts WHERE chat_id=? AND status='ok' AND date>=?").bind(chatId, today).all()).results;
      const lack = (await upcoming(db, today, 8)).flatMap(needs).filter(n => n.date >= today && n.date <= addDays(today, 5)).map(n => ({ ...n, have: sh.filter(s => s.date === n.date && s.role === n.role).length })).filter(n => n.have < n.min);
      if (lack.length) {
        const adm = (await kv.json(db, "admins", []))[0];
        const txt = `{who} 人手還沒排滿喔：\n${lack.map(n => `・${md(n.date)}（${wd(n.date)}）${n.role} 還缺 ${n.min - n.have} 人`).join("\n")}`;
        await line.push(chatId, [adm ? mentionMessage(txt, adm) : textMessage(txt.replace("{who} ", "")), await rosterCard(db, chatId, today)]).then(() => recordPush(db, chatId, 1)).catch(e => console.log("staff short", e.message));
        sent++;
      }
    }
  }
  if (h === 6 && mi < 5 && !(await kv.get(db, "rites:sync:" + today))) {
    await kv.set(db, "rites:sync:" + today, "1");
    await syncRites(env, db, now).catch(e => console.log("rites sync", e.message));
  }
  return sent;
}
