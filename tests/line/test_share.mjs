// 分享請款單：卡片有分享鈕、分享頁（整張／個人）、分享連結只打得開這一張、個人頁只有他那份
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:"); sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = { bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; }, async run() { const x = st.run(...a); return { meta: { changes: Number(x.changes) } }; } }; return o; } };
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
t(ar && /單已拆過/.test(ar[0].altText) && sq.prepare("SELECT status FROM line_splits WHERE id='n1'").get().status === "cancelled", "after read: cancel + result card");
t(!(await S.elsewhereAfterRead(db, "C8", { merged: true, split: { id: "n1", d: { bill_no: "61030012" } } }, "")), "merged second photo untouched");
// 別群拆好的單：直接出卡；同一天這群已經有別張單，就加問「要跟前面的單合併嗎？」；合併＝合併請款單、不用＝一句話
sq.prepare("INSERT INTO line_splits(id,chat_id,bill_no,created,status,data,result,done_at) VALUES('b3','C1','88880001',?, 'done', ?, ?, ?)").run(Date.now(), JSON.stringify({ ...d, store: "世盟", bill_no: "88880001" }), JSON.stringify(res), Date.now());
const one = await S.elsewhereArrive(db, "C7", await S.doneElsewhere(db, "C7", "61030012"), "https://taxtools.tw");
const oj = JSON.stringify(one);
t(one.length === 1 && one[0].altText === "威士登 10/30 單已拆過" && oj.includes("sp:pick:s:b1") && oj.includes("sp:pick:r:b1"), "elsewhere: one short card with buttons " + one[0].altText);
const p1 = await S.splitPostback({}, db, { chatId: "C7", data: "sp:pick:s:b1", isAdmin: false, origin: "https://taxtools.tw" });
t(p1.length === 1 && /請款單/.test(p1[0].altText), "post the done card (first today: no merge ask)");
await S.elsewhereArrive(db, "C7", await S.doneElsewhere(db, "C7", "88880001"), "https://taxtools.tw");
const two = await S.splitPostback({}, db, { chatId: "C7", data: "sp:pick:s:b3", isAdmin: false, origin: "https://taxtools.tw" });
const qj = JSON.stringify(two[1] || {});
t(two.length === 2 && /請款單/.test(two[0].altText) && /合併嗎/.test(two[1].altText) && qj.includes("sp:cmb:b1,b3") && qj.includes("sp:nocmb"), "second bill same day: card + merge question");
t(/分開就好/.test((await S.splitPostback({}, db, { chatId: "C7", data: "sp:nocmb", isAdmin: false }))[0].text), "no merge");
const mg = await S.splitPostback({}, db, { chatId: "C7", data: "sp:cmb:b1,b3", isAdmin: false, origin: "https://taxtools.tw" });
const cj = JSON.stringify(mg[0] || {});
t(mg.length === 1 && /合併/.test(mg[0].altText) && cj.includes("/split/v?m=") && !cj.includes("split?t="), "merge: combined card with public link");
const cc = await S.combinedForChat(db, "C7", "https://taxtools.tw");
t(cc && /合併/.test(cc.altText), "combine on demand");
t(S.combineCmd("兩張合併") && S.combineCmd("合併") && S.combineCmd("幫我把這兩張單合併") && !S.combineCmd("合併報表要怎麼做"), "combine command");
const mtok = cj.match(/v\?m=([\w,]+)/)[1];
r = await get("v.js", "v?m=" + mtok);
t(r.status === 200 && /合併請款單/.test(r.html) && r.html.includes("世盟") && !r.html.includes("所有帳單") && r.html.includes("/split/v?s="), "public combined page");
// 3 秒內連貼兩張別群拆好的單：只回一次「合併／分開／重新修改」；一張別群的＋一張新帳單＝各自處理
S.BURST.gap = 80; S.BURST.poll = 10; S.BURST.max = 2000;
const T0 = Date.now();
await S.noteImage(db, "C5", "i1", T0); await S.noteImage(db, "C5", "i2", T0 + 30);
const [g1, g2] = await Promise.all([S.settleDone(db, "C5", "i1", "b1"), (async () => { await new Promise(r => setTimeout(r, 20)); return S.settleDone(db, "C5", "i2", "b3"); })()]);
const modes = [g1.mode, g2.mode].sort().join();
t(modes === "group,skip" && [g1, g2].find(x => x.mode === "group").ids.sort().join() === "b1,b3", "burst: one group reply, other skips " + JSON.stringify([g1, g2]));
await S.noteImage(db, "C4", "j1", T0); await S.noteImage(db, "C4", "j2", T0 + 30);
await S.markImage(db, "C4", "j2", { k: "new" });
t((await S.settleDone(db, "C4", "j1", "b1")).mode === "solo", "burst mixed with new bill: solo");
await S.noteImage(db, "C3", "k1", Date.now());
t((await S.settleDone(db, "C3", "k1", "b1")).mode === "solo", "single image: solo");
const pm = await S.pickMessages(db, ["b1", "b3"]), pj = JSON.stringify(pm);
t(/都已經拆過帳/.test(pm[0].altText) && pj.includes("sp:pick:m:b1,b3") && pj.includes("sp:pick:s:b1,b3") && pj.includes("sp:pick:r:b1,b3"), "pick card 3 options");
let pr = await S.splitPostback({}, db, { chatId: "C5", data: "sp:pick:m:b1,b3", isAdmin: false, origin: "https://taxtools.tw" });
const pmj = JSON.stringify(pr);
t(pr.length === 1 && /合併/.test(pr[0].altText) && pmj.includes("split/share?m=") && pmj.includes('"label":"分享"'), "pick merge: combined card with share");
pr = await S.splitPostback({}, db, { chatId: "C5", data: "sp:pick:s:b1,b3", isAdmin: false, origin: "https://taxtools.tw" });
t(pr.length === 2 && pr.every(m => /請款單/.test(m.altText)), "pick separate: two cards");
t(/只有 Ben/.test((await S.splitPostback({}, db, { chatId: "C5", data: "sp:pick:r:b1,b3", isAdmin: false, origin: "https://taxtools.tw" }))[0].text), "pick redo: admin only");
pr = await S.splitPostback({}, db, { chatId: "C5", data: "sp:pick:r:b1,b3", isAdmin: true, origin: "https://taxtools.tw" });
t(pr.length === 2 && sq.prepare("SELECT count(*) n FROM line_splits WHERE chat_id='C5' AND status='ask'").get().n === 2, "pick redo: two forms");
// 合併請款單的分享頁、個人合計頁
const mt = pmj.match(/split\/share\?m=([\w,]+)/)[1];
r = await get("share.js", "share?m=" + mt);
t(r.status === 200 && /整份合併單/.test(r.html) && (r.html.match(/line\.me\/R\/share/g) || []).length >= 3, "combined share page");
r = await get("v.js", "v?m=" + mt + "&p=Jim");
t(r.status === 200 && /Jim/.test(r.html) && !/<span>Ben<\/span>/.test(r.html) && /他的合計/.test(r.html), "combined person page only him");
// 回覆引用對方的訊息
const L = await import(R + "/lib/line.js");
t(L.withQuote([{ type: "flex" }, { type: "text", text: "x" }], "QT")[1].quoteToken === "QT" && !L.withQuote([{ type: "flex" }], "QT")[0].quoteToken, "quote first text message");
// 中間有別的訊息才引用；直接接著回不引用
{ const ev = { timestamp: Date.now() - 10000, source: { userId: "U1" }, message: { id: "m1", type: "image", quoteToken: "QT" } };
  t(!(await L.interrupted(db, "C2", ev)), "no other messages: no quote");
  sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts,media) VALUES('C2','U1','Ben','［傳了一張照片］',?, 'm1')").run(Date.now());
  t(!(await L.interrupted(db, "C2", ev)), "own message row ignored");
  sq.prepare("INSERT INTO line_msgs(chat_id,user_id,name,text,ts) VALUES('C2','U2','Jim','哈哈',?)").run(Date.now());
  t(await L.interrupted(db, "C2", ev), "someone talked in between: quote"); }
console.log(`${ok} passed, ${bad} failed`);
