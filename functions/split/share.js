// GET /split/share?s=<分享代碼> — 請款卡「分享」按下去：選要分享整張單，還是只分享某個人的那份。
// 點下去直接打開 LINE 的分享畫面（選好友或群組），對方收到的連結只打得開這一張單。
import { kv } from "../../lib/assistant.js";
import { fmt, storeColor } from "../../lib/split.js";
import { esc, heroStyle, page } from "./index.js";

export async function load(env, s) {
  const id = s && s.length >= 20 ? await kv.get(env.DB, "splitshr:" + s) : null;
  const r = id ? await env.DB.prepare("SELECT * FROM line_splits WHERE id=? AND status='done' AND result IS NOT NULL").bind(id).first() : null;
  return r ? { ...r, d: JSON.parse(r.data || "{}"), res: JSON.parse(r.result) } : null;
}
const lineShare = text => "https://line.me/R/share?text=" + encodeURIComponent(text);

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), s = u.searchParams.get("s") || "";
  const r = await load(env, s);
  if (!r) return page("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  const { d, res } = r, title = [d.store, d.date].filter(Boolean).join(" ") || "帳單";
  const base = `${u.origin}/split/v?s=${s}`, c = storeColor(d.store);
  const top = res.payers.length > 1 ? Math.max(...res.payers.map(x => x.total)) : null;
  const whole = lineShare(`🧾 ${title} 請款單\n現金總額 $${fmt(res.total)}｜${res.people.length} 人${d.payee ? "\n請轉給 " + d.payee : ""}\n${base}`);
  const people = res.payers.map(p => {
    const all = [p.id, ...res.people.filter(x => (d.merge || {})[x.id] === p.id).map(x => x.id)].map(id => res.people.find(x => x.id === id));
    const h = all.reduce((a, x) => a + x.hostess, 0), sh = all.reduce((a, x) => a + x.shared, 0);
    const txt = `🧾 ${p.name} 的請款單｜${title}\n$${fmt(p.total)}（小姐 ${fmt(h)}＋公帳分攤 ${fmt(sh)}）${d.payee && d.payee !== p.name ? "\n請轉給 " + d.payee : ""}\n${base}&p=${encodeURIComponent(p.id)}`;
    const vip = top !== null && p.total === top && top > 0;
    return `<a class="opt person" href="${esc(lineShare(txt))}"><span class="who">${vip ? '<i class="crown">👑</i>' : ""}${esc(p.name)}${p.includes.length ? `<em>含 ${p.includes.map(x => esc(x.name)).join("、")}</em>` : ""}</span><span class="amt">$${fmt(p.total)}</span><span class="go">分享</span></a>`;
  }).join("");
  const css = `<style>
.opt{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;background:var(--card);border-radius:16px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05);-webkit-tap-highlight-color:transparent;transition:transform .12s}
.opt:active{transform:scale(.98)}.opt.whole{margin-top:-28px;position:relative;border:1px solid ${c.tint}}
.opt .ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:${c.tint};color:${c.base};font-size:20px;flex:0 0 auto}
.opt .tx{flex:1}.opt .tx b{display:block;font-size:16px}.opt .tx span{font-size:12.5px;color:var(--sub)}
.opt .go{flex:0 0 auto;font-size:13px;font-weight:700;color:#fff;background:${c.base};border-radius:999px;padding:6px 14px}
.list{display:flex;flex-direction:column;gap:8px}.person{padding:13px 16px}.person .who{flex:1;font-weight:700;font-size:15.5px}.person .who em{display:block;font-style:normal;font-weight:400;font-size:12px;color:var(--sub)}
.person .amt{font-weight:700;font-variant-numeric:tabular-nums;color:${c.base}}.person .go{background:${c.tint};color:${c.base}}.crown{font-style:normal;margin-right:4px}
.note{text-align:center;font-size:12px;color:var(--sub);margin-top:22px}.hero{padding-bottom:46px}
@media (prefers-color-scheme:dark){.person .amt{color:${c.accent}}.opt .ic,.person .go{background:rgba(255,255,255,.08);color:${c.accent}}}</style>`;
  return page(`分享請款單｜${title}`, `
    <header class="hero" style="${heroStyle(d.store)}"><span class="mark" aria-hidden="true">${esc(c.mark)}</span>
      <div class="kicker">分享請款單</div><h1>${esc(d.store || "帳單")}</h1>
      <div class="meta light">${esc(d.date || "")}${d.date ? "｜" : ""}現金總額 $${fmt(res.total)}</div></header>
    <main>
      <a class="opt whole" href="${esc(whole)}"><span class="ic">🧾</span><span class="tx"><b>整張單</b><span>所有人的金額和明細</span></span><span class="go">分享</span></a>
      <h2>只分享某個人的</h2><div class="list">${people}</div>
      <div class="note">按「分享」會打開 LINE，選好友或群組就送出。<br>對方只看得到這一張單。</div>
    </main>`, 200, css);
}
