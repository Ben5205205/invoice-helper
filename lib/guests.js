// 酒客個人紀錄：從拆好的帳單統計每個人去了幾次、自己花了多少、常點誰、喝了什麼、去過哪幾家。
//   群組裡只算「這個群組」拆過的帳單（不會把別群的消費講出來）；老闆私訊／私人助理群看全部。
//   「恩客排行」＝本月排行卡（第一名是恩客NO.1）；「上個月恩客」看上個月。
//   聊天時：說話的人如果有紀錄，給小秘書一段短短的背景，讓它偶爾自然帶到（例如上次喝的酒）。
import { itemKind } from "./billstats.js";

const TZ = 8 * 3600e3;
export const guestKey = s => String(s || "").replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s·・._\-()（）]/g, "").toUpperCase();
const fmt = n => "$" + Math.round(n).toLocaleString("en-US");
export function monthRange(which = "this", now = Date.now()) {
  const t = new Date(now + TZ);
  let y = t.getUTCFullYear(), m = t.getUTCMonth();
  const mm = String(which || "").match(/^(\d{4})[-/](\d{1,2})$/);
  if (mm) { y = +mm[1]; m = +mm[2] - 1; } else if (which === "last") m -= 1;
  const from = Date.UTC(y, m, 1) - TZ, to = Date.UTC(y, m + 1, 1) - TZ;
  return { from, to, label: `${new Date(from + TZ).getUTCMonth() + 1} 月` };
}
const isDrink = s => s.cat === "酒" || itemKind(s) === "drink" || /酒|威士忌|麥卡倫|格蘭|約翰走路|起瓦士|百富|響|山崎|香檳|啤酒|紅酒|白酒|清酒|高粱|伏特加|龍舌蘭|XO|VSOP/i.test(s.name || "");
const hostessName = n => String(n).replace(/^小姐｜/, "").replace(/（[^）]*）$/, "");

/* 拆好的帳單（同一張單重拆過只算最新那次） */
async function bills(db, { chatId, all, from = 0, to = Date.now() + 864e5 }) {
  const q = all ? db.prepare("SELECT id,chat_id,created,data,result FROM line_splits WHERE status='done' AND result IS NOT NULL AND created>=? AND created<? ORDER BY created DESC").bind(from, to)
    : db.prepare("SELECT id,chat_id,created,data,result FROM line_splits WHERE chat_id=? AND status='done' AND result IS NOT NULL AND created>=? AND created<? ORDER BY created DESC").bind(chatId, from, to);
  const { results } = await q.all().catch(() => ({ results: [] }));
  const seen = new Set(), out = [];
  for (const r of results) {
    let d, res; try { d = JSON.parse(r.data); res = JSON.parse(r.result); } catch { continue; }
    if (!res?.people?.length) continue;
    const k = d.bill_no ? guestKey(d.store) + "|" + String(d.bill_no).replace(/\s/g, "") : "id|" + r.id;
    if (seen.has(k)) continue;
    seen.add(k); out.push({ ...r, d, res });
  }
  return out;
}

/* 每個人的統計：{ key: {name, visits, spent, hostess:{名字:次數}, drinks:{酒:瓶}, stores:{店:次}, last:{…}} } */
export function tally(list) {
  const m = new Map();
  for (const b of [...list].sort((a, z) => a.created - z.created)) {
    const drinks = (b.d.shared || []).filter(isDrink);
    for (const p of b.res.people) {
      const k = guestKey(p.name); if (!k) continue;
      const g = m.get(k) || { name: p.name, visits: 0, spent: 0, hostess: {}, drinks: {}, stores: {}, last: null };
      g.name = p.name; g.visits++; g.spent += p.total || 0;
      const hs = [...new Set((p.items || []).filter(x => String(x.name).startsWith("小姐｜")).map(x => hostessName(x.name)))];
      for (const h of hs) g.hostess[h] = (g.hostess[h] || 0) + 1;
      // 酒是全桌一起喝的：有分到這瓶酒的人才算他喝過
      const mine = drinks.filter(s => !s.who || s.who.includes(p.id));
      for (const s of mine) g.drinks[s.name] = (g.drinks[s.name] || 0) + (s.qty || 1);
      if (b.d.store) g.stores[b.d.store] = (g.stores[b.d.store] || 0) + 1;
      g.last = { store: b.d.store || "", date: b.d.date || "", ts: b.created, hostess: hs, drinks: mine.map(s => s.name + (s.qty > 1 ? "×" + s.qty : "")), with: b.res.people.filter(x => x.id !== p.id).map(x => x.name) };
      m.set(k, g);
    }
  }
  return m;
}
const top = (o, n = 3) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

