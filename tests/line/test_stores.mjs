// 店家資料：存地圖／規則／別名、帳單別名對到正式店名、查詢、店家清單
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
const S = await import(R + "/lib/stores.js");
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const ins = (id, store, total, no) => sq.prepare("INSERT INTO line_splits(id,chat_id,status,data,result,created) VALUES(?,?,?,?,?,?)").run(id, "C1", "done", JSON.stringify({ store, bill_no: no }), JSON.stringify({ total }), Date.now());
ins("a", "SS", 47100, "1"); ins("b", "世盟", 28660, "2"); ins("c", "ＳＳ", 30000, "3");
const admin = { db, isAdmin: true, userId: "U_ben" }, guest = { db, isAdmin: false };
// 1. 只有老闆能改
t((await S.runStoreTool(guest, "store_set", { name: "香閣", rules: "x" })).error, "guest cannot set");
// 2. 存地圖、規則；「SS 就是香閣」→ 別名，舊帳單改名
let r = await S.runStoreTool(admin, "store_set", { name: "香閣", map: "https://maps.app.goo.gl/abc", rules: "每節 1,500" });
t(r.ok && r.store.map.includes("maps"), "set map/rules");
r = await S.runStoreTool(admin, "store_set", { name: "香閣", aliases_add: ["SS"], rules_add: "服務費 10%" });
t(r.store.aliases.includes("SS") && /每節 1,500\n服務費 10%/.test(r.store.rules), "alias + rules_add");
t(JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id='a'").get().data).store === "香閣" && JSON.parse(sq.prepare("SELECT data FROM line_splits WHERE id='c'").get().data).store === "香閣", "old bills renamed (incl. full-width)");
// 3. 帳單讀到的別名（全形、大小寫）→ 正式名稱
t(await S.resolveStore(db, "ｓｓ") === "香閣" && await S.resolveStore(db, "世盟") === "世盟", "resolve alias");
// 4. 查詢：資料＋拆過幾張、平均
r = await S.runStoreTool(guest, "store_get", { name: "SS" });
t(r.found && r.name === "香閣" && r.stats.bills >= 1 && /maps/.test(r.map), "get by alias " + JSON.stringify(r));
// 5. 店家清單：有資料的、只有帳單的
const txt = await S.storeListText(db);
t(/香閣（又叫 SS）/.test(txt) && /有地圖/.test(txt) && /世盟　帳單 1 張　還沒有資料/.test(txt), "list " + txt);
// 6. 改名：舊名變別名
r = await S.runStoreTool(admin, "store_set", { name: "香閣", rename: "香閣會館" });
t(r.store.name === "香閣會館" && r.store.aliases.includes("香閣") && await S.resolveStore(db, "SS") === "香閣會館", "rename keeps old as alias");
console.log(`${ok} passed, ${bad} failed`);
