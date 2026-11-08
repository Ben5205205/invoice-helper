// 店家資料：店名、別名、地圖、計費規則、備註。Ben 在 LINE 跟小幫手說就會存（私訊或群組都可以）。
// 讀帳單時把別名對到正確的店；有人問「XX 在哪」「去 XX 怎麼算」就照這裡回答；說「店家清單」列出全部。

export const STORES_SQL = `CREATE TABLE IF NOT EXISTS line_stores (id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT, map TEXT, address TEXT, rules TEXT, notes TEXT, updated INTEGER NOT NULL, updated_by TEXT);`;
export const storeKey = s => String(s || "").replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s·・._\-]/g, "").toUpperCase();

async function all(db) {
  const { results } = await db.prepare("SELECT * FROM line_stores ORDER BY name").all().catch(() => ({ results: [] }));
  return results.map(r => ({ ...r, aliases: JSON.parse(r.aliases || "[]") }));
}
/* 帳單上讀到的店名 → 店家資料裡的正式名稱（對不到就照原樣） */
export async function resolveStore(db, raw) {
  const k = storeKey(raw);
  if (!k) return raw || "";
  const hit = (await all(db)).find(s => storeKey(s.name) === k || s.aliases.some(a => storeKey(a) === k));
  return hit ? hit.name : raw;
}
async function find(db, name) {
  const k = storeKey(name), list = await all(db);
  return list.find(s => storeKey(s.name) === k || s.aliases.some(a => storeKey(a) === k)) || list.find(s => k && (storeKey(s.name).includes(k) || k.includes(storeKey(s.name)))) || null;
}

