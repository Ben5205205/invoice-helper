import { currentUser } from "../../lib/auth.js";
// Read-only migration checks. No message sending, model generation, or account changes.
export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env.DB);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (user?.email?.toLowerCase() !== "benwu0317@gmail.com") return reply({ error: "Forbidden" }, 403);
  async function inspect(url, headers, select) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      const b = await r.json().catch(() => ({}));
      return { status: r.status, ...(r.ok ? select(b, r) : {}) };
    } catch { return { status: "unavailable" }; }
  }
  const gh = { authorization: "Bearer " + env.GH_DISPATCH_TOKEN, accept: "application/vnd.github+json", "user-agent": "taxtools-migration-check" };
  const [github, workflow, openai, anthropic] = await Promise.all([
    inspect("https://api.github.com/user", gh, b => ({ login: b.login })),
    inspect("https://api.github.com/repos/Ben5205205/invoice-helper/actions/workflows/roster.yml", gh, b => ({ state: b.state, path: b.path })),
    inspect("https://api.openai.com/v1/models", { authorization: "Bearer " + env.OPENAI_API_KEY }, (b, r) => ({ organization: r.headers.get("openai-organization"), keyEnding: String(env.OPENAI_API_KEY || "").slice(-4) })),
    inspect("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, () => ({ keyEnding: String(env.ANTHROPIC_API_KEY || "").slice(-4) }))
  ]);
  return reply({ github, workflow, openai, anthropic });
}
