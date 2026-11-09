// GET /split/share?s=<分享代碼> — 請款卡「分享」按下去：選要分享整張單，還是只分享某個人的那份。
// GET /split/share?m=<代碼1,代碼2> — 合併請款單的「分享」：整份合併，或只分享某個人的合計
// 點下去直接打開 LINE 的分享畫面（選好友或群組），對方收到的連結只打得開這幾張單。
import { kv } from "../../lib/assistant.js";
import { fmt, storeColor, combine, loadShare, loadShareMany } from "../../lib/split.js";
import { esc, heroStyle, page } from "./index.js";

export const load = (env, s) => loadShare(env.DB, s);
export const loadMany = (env, m) => loadShareMany(env.DB, m);
const lineShare = text => "https://line.me/R/share?text=" + encodeURIComponent(text);

function picker({ store, kicker, title, sub, whole, people, wholeNote, q, liff }) {
  const c = storeColor(store);
  const css = `<style>
.opt{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;background:var(--card);border-radius:16px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.05);-webkit-tap-highlight-color:transparent;transition:transform .12s}
.opt:active{transform:scale(.98)}.opt.whole{margin-top:-28px;position:relative;border:1px solid ${c.tint}}
.opt .ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:${c.tint};color:${c.base};font-size:20px;flex:0 0 auto}
.opt .tx{flex:1}.opt .tx b{display:block;font-size:16px}.opt .tx span{font-size:12.5px;color:var(--sub)}
.opt .go{flex:0 0 auto;font-size:13px;font-weight:700;color:#fff;background:${c.base};border-radius:999px;padding:6px 14px}
.list{display:flex;flex-direction:column;gap:8px}.person{padding:13px 16px}.person .who{flex:1;font-weight:700;font-size:15.5px}.person .who em{display:block;font-style:normal;font-weight:400;font-size:12px;color:var(--sub)}
.person .amt{font-weight:700;font-variant-numeric:tabular-nums;color:${c.base}}.person .go{background:${c.tint};color:${c.base}}.crown{font-style:normal;margin-right:4px}
.note{text-align:center;font-size:12px;color:var(--sub);margin-top:22px}.hero{padding-bottom:46px}
@media (prefers-color-scheme:dark){.person .amt{color:${c.accent}}.opt .ic,.person .go{background:rgba(255,255,255,.08);color:${c.accent}}}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(17,24,39,.92);color:#fff;border-radius:999px;padding:9px 18px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}.toast.on{opacity:1}</style>`;
  const rows = people.map(p => `<a class="opt person" data-q="${esc(q + "&p=" + encodeURIComponent(p.pid))}" href="${esc(lineShare(p.text))}"><span class="who">${p.vip ? '<i class="crown">👑</i>' : ""}${esc(p.name)}${p.em ? `<em>${esc(p.em)}</em>` : ""}</span><span class="amt">$${fmt(p.total)}</span><span class="go">分享</span></a>`).join("");
  return page(`分享${kicker}｜${title}`, `
    <header class="hero" style="${heroStyle(store)}"><span class="mark" aria-hidden="true">${esc(c.mark)}</span>
      <div class="kicker">分享${esc(kicker)}</div><h1>${esc(title)}</h1>
      <div class="meta light">${esc(sub)}</div></header>
    <main>
      <a class="opt whole" data-q="${esc(q)}" href="${esc(lineShare(whole))}"><span class="ic">🧾</span><span class="tx"><b>${esc(wholeNote[0])}</b><span>${esc(wholeNote[1])}</span></span><span class="go">分享</span></a>
      <h2>只分享某個人的</h2><div class="list">${rows}</div>
      <div class="note" id="note">按「分享」會打開 LINE，選好友或群組就送出。<br>對方只看得到這${wholeNote[2]}。</div>
    </main><div class="toast" id="toast"></div>
    ${liff ? `<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <script>
    // 在 LINE 裡打開：按「分享」直接把卡片傳給選的好友／群組（LINE 的分享視窗）
    (async () => {
      const toast = t => { const e = document.getElementById("toast"); e.textContent = t; e.classList.add("on"); setTimeout(() => e.classList.remove("on"), 2200); };
      try { await liff.init({ liffId: ${JSON.stringify(liff)} }); } catch (e) { return; }
      if (!liff.isApiAvailable || !liff.isApiAvailable("shareTargetPicker")) return;
      document.getElementById("note").innerHTML = "按「分享」選好友或群組，就把卡片直接傳過去。<br>對方只看得到這${wholeNote[2]}。";
      document.querySelectorAll("a[data-q]").forEach(a => a.addEventListener("click", async ev => {
        ev.preventDefault();
        try {
          const r = await fetch("/split/card?" + a.dataset.q); const j = await r.json();
          if (!j.messages) throw new Error(j.error || "找不到卡片");
          const res = await liff.shareTargetPicker(j.messages, { isMultiple: true });
          if (res) toast("已傳送 ✓");
        } catch (e) { location.href = a.href; }
      }));
    })();
    </script>` : ""}`, 200, css);
}

