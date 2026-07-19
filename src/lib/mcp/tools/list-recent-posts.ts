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
  return { ok: true, sb };
}

export default defineTool({
  name: "list_recent_posts",
  title: "List recent posts",
  description: "List the most recent posts stored in the bot's database channel, newest first.",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("How many posts to return (1-50). Defaults to 10."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    const gate = await assertAdmin(ctx);
    if (!gate.ok) return { content: [{ type: "text", text: gate.msg }], isError: true };

    const n = limit ?? 10;
    const { data, error } = await gate.sb
      .from("posts")
      .select("id, caption, created_at, posted_at, source_chat_id, source_message_id")
      .order("id", { ascending: false })
      .limit(n);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };

    const rows = (data ?? []).map((p) => ({
      id: p.id,
      caption: (p.caption ?? "").slice(0, 200),
      created_at: p.created_at,
      posted_at: p.posted_at,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { posts: rows },
    };
  },
});
