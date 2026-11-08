// GET /split?t=<群組代碼>[&id=<帳單>] — 拆帳紀錄網頁（只有拿到群組連結的人打得開）
import { kv } from "../../lib/assistant.js";
import { compute, fmt, combine, storeColor, storeColors } from "../../lib/split.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tw = ms => { const t = new Date(ms + 8 * 3600e3); return `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()}`; };

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), t = u.searchParams.get("t") || "", id = u.searchParams.get("id");
  const db = env.DB;
  const chatId = t.length >= 20 ? await kv.get(db, "splittok:" + t) : null;
  if (!chatId) return page("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  const group = (await kv.get(db, "name:" + chatId)) || "群組";
  // 合併請款單：好幾張單一起看，每個人每家店分開列
  const ids = (u.searchParams.get("ids") || "").split(",").filter(x => /^\w{2,20}$/.test(x)).slice(0, 8);
  if (ids.length > 1) {
    const rows = [];
    for (const x of ids) { const r = await db.prepare("SELECT * FROM line_splits WHERE id=? AND chat_id=? AND status='done'").bind(x, chatId).first(); if (r && r.result) rows.push({ ...r, d: JSON.parse(r.data || "{}"), res: JSON.parse(r.result) }); }
    if (rows.length < 2) return page("找不到", `<div class="empty">找不到這幾張帳單。</div>`, 404);
    return page(`合併請款單｜${group}`, combinedPage(rows, t, u.searchParams.get("p")));
  }
  if (id) {
    const r = await db.prepare("SELECT * FROM line_splits WHERE id=? AND chat_id=?").bind(id, chatId).first();
    if (!r) return page("找不到", `<div class="empty">找不到這張帳單。</div>`, 404);
    return page(`${r.status === "done" ? "請款單" : "拆帳中"}｜${group}`, detail(r, t, u.searchParams.get("p")));
  }
  const { results } = await db.prepare("SELECT id,status,data,result,created,done_at FROM line_splits WHERE chat_id=? AND status!='cancelled' ORDER BY created DESC LIMIT 200").bind(chatId).all();
  const sum = results.filter(r => r.status === "done").reduce((a, r) => a + (JSON.parse(r.result || "{}").total || 0), 0);
  const list = results.map(r => {
    const d = JSON.parse(r.data || "{}"), res = r.result ? JSON.parse(r.result) : null;
    return `<a class="bill" style="border-left:5px solid ${storeColor(d.store).base}" href="?t=${esc(t)}&id=${esc(r.id)}">
      <div class="bill-top"><div><div class="store">${esc(d.store || "帳單")}</div><div class="meta">${esc(d.date || tw(r.created))}${d.bill_no ? "｜" + esc(d.bill_no) : ""}</div></div>
      <div class="amt">$${fmt(res ? res.total : d.cash)}</div></div>
      ${res ? `<div class="chips">${res.payers.map(p => `<span class="chip">${esc(p.name)} <b>$${fmt(p.total)}</b></span>`).join("")}</div>` : `<div class="chips"><span class="chip pending">拆帳中</span></div>`}
    </a>`;
  }).join("");
  return page(`拆帳紀錄｜${group}`, `
    <header class="hero"><div class="kicker">拆帳紀錄</div><h1>${esc(group)}</h1>
      <div class="stats"><div><span>${results.filter(r => r.status === "done").length}</span>張帳單</div><div><span>$${fmt(sum)}</span>累計</div></div></header>
    <main>${list || `<div class="empty">還沒有拆過帳。</div>`}</main>`);
}