export async function onRequestGet({ request, env }) {
  let u = new URL(request.url);
  // 從 liff.line.me 打開：第一次會把原本的 ?s=… 包在 liff.state 裡
  const st = u.searchParams.get("liff.state");
  if (st && !u.searchParams.get("s") && !u.searchParams.get("m")) { const q = new URLSearchParams(st.replace(/^[^?]*\?/, "")); for (const [k, v] of q) u.searchParams.set(k, v); }
  const s = u.searchParams.get("s") || "", liff = (await kv.get(env.DB, "liff:share")) || "";
  // 合併請款單
  if (u.searchParams.get("m")) {
    const { rows, m } = await loadMany(env, u.searchParams.get("m"));
    if (rows.length < 2) return page("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
    const c = combine(rows), title = rows.map(r => r.d.store || "帳單").join("＋"), base = `${u.origin}/split/v?m=${m}`;
    return picker({ q: "m=" + m, liff, store: rows[0].d.store, kicker: "合併請款單", title, sub: `${rows.length} 張單｜合計 $${fmt(c.total)}`,
      whole: `🧾 合併請款單｜${title}\n合計 $${fmt(c.total)}｜${c.people.length} 人\n${base}`, wholeNote: ["整份合併單", "每個人的合計和每家店的明細", "幾張單"],
      people: c.people.map(p => ({ pid: p.name, name: p.name, total: p.total, vip: c.top !== null && p.total === c.top && c.top > 0, em: p.stores.map(x => `${x.store} ${fmt(x.total)}`).join("、"),
        text: `🧾 ${p.name} 的合併請款單｜${title}\n$${fmt(p.total)}（${p.stores.map(x => `${x.store} ${fmt(x.total)}`).join("＋")}）\n${base}&p=${encodeURIComponent(p.name)}` })) });
  }
  const r = await load(env, s);
  if (!r) return page("找不到", `<div class="empty">連結不對或已失效。</div>`, 404);
  const { d, res } = r, title = [d.store, d.date].filter(Boolean).join(" ") || "帳單", base = `${u.origin}/split/v?s=${s}`;
  const top = res.payers.length > 1 ? Math.max(...res.payers.map(x => x.total)) : null;
  return picker({ q: "s=" + s, liff, store: d.store, kicker: "請款單", title: d.store || "帳單", sub: `${d.date ? d.date + "｜" : ""}現金總額 $${fmt(res.total)}`,
    whole: `🧾 ${title} 請款單\n現金總額 $${fmt(res.total)}｜${res.people.length} 人${d.payee ? "\n請轉給 " + d.payee : ""}\n${base}`, wholeNote: ["整張單", "所有人的金額和明細", "一張單"],
    people: res.payers.map(p => {
      const all = [p.id, ...res.people.filter(x => (d.merge || {})[x.id] === p.id).map(x => x.id)].map(id => res.people.find(x => x.id === id));
      const h = all.reduce((a, x) => a + x.hostess, 0), sh = all.reduce((a, x) => a + x.shared, 0);
      return { pid: p.id, name: p.name, total: p.total, vip: top !== null && p.total === top && top > 0, em: p.includes.length ? "含 " + p.includes.map(x => x.name).join("、") : "",
        text: `🧾 ${p.name} 的請款單｜${title}\n$${fmt(p.total)}（小姐 ${fmt(h)}＋公帳分攤 ${fmt(sh)}）${d.payee && d.payee !== p.name ? "\n請轉給 " + d.payee : ""}\n${base}&p=${encodeURIComponent(p.id)}` };
    }) });
}
