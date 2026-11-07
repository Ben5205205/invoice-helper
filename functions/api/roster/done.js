// POST /api/roster/done?id= — GitHub Actions 回報做好（或失敗），推播下載卡到群組
import { verifyRunner, finishRoster } from "../../../lib/roster.js";
import { lineClient } from "../../../lib/line.js";
export async function onRequestPost({ request, env }) {
  if (!(await verifyRunner(env, request).catch(() => null))) return new Response("forbidden", { status: 403 });
  const id = new URL(request.url).searchParams.get("id") || "";
  const job = await env.DB.prepare("SELECT * FROM line_roster_jobs WHERE id=? AND status='running'").bind(id).first();
  if (!job) return new Response("not found", { status: 404 });
  await finishRoster(env, env.DB, lineClient(env.LINE_CHANNEL_TOKEN), job, await request.json());
  return Response.json({ ok: true });
}