function detail(r, t, focus) {
  const d = JSON.parse(r.data || "{}"), res = r.result ? JSON.parse(r.result) : (d.guests?.length ? compute(d) : null);
  const nm = id => esc((d.guests || []).find(g => g.id === id)?.name || "未指定");
  const top = res && res.payers.length > 1 ? Math.max(...res.payers.map(x => x.total)) : null;
  const payers = res ? res.payers.map(p => {
    const person = res.people.find(x => x.id === p.id);
    const vip = top !== null && p.total === top && top > 0;
    return `<div class="payer${vip ? " no1" : ""}">${vip ? '<div class="badge">👑 恩客NO.1 ✨</div>' : ""}<div class="payer-top"><div class="pname">${esc(p.name)}</div><div class="pamt">$${fmt(p.total)}</div></div>
      <div class="psub">小姐 ${fmt(person.hostess)}｜公帳分攤 ${fmt(person.shared)}</div>
      ${p.includes.map(x => `<div class="inc">＋ 含 ${esc(x.name)} $${fmt(x.total)}</div>`).join("")}</div>`;
  }).join("") : "";
  // 每個人的明細：小姐、公帳分攤分開列，各有小計；從請款卡點進來的那個人（和併給他的人）直接打開、捲到那裡
  const opened = id => focus && (id === focus || (d.merge || {})[id] === focus);
  const block = (title, sum, items) => items.length ? `<li class="grp"><span>${title}</span><span>${fmt(sum)}</span></li>${items.map(i => `<li><span>${esc(i.name.replace(/^小姐｜/, ""))}</span><span>${fmt(i.amount)}</span></li>`).join("")}` : "";
  const people = res ? res.people.map(p => {
    const hi = p.items.filter(i => i.name.startsWith("小姐｜")), si = p.items.filter(i => !i.name.startsWith("小姐｜"));
    const to = (d.merge || {})[p.id];
    return `<details id="p-${esc(p.id)}"${opened(p.id) ? " open" : ""}${focus === p.id ? ' class="focus"' : ""}><summary><span>${esc(p.name)}${p.sex ? `<em>${esc(p.sex)}</em>` : ""}${to ? `<em>併給 ${nm(to)}</em>` : ""}</span><b>$${fmt(p.total)}</b></summary>
      <ul>${block("小姐", p.hostess, hi)}${block("公帳分攤", p.shared, si)}</ul></details>`;
  }).join("") : "";
  const hostess = (d.hostess || []).map(h => `<tr><td>${esc(h.name)}${h.mark ? `<small>${esc(h.mark)}</small>` : ""}<div class="lines">${h.lines.map(l => esc([l.type, l.time, l.units ? l.units + " 節" : ""].filter(Boolean).join(" "))).join("<br>")}</div></td><td>${h.split ? h.split.map(sg => (h.split.length > 1 ? sg.u + " 節：" : "") + sg.who.map(nm).join("、")).join("<br>") : nm(h.guest)}</td><td class="num">${fmt(h.amount)}</td></tr>`).join("");
  const shared = (d.shared || []).map(s => `<tr><td>${esc(s.name)}${s.qty > 1 ? `<small>${s.qty} × ${fmt(s.price)}</small>` : ""}</td><td>${s.who ? s.who.map(nm).join("、") : "全部平分"}</td><td class="num">${fmt(s.amount)}</td></tr>`).join("");
  const photos = [0, 1, 2, 3].map(n => `<a href="/split/img?t=${esc(t)}&id=${esc(r.id)}&n=${n}" target="_blank" class="ph" data-n="${n}"><img loading="lazy" src="/split/img?t=${esc(t)}&id=${esc(r.id)}&n=${n}" alt="帳單照片" onerror="this.parentNode.remove()"></a>`).join("");
  return `
    <header class="hero" style="background:${storeColor(d.store).base}"><a class="back" href="?t=${esc(t)}">‹ 所有帳單</a>
      <div class="kicker">${r.status === "done" ? "請款單" : "拆帳中"}</div><h1>${esc(d.store || "帳單")}</h1>
      <div class="meta light">${esc(d.date || tw(r.created))}${d.bill_no ? "｜單號 " + esc(d.bill_no) : ""}</div>
      <div class="total"><span>現金總額</span><b>$${fmt(d.cash)}</b></div>${d.card ? `<div class="meta light">刷卡價格 $${fmt(d.card)}</div>` : ""}${d.payee ? `<div class="payto">請轉給 <b>${esc(d.payee)}</b></div>` : ""}</header>
    <main>
      ${payers ? `<h2>請款</h2><section class="card">${payers}</section>` : ""}
      ${people ? `<h2>每個人的明細</h2><section class="card people">${people}</section>` : ""}
      <h2>小姐代支</h2><section class="card"><table><thead><tr><th>小姐</th><th>客人</th><th class="num">金額</th></tr></thead><tbody>${hostess}</tbody></table></section>
      <h2>公費</h2><section class="card"><table><thead><tr><th>項目</th><th>分攤</th><th class="num">金額</th></tr></thead><tbody>${shared}</tbody></table>
        ${(d.free || []).length ? `<div class="free">招待：${(d.free || []).map(esc).join("、")}</div>` : ""}</section>
      <h2>帳單照片</h2><section class="photos">${photos}</section>
    </main>`;
}

