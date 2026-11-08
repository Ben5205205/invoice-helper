// 一次貼兩張單：各自拆完、各自貼完後，另外貼一張合併請款單；每個人每家店分開
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const R = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const sq = new DatabaseSync(":memory:");
sq.exec(readFileSync(R + "/db/line.sql", "utf8"));
const db = { prepare(q) { const st = sq.prepare(q); let a = []; const o = {
  bind(...x) { a = x.map(v => v === undefined ? null : v); return o; },
  async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; },
  async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; return o; } };
const S = await import(R + "/lib/split.js");
let ok = 0, bad = 0; const t = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL", m); } };
const G = "Cgrp", now = Date.now();
const bill = (store, guests, hostess, shared, merge = {}) => {
  const d = { store, guests: guests.map((n, i) => ({ id: "g" + i, name: n })), hostess: hostess.map(([name, amount, gi], i) => ({ id: "h" + i, name, amount, guest: "g" + gi, lines: [] })), shared: shared.map(([name, amount]) => ({ id: "s" + name, name, amount })), merge, origin: "https://x.dev" };
  return { d, res: S.compute(d) };
};
const a = bill("香閣", ["王小明", "陳大華"], [["小美", 6000, 0], ["小花", 4000, 1]], [["包廂", 8000]]);
const b = bill("世盟", ["王小明", "陳大華", "林志明"], [["Coco", 3000, 2]], [["桌面", 6000]], { g2: "g0" });   // 林志明併給王小明
const ins = (id, x, created, cardAt) => sq.prepare("INSERT INTO line_splits(id,chat_id,status,data,result,created,done_at) VALUES(?,?,?,?,?,?,?)").run(id, G, "done", JSON.stringify({ ...x.d, cardAt }), JSON.stringify(x.res), created, created);
ins("b1", a, now - 15 * 60e3, now - 60e3);
ins("b2", b, now - 5 * 60e3, null);
sq.prepare("INSERT INTO line_kv VALUES('splittok:abcdefghijklmnopqrstuvwx', ?)").run(G);
sq.prepare("INSERT INTO line_kv VALUES(?, 'abcdefghijklmnopqrstuvwx')").run("splittok:" + G);
// 1. 同一批
const r2 = { ...sq.prepare("SELECT * FROM line_splits WHERE id='b2'").get() }; r2.d = JSON.parse(r2.data);
t((await S.batchOf(db, r2)).map(x => x.id).join() === "b1,b2", "batch");
// 2. 合併：同名加總、每家店分開、併給的人算在付錢的人身上
const c = S.combine(await S.batchOf(db, r2));
const wang = c.people.find(p => p.name === "王小明");
t(c.total === 27000 && wang.total === 10000 + 7000 && wang.stores.length === 2 && wang.stores[1].includes[0].name === "林志明", "combine " + JSON.stringify(c).slice(0, 300));
// 3. 最後一張貼的時候附上合併請款單（點名字連到合併明細）
const msgs = await S.combinedMessages(db, r2);
const card = JSON.stringify(msgs);
t(msgs.length === 1 && /合併請款單（2 張）/.test(card) && /香閣＋世盟/.test(card) && /\$27,000/.test(card) && /ids=b1,b2/.test(card) && /恩客NO\.1/.test(card), "combined card " + card.slice(0, 300));
// 4. 有一張還沒貼請款卡 → 先不附
sq.prepare("UPDATE line_splits SET data=? WHERE id='b1'").run(JSON.stringify({ ...a.d, cardAt: null }));
t(!(await S.combinedMessages(db, r2)).length, "wait until others posted");
// 5. 相隔太久（> 20 分）不算同一批
sq.prepare("UPDATE line_splits SET data=?, created=? WHERE id='b1'").run(JSON.stringify({ ...a.d, cardAt: now }), now - 60 * 60e3);
t(!(await S.combinedMessages(db, r2)).length, "far apart = separate");
// 6. 合併明細網頁：每個人每家店分開、小姐／公帳分開
sq.prepare("UPDATE line_splits SET created=? WHERE id='b1'").run(now - 15 * 60e3);
const page = await import(R + "/functions/split/index.js");
const html = await (await page.onRequestGet({ request: new Request("https://x.dev/split?t=abcdefghijklmnopqrstuvwx&ids=b1,b2&p=" + encodeURIComponent("王小明")), env: { DB: db } })).text();
t(/合併請款單（2 張）/.test(html) && /id="p-王小明" open/.test(html) && /class="store"><span>香閣/.test(html) && /class="store"><span>世盟/.test(html) && /林志明/.test(html) && /公帳分攤/.test(html), "combined page");
console.log(`${ok} passed, ${bad} failed`);
