import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function assertAdmin(ctx: ToolContext) {
  if (!ctx.isAuthenticated()) return { ok: false, msg: "Not authenticated." };
  const sb = supabaseForUser(ctx);
  const { data, error } = await sb.rpc("has_role", { _user_id: ctx.getUserId(), _role: "admin" });
  if (error) return { ok: false, msg: `Role check failed: ${error.message}` };
  if (!data) return { ok: false, msg: "Admin role required." };
  return { ok: true as const, sb };
}

export default defineTool({
  name: "get_bot_stats",
  title: "Get bot stats",
  description: "Return high-level counts for the Telegram bot: total posts, tracked users, banned users, and admins.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    const gate = await assertAdmin(ctx);
    if (!gate.ok) return { content: [{ type: "text", text: gate.msg }], isError: true };
    const sb = gate.sb;

    const [posts, users, banned, admins] = await Promise.all([
      sb.from("posts").select("*", { count: "exact", head: true }),
      sb.from("bot_users").select("*", { count: "exact", head: true }),
      sb.from("bot_users").select("*", { count: "exact", head: true }).eq("banned", true),
      sb.from("admins").select("*", { count: "exact", head: true }),
    ]);

    const stats = {
      total_posts: posts.count ?? 0,
      total_users: users.count ?? 0,
      banned_users: banned.count ?? 0,
      admins: admins.count ?? 0,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
      structuredContent: stats,
    };
  },
});