export async function guestStats(db, { chatId, all, which = "this", name, now = Date.now() }) {
  const r = which === "all" ? { from: 0, to: now + 864e5, label: "全部" } : monthRange(which, now);
  const t = tally(await bills(db, { chatId, all, from: r.from, to: r.to }));
  const list = [...t.values()].sort((a, b) => b.spent - a.spent);
  if (name) { const k = guestKey(name); return { range: r.label, guest: list.find(g => guestKey(g.name) === k) || list.find(g => k.length >= 2 && (guestKey(g.name).includes(k) || k.includes(guestKey(g.name)))) || null }; }
  return { range: r.label, list };
}

/* LINE 暱稱 → 帳單上的名字（大小寫、全半形不管；暱稱包含帳單名字也算，例如「Ben Wu」→ Ben） */
export function matchGuest(names, lineName) {
  const k = guestKey(lineName); if (!k) return null;
  return names.find(n => guestKey(n) === k) || names.filter(n => guestKey(n).length >= 2 && k.includes(guestKey(n))).sort((a, b) => guestKey(b).length - guestKey(a).length)[0] || null;
}

/* 給聊天 AI：說話的人的酒客紀錄（短） */
export async function guestContext(db, { chatId, all, userName, now = Date.now() }) {
  if (!userName) return "";
  const t = tally(await bills(db, { chatId, all, from: now - 180 * 864e5, to: now + 864e5 }));
  const nm = matchGuest([...t.values()].map(g => g.name), userName);
  if (!nm) return "";
  const g = t.get(guestKey(nm)), mr = monthRange("this", now);
  const month = tally(await bills(db, { chatId, all, from: mr.from, to: mr.to })).get(guestKey(nm));
  const l = g.last, ago = Math.round((now - l.ts) / 864e5);
  return `\n\n正在跟你說話的 ${userName}，在拆帳紀錄裡叫「${nm}」：最近半年去了 ${g.visits} 次${month ? `，這個月 ${month.visits} 次` : "，這個月還沒去"}；` +
    `上次是 ${ago <= 0 ? "今天" : ago + " 天前"}（${[l.date, l.store].filter(Boolean).join(" ")}）${l.hostess.length ? "，坐他旁邊的是 " + l.hostess.join("、") : ""}${l.drinks.length ? "，那桌喝了 " + l.drinks.join("、") : ""}${l.with.length ? "，一起去的有 " + l.with.join("、") : ""}。` +
    `${top(g.hostess).length ? "常點：" + top(g.hostess).join("、") + "。" : ""}${top(g.drinks).length ? "愛喝：" + top(g.drinks, 2).join("、") + "。" : ""}${top(g.stores).length ? "常去：" + top(g.stores, 2).join("、") + "。" : ""}\n` +
    `這是你記得的事，像熟客的朋友那樣偶爾自然帶一句就好（例如「上次那瓶${l.drinks[0] ? l.drinks[0].replace(/×\d+$/, "") : "酒"}喝完了沒」），不是每次都提，話題接不上就不要提；不要主動說他花了多少錢，他自己問才說。`;
}