function combinedPage(bills, t, focus) {
  const c = combine(bills), pal = storeColors(bills.map(b => b.d.store || "帳單")), storeColor = n => pal[n || "帳單"] || pal[n];
  const people = c.people.map(p => {
    const vip = c.top !== null && p.total === c.top && c.top > 0;
    const stores = p.stores.map(s => {
      const b = bills.find(x => x.id === s.id), res = b.res, d = b.d;
      // 這家店裡他（和併給他的人）的每一筆，小姐和公帳分開
      const mine = res.people.filter(x => x.name === p.name || (d.merge || {})[x.id] === res.people.find(y => y.name === p.name)?.id);
      const items = mine.flatMap(x => x.items.map(i => ({ ...i, who: x.name !== p.name ? x.name : "" })));
      const hi = items.filter(i => i.name.startsWith("小姐｜")), si = items.filter(i => !i.name.startsWith("小姐｜"));
      const li = arr => arr.map(i => `<li><span>${esc(i.name.replace(/^小姐｜/, ""))}${i.who ? `<em>${esc(i.who)}</em>` : ""}</span><span>${fmt(i.amount)}</span></li>`).join("");
      const sc = storeColor(s.store);
      return `<li class="store" style="color:${sc.base};background:${sc.tint};border-left:4px solid ${sc.base}"><span>${esc(s.store)}<a href="?t=${esc(t)}&id=${esc(s.id)}">整張 ›</a></span><span>${fmt(s.total)}</span></li>
        ${hi.length ? `<li class="grp"><span>小姐</span><span>${fmt(s.hostess)}</span></li>${li(hi)}` : ""}
        ${si.length ? `<li class="grp"><span>公帳分攤</span><span>${fmt(s.shared)}</span></li>${li(si)}` : ""}`;
    }).join("");
    return `<details id="p-${esc(p.name)}"${focus === p.name ? ' open class="focus"' : ""}><summary><span>${vip ? '<i class="badge">👑 恩客NO.1 ✨</i>' : ""}${esc(p.name)}</span><b>$${fmt(p.total)}</b></summary><ul>${stores}</ul></details>`;
  }).join("");
  return `
    <header class="hero"><a class="back" href="?t=${esc(t)}">‹ 所有帳單</a>
      <div class="kicker">合併請款單（${bills.length} 張）</div><h1>${bills.map(b => esc(b.d.store || "帳單")).join("＋")}</h1>
      <div class="storechips">${bills.map(b => { const sc = storeColor(b.d.store); return `<span style="background:${sc.tint};color:${sc.base}">${esc(b.d.store || "帳單")} $${fmt(b.res.total)}</span>`; }).join("")}</div>
      <div class="total"><span>合計</span><b>$${fmt(c.total)}</b></div></header>
    <main><h2>每個人（點開看每家店）</h2><section class="card people">${people}</section></main>`;
}

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{--brand:#12524F;--soft:#EEF2F1;--ink:#1F2937;--sub:#6B7280;--line:#E5E7EB;--bg:#F6F8F7;--card:#FFFFFF;--accent:#F28C28}
@media (prefers-color-scheme:dark){:root{--soft:#1E2B2A;--ink:#E8EEED;--sub:#9AA8A6;--line:#2A3735;--bg:#0F1716;--card:#16201F}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;-webkit-font-smoothing:antialiased}
.hero{background:var(--brand);color:#fff;padding:22px 18px 26px;border-radius:0 0 22px 22px}
.hero h1{margin:2px 0 4px;font-size:24px;letter-spacing:.5px}.payto{margin-top:10px;display:inline-block;background:rgba(242,140,40,.18);color:#FFD9B0;border-radius:999px;padding:5px 12px;font-size:13.5px}.payto b{color:#fff}.kicker{font-size:12px;color:#CFE3E1;letter-spacing:1px}
.back{color:#CFE3E1;text-decoration:none;font-size:14px;display:inline-block;margin-bottom:10px}
.meta{font-size:13px;color:var(--sub)}.meta.light{color:#CFE3E1}
.total{display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.18)}
.total span{color:#CFE3E1;font-size:13px}.total b{font-size:30px;font-variant-numeric:tabular-nums}
.stats{display:flex;gap:22px;margin-top:14px;font-size:12px;color:#CFE3E1}.stats span{display:block;font-size:22px;font-weight:700;color:#fff}
main{max-width:640px;margin:0 auto;padding:6px 16px 40px}h2{font-size:13px;color:var(--sub);font-weight:600;margin:22px 4px 8px;letter-spacing:1px}
.card{background:var(--card);border-radius:16px;padding:6px 16px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.bill{display:block;background:var(--card);border-radius:16px;padding:16px;margin-top:12px;text-decoration:none;color:inherit;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.bill-top{display:flex;justify-content:space-between;gap:12px}.store{font-weight:700;font-size:16px}.amt{font-weight:700;font-size:18px;color:var(--brand);font-variant-numeric:tabular-nums}
@media (prefers-color-scheme:dark){.amt,.pamt{color:#6FC2B9!important}}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{background:var(--soft);border-radius:999px;padding:3px 10px;font-size:12.5px;color:var(--sub)}.chip b{color:var(--ink);font-weight:600}
.chip.pending{background:#FFF4E8;color:#B45309}
.payer{padding:14px 0;border-bottom:1px solid var(--line)}.payer:last-child{border:0}
.payer-top{display:flex;justify-content:space-between;align-items:baseline}.pname{font-weight:700;font-size:17px}.pamt{font-weight:800;font-size:21px;color:var(--brand);font-variant-numeric:tabular-nums}
.psub{font-size:12px;color:var(--sub)}.payer.no1{background:linear-gradient(135deg,#FFF6EA,#FFEBD3);border:1px solid #F6C48F;border-radius:14px;padding:12px 14px;margin:8px -6px}.payer.no1 .pname{color:#9A4A0B}.payer.no1 .pamt{color:#D9731A!important}.badge{display:inline-block;font-size:11.5px;font-weight:800;color:#fff;background:var(--accent);border-radius:999px;padding:2px 10px;margin-bottom:6px;letter-spacing:.5px;box-shadow:0 1px 3px rgba(242,140,40,.35)}@media (prefers-color-scheme:dark){.payer.no1{background:linear-gradient(135deg,#3A2A18,#2E2214);border-color:#7A5326}.payer.no1 .pname{color:#FFD9B0}}.inc{font-size:13px;color:var(--accent);margin-top:2px}
details{border-bottom:1px solid var(--line)}details:last-child{border:0}summary{display:flex;justify-content:space-between;padding:13px 0;cursor:pointer;list-style:none;font-weight:600}
summary::-webkit-details-marker{display:none}summary em{font-style:normal;font-size:12px;color:var(--sub);margin-left:6px;font-weight:400}
details ul{list-style:none;margin:0 0 12px;padding:0}details li{display:flex;justify-content:space-between;font-size:13.5px;color:var(--sub);padding:3px 0 3px 12px;gap:10px;font-variant-numeric:tabular-nums}
details li.store{padding:7px 10px;font-weight:700;font-size:14px;margin:10px 0 2px;border-radius:8px}.storechips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.storechips span{border-radius:999px;padding:3px 11px;font-size:13px;font-weight:700}details li.store a{margin-left:8px;font-size:12px;color:var(--accent);text-decoration:none;font-weight:600}details li em{font-style:normal;font-size:11px;color:var(--accent);margin-left:6px}summary .badge{font-style:normal;margin-right:6px;font-size:10.5px;padding:1px 8px;vertical-align:1px}details li.grp{padding:8px 0 2px;color:var(--ink);font-weight:600;font-size:13px}details.focus{background:var(--soft);margin:0 -16px;padding:0 16px;border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:14px}th{font-size:12px;color:var(--sub);font-weight:500;text-align:left;padding:10px 0 6px}
td{padding:10px 8px 10px 0;border-top:1px solid var(--line);vertical-align:top}.num{text-align:right;padding-right:0;font-variant-numeric:tabular-nums;white-space:nowrap}
td small{display:inline-block;margin-left:6px;font-size:11px;color:var(--sub)}.lines{font-size:11.5px;color:var(--sub);margin-top:2px}
.free{font-size:12.5px;color:var(--sub);padding:10px 0;border-top:1px solid var(--line)}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ph img{width:100%;border-radius:12px;display:block;background:var(--soft)}
.empty{text-align:center;color:var(--sub);padding:60px 0}
</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
