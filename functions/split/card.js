// GET /split/card?s=<分享代碼>[&p=付款人] 或 ?m=<代碼1,代碼2>[&p=名字] — 分享用的卡片（LINE 訊息格式）
// LINE 內嵌視窗拿去用「分享給好友」直接傳卡片；卡片上只有網址按鈕，連到公開的單張頁面。
import { shareCardsFor } from "../../lib/split.js";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const messages = await shareCardsFor(env, u.origin, u.searchParams).catch(e => { console.log("share card", e.message); return null; });
  if (!messages) return new Response(JSON.stringify({ error: "找不到這張單" }), { status: 404, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ messages }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
