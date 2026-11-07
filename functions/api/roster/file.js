// POST /api/roster/file?id=&name= — GitHub Actions 上傳排好的 PDF，存雲端硬碟
import { verifyRunner, saveRosterFile } from "../../../lib/roster.js";
export async function onRequestPost({ request, env }) {
  if (!(await verifyRunner(env, request).catch(() => null))) return new Response("forbidden", { status: 403 });
  const u = new URL(request.url), id = u.searchParams.get("id") || "", name = (u.searchParams.get("name") || "名冊.pdf").slice(0, 120);
  const job = await env.DB.prepare("SELECT * FROM line_roster_jobs WHERE id=? AND status='running'").bind(id).first();
  if (!job) return new Response("not found", { status: 404 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024 || String.fromCharCode(...bytes.subarray(0, 4)) !== "%PDF") return new Response("bad file", { status: 400 });
  return Response.json(await saveRosterFile(env, env.DB, job, name, bytes, u.origin));
}