/* ---------- 恩客排行卡 ---------- */
const W = { head: "#5A1E33", tint: "#F8EEF1", gold: "#D9731A", goldBg: "#FFF6EA", goldBd: "#F6C48F", ink: "#1F2937", sub: "#6B7280" };
export function rankCard(range, list, scope) {
  const rows = list.slice(0, 8).map((g, i) => {
    const first = i === 0, likes = [top(g.hostess, 2).length ? "常點 " + top(g.hostess, 2).join("、") : "", top(g.drinks, 1).length ? "愛喝 " + top(g.drinks, 1)[0] : ""].filter(Boolean).join("｜");
    return { type: "box", layout: "vertical", paddingAll: "10px", cornerRadius: "10px", margin: i ? "sm" : "none",
      ...(first ? { backgroundColor: W.goldBg, borderColor: W.goldBd, borderWidth: "1px" } : { backgroundColor: i % 2 ? "#FFFFFF" : W.tint }),
      contents: [
        { type: "box", layout: "horizontal", contents: [
          { type: "text", text: first ? "👑" : String(i + 1), size: first ? "md" : "sm", color: first ? W.gold : W.sub, flex: 1, weight: "bold", gravity: "center" },
          { type: "text", text: g.name, size: first ? "md" : "sm", weight: "bold", color: W.ink, flex: 5, gravity: "center", wrap: true },
          { type: "text", text: `${g.visits} 次`, size: "xs", color: W.sub, flex: 2, align: "end", gravity: "center" },
          { type: "text", text: fmt(g.spent), size: first ? "md" : "sm", weight: "bold", color: first ? W.gold : W.ink, flex: 4, align: "end", gravity: "center" }] },
        ...(first ? [{ type: "text", text: "恩客NO.1 ✨", size: "xxs", color: W.gold, weight: "bold", margin: "xs", offsetStart: "28px" }] : []),
        ...(likes ? [{ type: "text", text: likes, size: "xxs", color: W.sub, margin: "xs", wrap: true, offsetStart: "28px" }] : [])] };
  });
  const total = list.reduce((a, g) => a + g.spent, 0);
  return { type: "flex", altText: `${range}恩客榜：${list[0] ? "NO.1 " + list[0].name : "還沒有紀錄"}`,
    contents: { type: "bubble", size: "mega",
      header: { type: "box", layout: "vertical", backgroundColor: W.head, paddingAll: "16px", contents: [
        { type: "text", text: "🍷 恩客榜", color: "#F3D9E0", size: "xs" },
        { type: "text", text: `${range}｜${list.length} 位酒客｜合計 ${fmt(total)}`, color: "#FFFFFF", weight: "bold", size: "md", margin: "xs", wrap: true }] },
      body: { type: "box", layout: "vertical", paddingAll: "12px", contents: rows.length ? rows : [{ type: "text", text: "這個月還沒有拆過帳。", size: "sm", color: W.sub }] },
      footer: { type: "box", layout: "vertical", paddingAll: "10px", contents: [
        { type: "text", text: `${scope}｜金額是自己那份（小姐＋公帳分攤）`, size: "xxs", color: W.sub, align: "center", wrap: true }] } } };
}
export async function rankMessages(db, { chatId, all, which = "this", now = Date.now() }) {
  const s = await guestStats(db, { chatId, all, which, now });
  return [rankCard(s.range, s.list, all ? "所有群組拆過的帳單" : "只算這個群組拆過的帳單")];
}
export const rankCmd = c => { const m = String(c || "").trim().match(/^(本月|這個月|上個月|上月)?\s*(恩客(排行|榜|NO\.?1|排名)|恩客)$/i); return m ? (/上/.test(m[1] || "") ? "last" : "this") : null; };

/* ---------- AI 工具 ---------- */
export const GUEST_TOOLS = [
  { name: "guest_stats", description: "查酒客個人紀錄（從拆好的帳單統計）：去了幾次、自己花了多少、常點哪位小姐、喝了什麼、常去哪家、上次去的情形。不給 name 就是排行。有人問「我這個月去了幾次／花多少」「誰是恩客」「Jim 都點誰」時用。群組裡只會查到這個群組的帳單。",
    input_schema: { type: "object", properties: { name: { type: "string", description: "帳單上的名字；問自己就填他的名字" }, month: { type: "string", description: "this（本月，預設）、last（上個月）、all（全部）、或 2026-10" } } } },
];
export async function runGuestTool(ctx, name, input) {
  if (name !== "guest_stats") return null;
  const all = !!(ctx.isAdmin && ctx.private);
  const which = input.month || "this";
  const s = await guestStats(ctx.db, { chatId: ctx.chatId, all, which, name: input.name || null });
  const view = g => g && { name: g.name, visits: g.visits, spent: Math.round(g.spent), hostess: top(g.hostess, 5), drinks: top(g.drinks, 5), stores: top(g.stores, 5), last: g.last && { ...g.last, ts: undefined } };
  if (input.name) return { range: s.range, found: !!s.guest, guest: view(s.guest) };
  return { range: s.range, ranking: s.list.slice(0, 10).map(view), note: "說「恩客排行」會貼排行卡" };
}
