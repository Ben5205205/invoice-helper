// GET /api/roster/job?id= — GitHub Actions（OIDC 驗證）拿一次名冊工作：排好順序、刪好名字的各方案名單
import { verifyRunner, applyConfig } from "../../../lib/roster.js";
export async function onRequestGet({ request, env }) {
  if (!(await verifyRunner(env, request).catch(() => null))) return new Response("forbidden", { status: 403 });
  const id = new URL(request.url).searchParams.get("id") || "";
  const r = await env.DB.prepare("UPDATE line_roster_jobs SET status='running', updated=? WHERE id=? AND status='queued'").bind(Date.now(), id).run();
  if (!r.meta?.changes) return new Response("not found", { status: 404 });   // 只能拿一次
  const job = await env.DB.prepare("SELECT * FROM line_roster_jobs WHERE id=?").bind(id).first();
  const cfg = JSON.parse(job.config), { plans } = applyConfig(JSON.parse(job.plans), cfg);
  return Response.json({ title: cfg.title || job.tab, plans, split: cfg.split || null });
}