/* ---------- AI 工具 ---------- */
export const STORE_TOOLS = [
  { name: "store_set", description: "存店家資料（只有老闆能改）：店名、別名（帳單上的簡稱、英文名，例如 SS）、Google 地圖連結、地址、計費規則（每節多少、包廂、低消、服務費、刷卡加成…）、備註。只填這次要改的欄位；rules_add／notes_add 是在原本的後面加一條，rules／notes 是整段換掉。老闆說「SS 就是香閣」＝把 SS 加進香閣的 aliases。",
    input_schema: { type: "object", properties: { name: { type: "string" }, rename: { type: "string" }, aliases_add: { type: "array", items: { type: "string" } }, map: { type: "string" }, address: { type: "string" }, rules: { type: "string" }, rules_add: { type: "string" }, notes: { type: "string" }, notes_add: { type: "string" } }, required: ["name"] } },
  { name: "store_get", description: "查一家店的資料（地圖、地址、計費規則、備註、別名），也會附上這家店拆過幾張帳單、平均多少。有人問「XX 在哪」「去 XX 怎麼算」「XX 的規則」時用。", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "store_list", description: "列出所有店家（店家資料＋拆過帳的店）。", input_schema: { type: "object", properties: {} } },
];
export async function runStoreTool(ctx, name, input) {
  const { db } = ctx;
  if (name === "store_set") {
    if (!ctx.isAdmin) return { error: "店家資料只有老闆能改" };
    const nm = String(input.name || "").trim();
    if (!nm) return { error: "沒有店名" };
    let s = await find(db, nm);
    const now = Date.now();
    if (!s) s = { id: storeKey(nm), name: nm, aliases: [], map: null, address: null, rules: "", notes: "" };
    if (input.rename) s.name = String(input.rename).trim();
    const add = (input.aliases_add || []).map(a => String(a).trim()).filter(a => a && storeKey(a) !== storeKey(s.name));
    s.aliases = [...new Set([...(s.aliases || []), ...add, ...(input.rename && storeKey(input.rename) !== storeKey(nm) ? [nm] : [])])];
    if (input.map) s.map = String(input.map).trim();
    if (input.address) s.address = String(input.address).trim();
    if (typeof input.rules === "string") s.rules = input.rules.trim();
    if (input.rules_add) s.rules = [s.rules, String(input.rules_add).trim()].filter(Boolean).join("\n");
    if (typeof input.notes === "string") s.notes = input.notes.trim();
    if (input.notes_add) s.notes = [s.notes, String(input.notes_add).trim()].filter(Boolean).join("\n");
    await db.prepare("INSERT OR REPLACE INTO line_stores(id,name,aliases,map,address,rules,notes,updated,updated_by) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(s.id, s.name, JSON.stringify(s.aliases), s.map || null, s.address || null, s.rules || null, s.notes || null, now, ctx.userId || null).run();
    // 以前帳單上讀到的別名，也改成正式店名（紀錄、後台、範例卡才會算同一家）
    const keys = new Set([s.name, ...s.aliases].map(storeKey));
    const { results: seen } = await db.prepare("SELECT DISTINCT json_extract(data,'$.store') store FROM line_splits").all().catch(() => ({ results: [] }));
    for (const x of seen) if (x.store && x.store !== s.name && keys.has(storeKey(x.store))) await db.prepare("UPDATE line_splits SET data=json_set(data,'$.store',?) WHERE json_extract(data,'$.store')=?").bind(s.name, x.store).run().catch(() => {});
    return { ok: true, store: { name: s.name, aliases: s.aliases, map: s.map, address: s.address, rules: s.rules, notes: s.notes } };
  }
  if (name === "store_get") {
    const s = await find(db, input.name);
    const key = s ? [s.name, ...s.aliases] : [String(input.name || "")];
    const bills = (await db.prepare(`SELECT result FROM line_splits WHERE status='done' AND result IS NOT NULL AND json_extract(data,'$.store') IN (${key.map(() => "?").join(",")})`).bind(...key).all()).results;
    const totals = bills.map(b => JSON.parse(b.result).total).filter(Boolean);
    const stats = totals.length ? { bills: totals.length, avg: Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) } : { bills: 0 };
    if (!s) return { found: false, stats, note: "店家資料裡還沒有這家店" };
    return { found: true, name: s.name, aliases: s.aliases, map: s.map, address: s.address, rules: s.rules, notes: s.notes, stats };
  }
  if (name === "store_list") return { stores: await listStores(db) };
  return null;
}
export async function listStores(db) {
  const list = await all(db);
  const { results } = await db.prepare("SELECT json_extract(data,'$.store') store, COUNT(DISTINCT COALESCE(json_extract(data,'$.bill_no'), id)) n FROM line_splits WHERE status='done' GROUP BY store").all();
  const out = list.map(s => ({ name: s.name, aliases: s.aliases, map: !!s.map, rules: !!s.rules, bills: results.filter(r => r.store === s.name || s.aliases.includes(r.store)).reduce((a, r) => a + r.n, 0) }));
  for (const r of results) if (r.store && !list.some(s => s.name === r.store || s.aliases.includes(r.store))) out.push({ name: r.store, aliases: [], map: false, rules: false, bills: r.n, missing: true });
  return out;
}
/* 「店家清單」：不用 AI 的快速回覆 */
export async function storeListText(db) {
  const l = await listStores(db);
  if (!l.length) return "還沒有任何店家資料，也還沒拆過帳。";
  return "店家清單：\n" + l.map(s => `・${s.name}${s.aliases.length ? "（又叫 " + s.aliases.join("、") + "）" : ""}　帳單 ${s.bills} 張${s.missing ? "　還沒有資料" : `${s.map ? "　有地圖" : "　缺地圖"}${s.rules ? "　有規則" : "　缺規則"}`}`).join("\n") + "\n\n要補資料直接跟我說，例如「香閣的地圖是 …」「香閣每節 1,500，服務費 10%」「SS 就是香閣」。";
}
/* 給聊天 AI 的店名一覽（短） */
export async function storeNames(db) {
  const l = await all(db);
  return l.length ? `\n\n店家資料裡有：${l.map(s => s.name + (s.aliases.length ? "（" + s.aliases.join("、") + "）" : "")).join("、")}。有人問店家的位置、地圖、計費規則，用 store_get 查；老闆給店家資訊（地圖、規則、別名）就用 store_set 存。` : "\n\n老闆給店家資訊（地圖、地址、計費規則、別名）時，用 store_set 存起來；有人問店家資訊用 store_get。";
}
