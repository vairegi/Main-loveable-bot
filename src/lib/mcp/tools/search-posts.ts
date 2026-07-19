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
  return { ok: true as const, sb: sb! };
}

export default defineTool({
  name: "search_posts",
  title: "Search posts by caption",
  description: "Find posts whose caption contains the given text (case-insensitive).",
  inputSchema: {
    query: z.string().trim().min(1).describe("Text to search inside the post caption."),
    limit: z.number().int().min(1).max(50).optional().describe("Max rows to return (1-50). Defaults to 10."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, limit }, ctx) => {
    const gate = await assertAdmin(ctx);
    if (!gate.ok) return { content: [{ type: "text", text: gate.msg }], isError: true };

    const n = limit ?? 10;
    const escaped = query.replace(/[%_]/g, (m) => `\\${m}`);
    const { data, error } = await gate.sb
      .from("posts")
      .select("id, caption, created_at, posted_at")
      .ilike("caption", `%${escaped}%`)
      .order("id", { ascending: false })
      .limit(n);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };

    const rows = (data ?? []).map((p) => ({
      id: p.id,
      caption: (p.caption ?? "").slice(0, 300),
      created_at: p.created_at,
      posted_at: p.posted_at,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      structuredContent: { matches: rows, query },
    };
  },
});
