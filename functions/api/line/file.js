// GET /api/line/file?id=<存檔>&s=<簽章> — 把存檔的照片／檔案傳給 LINE 顯示（網址有簽章，猜不到）
import { checkSig } from "../../../lib/vault.js";
import { gas } from "../../../lib/books.js";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), id = u.searchParams.get("id") || "";
  if (!(await checkSig(env, id, u.searchParams.get("s") || ""))) return new Response("not found", { status: 404 });
  const r = await env.DB.prepare("SELECT name,mime,drive_id,data FROM line_files WHERE id=?").bind(id).first();
  if (!r) return new Response("not found", { status: 404 });
  let bytes = r.data ? new Uint8Array(r.data) : null, mime = r.mime || "application/octet-stream";
  if (!bytes && r.drive_id) {
    try {
      const f = await gas(env, "readFile", r.drive_id, false);
      if (f.kind === "blob") { const bin = atob(f.data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); mime = f.mime || mime; }
    } catch (e) { console.log("vault read", e.message); }
  }
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(bytes, { headers: { "content-type": mime, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(r.name || "file")}`, "cache-control": "private, max-age=86400" } });
}
