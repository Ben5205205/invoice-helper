// GET /split/v?s=<分享代碼>[&p=<付款人>] — 分享出去的請款單（只有這一張；沒有群組名稱、其他帳單、帳單照片）
//   沒有 p：整張單　有 p：只有這個人（和併給他的人）的那份
import { fmt, storeColor } from "../../lib/split.js";
import { esc, heroStyle, page, detail, combinedPage } from "./index.js";
import { load, loadMany } from "./share.js";

const OG = { "#6B3657": "xiangge", "#1E3A5F": "focus", "#7E2632": "shimeng", "#1D6A6E": "westin", "#7A4E1D": "weishideng" };
const ogHead = (u, store, title, desc) => `<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${u.origin}/og/split/${OG[storeColor(store).base] || "default"}.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="theme-color" content="${storeColor(store).base}">`;

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), s = u.searchParams.get("s") || "", pid = u.searchParams.get("p");
  // 合併請款單：?m=代碼1,代碼2（每張都是單張分享代碼）；有 p＝只看這個人的合計
  if (u.searchParams.get("m")) {
    const { rows, tok } = await loadMany(env, u.searchParams.get("m"));
    if (rows.length < 2) return page("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
    const title = rows.map(r => r.d.store || "帳單").join("＋");
    return page(`${pid ? pid + " 的" : ""}合併請款單｜${title}`, combinedPage(rows, "", pid, id => `/split/v?s=${tok[id]}`, pid), 200,
      ogHead(u, rows[0].d.store, `${pid ? pid + " 的" : ""}合併請款單｜${title}`, `${rows.length} 張單合計 $${fmt(rows.reduce((a, r) => a + r.res.total, 0))}`));
  }
  const r = await load(env, s);
  if (!r) return page("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  const { d, res } = r, title = [d.store, d.date].filter(Boolean).join(" ") || "帳單", c = storeColor(d.store);
  const payer = pid && res.payers.find(p => p.id === pid);
  if (!payer) return page(`請款單｜${title}`, detail(r, "", null, true), 200, ogHead(u, d.store, `${title} 請款單`, `現金總額 $${fmt(res.total)}｜${res.people.length} 人`));

  // 個人那份：小姐、公帳分攤各一段（有併給他的人，每人各一塊）
  const all = [payer.id, ...res.people.filter(x => (d.merge || {})[x.id] === payer.id).map(x => x.id)].map(id => res.people.find(x => x.id === id));
  const h = all.reduce((a, x) => a + x.hostess, 0), sh = all.reduce((a, x) => a + x.shared, 0);
  const top = res.payers.length > 1 ? Math.max(...res.payers.map(x => x.total)) : null, vip = top !== null && payer.total === top && top > 0;
  const rows = items => items.map(i => `<li><span>${esc(i.name.replace(/^小姐｜/, ""))}</span><span>${fmt(i.amount)}</span></li>`).join("");
  const block = p => {
    const hi = p.items.filter(i => i.name.startsWith("小姐｜")), si = p.items.filter(i => !i.name.startsWith("小姐｜"));
    return `${all.length > 1 ? `<div class="pp"><b>${esc(p.name)}</b><span>$${fmt(p.total)}</span></div>` : ""}
      ${hi.length ? `<div class="sec"><div class="sh"><span>小姐</span><span>${fmt(p.hostess)}</span></div><ul>${rows(hi)}</ul></div>` : ""}
      ${si.length ? `<div class="sec"><div class="sh"><span>公帳分攤</span><span>${fmt(p.shared)}</span></div><ul>${rows(si)}</ul></div>` : ""}`;
  };
  const css = `<style>
.me{font-size:34px;font-weight:800;font-variant-numeric:tabular-nums;margin-top:6px}.split2{display:flex;gap:18px;font-size:13px;margin-top:4px;color:var(--accent)}
.split2 b{color:#fff;font-weight:700;margin-left:4px}.vip{display:inline-block;font-size:11.5px;font-weight:800;color:#fff;background:#F28C28;border-radius:999px;padding:2px 10px;margin-bottom:8px}
.sec{padding:12px 0;border-bottom:1px solid var(--line)}.sec:last-child{border:0}.sh{display:flex;justify-content:space-between;font-weight:700;font-size:14px;color:${c.base}}
.sec ul{list-style:none;margin:6px 0 0;padding:0}.sec li{display:flex;justify-content:space-between;gap:10px;font-size:13.5px;color:var(--sub);padding:3px 0 3px 12px;font-variant-numeric:tabular-nums}
.pp{display:flex;justify-content:space-between;margin-top:12px;padding:8px 12px;border-radius:10px;background:${c.tint};color:${c.base}}
.foot{text-align:center;font-size:12px;color:var(--sub);margin-top:18px}
@media (prefers-color-scheme:dark){.sh{color:${c.accent}}.pp{background:rgba(255,255,255,.06);color:${c.accent}}}</style>`;
  return page(`${payer.name} 的請款單｜${title}`, `
    <header class="hero" style="${heroStyle(d.store)}"><span class="mark" aria-hidden="true">${esc(c.mark)}</span>
      ${vip ? '<div class="vip">👑 恩客NO.1 ✨</div>' : '<div class="kicker">請款單</div>'}<h1>${esc(payer.name)}</h1>
      <div class="meta light">${esc(title)}${d.bill_no ? "｜單號 " + esc(d.bill_no) : ""}</div>
      <div class="me">$${fmt(payer.total)}</div>
      <div class="split2"><span>小姐<b>${fmt(h)}</b></span><span>公帳分攤<b>${fmt(sh)}</b></span></div>
      ${d.payee && d.payee !== payer.name ? `<div class="payto">請轉給 <b>${esc(d.payee)}</b></div>` : ""}</header>
    <main><h2>明細</h2><section class="card">${all.map(block).join("")}</section>
      <div class="foot">整張單現金總額 $${fmt(res.total)}｜${res.people.length} 人分</div></main>`, 200,
    css + ogHead(u, d.store, `${payer.name} 的請款單｜${title}`, `$${fmt(payer.total)}（小姐 ${fmt(h)}＋公帳分攤 ${fmt(sh)}）`));
}
