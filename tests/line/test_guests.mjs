// 酒客個人紀錄：每人次數／花費／常點／喝什麼、同單重拆只算一次、只算這群、暱稱對名字、排行卡、聊天背景
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
const G = await import(R + "/lib/guests.js");
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const now = Date.UTC(2026, 10, 20, 4);   // 11/20 中午（台北）
const person = (id, name, total, hs) => ({ id, name, total, items: hs.map(h => ({ name: "小姐｜" + h, amount: 1 })) });
const ins = (id, chat, created, d, people) => sq.prepare("INSERT INTO line_splits(id,chat_id,status,data,result,created) VALUES(?,?,?,?,?,?)").run(id, chat, "done", JSON.stringify(d), JSON.stringify({ total: 1, people, payers: [] }), created);
const whisky = { name: "格蘭利威13年", qty: 3, amount: 7800, cat: "酒", who: null };
ins("a", "C1", now - 5 * 864e5, { store: "威士登", bill_no: "1", date: "11/15", shared: [whisky] }, [person("g0", "Ben", 30000, ["草莓"]), person("g1", "Jim", 20000, ["NN"])]);
ins("a2", "C1", now - 5 * 864e5 + 1000, { store: "威士登", bill_no: "1", date: "11/15", shared: [whisky] }, [person("g0", "Ben", 31000, ["草莓"]), person("g1", "Jim", 19000, ["NN"])]);   // 同一張單重拆：只算最新
ins("b", "C1", now - 2 * 864e5, { store: "香閣", bill_no: "2", date: "11/18", shared: [{ name: "麥卡倫12年", qty: 1, amount: 5000, cat: "酒", who: ["g1"] }] }, [person("g0", "BEN", 10000, ["草莓", "蕾琳"]), person("g1", "Jim", 25000, ["NN"])]);
ins("c", "C2", now - 1 * 864e5, { store: "世盟", bill_no: "3", date: "11/19", shared: [] }, [person("g0", "Ben", 99999, ["X"])]);   // 別群
ins("d", "C1", Date.UTC(2026, 9, 20), { store: "香閣", bill_no: "9", date: "10/20", shared: [] }, [person("g0", "Ben", 5000, [])]);   // 上個月

let s = await G.guestStats(db, { chatId: "C1", now });
const ben = s.list.find(g => g.name.toUpperCase() === "BEN"), jim = s.list.find(g => g.name === "Jim");
t(s.range === "11 月" && s.list.length === 2, "this month, this group only " + JSON.stringify(s.list.map(g => g.name)));
t(ben.visits === 2 && ben.spent === 41000, "Ben dedupe + case-insensitive " + JSON.stringify(ben));
t(jim.visits === 2 && jim.spent === 44000 && s.list[0].name === "Jim", "Jim is NO.1");
t(ben.hostess["草莓"] === 2 && ben.hostess["蕾琳"] === 1, "hostess counts");
t(ben.drinks["格蘭利威13年"] === 3 && !ben.drinks["麥卡倫12年"] && jim.drinks["麥卡倫12年"] === 1, "drinks only if shared to him");
s = await G.guestStats(db, { chatId: "C1", which: "last", now });
t(s.range === "10 月" && s.list.length === 1 && s.list[0].spent === 5000, "last month");
s = await G.guestStats(db, { all: true, now });
t(s.list.find(g => g.name.toUpperCase() === "BEN").spent === 140999, "admin all groups");
// 暱稱對名字
t(G.matchGuest(["Ben", "Jim"], "Ben Wu") === "Ben" && G.matchGuest(["Ben", "Jim"], "ｊｉｍ") === "Jim" && G.matchGuest(["Ben"], "Benson") === "Ben" && G.matchGuest(["IF"], "小美") === null, "match line name");
// 指令
t(G.rankCmd("恩客排行") === "this" && G.rankCmd("上個月恩客") === "last" && G.rankCmd("本月恩客榜") === "this" && G.rankCmd("恩客是誰") === null, "rank command");
// 排行卡
const [card] = await G.rankMessages(db, { chatId: "C1", now });
const js = JSON.stringify(card);
t(card.type === "flex" && /NO.1 Jim/.test(card.altText) && js.includes("👑") && js.includes("恩客NO.1") && js.includes("$44,000") && js.includes("只算這個群組"), "rank card");
// 聊天背景
const ctx = await G.guestContext(db, { chatId: "C1", userName: "Ben Wu", now });
t(/叫「(Ben|BEN)」/.test(ctx) && /這個月 2 次/.test(ctx) && /香閣/.test(ctx) && /草莓/.test(ctx) && /不要主動說他花了多少錢/.test(ctx) && !/99999/.test(ctx), "guest context " + ctx);
t((await G.guestContext(db, { chatId: "C1", userName: "路人", now })) === "", "no record no context");
// 工具
const r = await G.runGuestTool({ db, chatId: "C1", isAdmin: false }, "guest_stats", { name: "jim" });
t(r.found && r.guest.visits === 2 && r.guest.hostess[0] === "NN", "tool by name");
console.log(`${ok} passed, ${bad} failed`);
