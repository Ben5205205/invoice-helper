// 分享請款單：卡片有分享鈕、分享頁（整張／個人）、分享連結只打得開這一張、個人頁只有他那份
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:"); sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = { bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; }, async run() { st.run(...a); return {}; } }; return o; } };
const S = await import(R + "/lib/split.js");
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const d = { store: "威士登", date: "10/30", cash: 10000, origin: "https://taxtools.tw", payee: "Jim",
  hostess: [{ id: "h0", name: "草莓", lines: [], amount: 6000, guest: "g0" }], shared: [{ id: "s0", name: "包廂", qty: 1, price: 4000, amount: 4000, who: null }],
  guests: [{ id: "g0", name: "Ben" }, { id: "g1", name: "Jim" }, { id: "g2", name: "雀" }], merge: { g2: "g1" }, free: [] };
const res = S.compute(d);
sq.prepare("INSERT INTO line_splits(id,chat_id,created,status,data,result) VALUES('b1','C1',1,'done',?,?)").run(JSON.stringify(d), JSON.stringify(res));
sq.prepare("INSERT INTO line_splits(id,chat_id,created,status,data,result) VALUES('b2','C1',2,'done',?,?)").run(JSON.stringify({ ...d, store: "別家" }), JSON.stringify(res));
const [, card] = await S.cardMessages(db, { id: "b1", chat_id: "C1", d, result: JSON.stringify(res) });
const js = JSON.stringify(card), m = js.match(/split\/share\?s=(\w+)/);
t(m && js.includes('"label":"分享"') && js.includes("修改拆帳"), "card has share button + edit link");
const s = m[1], env = { DB: db };
const get = async (mod, q) => { const r = await (await import(R + "/functions/split/" + mod)).onRequestGet({ request: new Request("https://taxtools.tw/split/" + q), env }); return { status: r.status, html: await r.text() }; };
let r = await get("share.js", "share?s=" + s);
const links = [...r.html.matchAll(/href="(https:\/\/line\.me\/R\/share\?text=[^"]+)"/g)].map(x => decodeURIComponent(x[1].replace(/&amp;/g, "&").split("text=")[1]));
t(r.status === 200 && links.length === 3, "share page: whole + 2 payers " + links.length);
t(/威士登 10\/30 請款單/.test(links[0]) && links[0].includes("/split/v?s=" + s) && !/&p=/.test(links[0]), "whole link");
t(links.some(l => /Jim 的請款單/.test(l) && /&p=g1/.test(l)), "person link");
r = await get("v.js", "v?s=" + s);
t(r.status === 200 && r.html.includes("og:image") && r.html.includes("weishideng.jpg") && !r.html.includes("所有帳單") && !r.html.includes("帳單照片") && !r.html.includes("別家"), "whole page public, no group stuff");
r = await get("v.js", "v?s=" + s + "&p=g1");
t(r.html.includes("Jim") && r.html.includes("雀") && !/<b>Ben<\/b>/.test(r.html) && r.html.includes("og:title"), "person page only his share incl. merged");
t((await get("v.js", "v?s=bogusbogusbogusbogus12")).status === 404, "bad token 404");
// 別的群組已經拆好的單：直接給結果卡（連結是單張分享，不是原本群組的）
sq.prepare("UPDATE line_splits SET bill_no='61030012', done_at=5, created=" + Date.now() + " WHERE id='b1'").run();
t(!(await S.doneElsewhere(db, "C1", "61030012")), "same group is not elsewhere");
const ow = await S.doneElsewhere(db, "C9", "6103 0012");
t(ow && ow.id === "b1", "found in other group");
const em = await S.elsewhereMessages(db, ow, "https://taxtools.tw"), ej = JSON.stringify(em);
t(em.length === 2 && /已經拆好/.test(em[0].text) && ej.includes("/split/v?s=" + s) && !ej.includes("split?t=") && ej.includes("split/share?s="), "elsewhere card uses share links");
// 在這群重新拆：只有 Ben；複製一份到這群（帶上次的人），給表單；同一群再按不會再複製
t(JSON.stringify(em[1]).includes("sp:here:b1"), "here button on card");
t(/只有 Ben/.test((await S.splitPostback({}, db, { chatId: "C9", data: "sp:here:b1", isAdmin: false, origin: "https://taxtools.tw" }))[0].text), "here: admin only");
let hp = await S.splitPostback({}, db, { chatId: "C9", data: "sp:here:b1", isAdmin: true, origin: "https://taxtools.tw" });
const cp = sq.prepare("SELECT * FROM line_splits WHERE chat_id='C9'").all();
t(cp.length === 1 && cp[0].status === "ask" && JSON.parse(cp[0].data).guests.length === 3 && !JSON.parse(cp[0].data).payee && /帶好了/.test(hp[0].altText), "here: copied with guests, form " + JSON.stringify(hp).slice(0, 100));
await S.splitPostback({}, db, { chatId: "C9", data: "sp:here:b1", isAdmin: true, origin: "https://taxtools.tw" });
t(sq.prepare("SELECT count(*) n FROM line_splits WHERE chat_id='C9'").get().n === 1, "here: no duplicate");
// 單號寫法不同也對得到；讀完帳單才知道單號的，剛開的那筆取消、改給結果卡
t((await S.doneElsewhere(db, "C8", "61030012-")).id === "b1" && (await S.doneElsewhere(db, "C8", "61030012[002-1]")).id === "b1", "bill no normalized");
sq.prepare("INSERT INTO line_splits(id,chat_id,bill_no,created,status,data) VALUES('n1','C8','61030012',?, 'ask', ?)").run(Date.now(), JSON.stringify({ bill_no: "61030012" }));
const ar = await S.elsewhereAfterRead(db, "C8", { split: { id: "n1", d: { bill_no: "6103 0012" } } }, "https://taxtools.tw");
t(ar && /已經拆好/.test(ar[0].text) && sq.prepare("SELECT status FROM line_splits WHERE id='n1'").get().status === "cancelled", "after read: cancel + result card");
t(!(await S.elsewhereAfterRead(db, "C8", { merged: true, split: { id: "n1", d: { bill_no: "61030012" } } }, "")), "merged second photo untouched");
console.log(`${ok} passed, ${bad} failed`);
