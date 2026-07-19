import { defineTool } from "@lovable.dev/mcp-js";
import { assertAdmin, errorResult } from "./_shared";

export default defineTool({
  name: "get_bot_stats",
  title: "Get bot stats",
  description: "Return high-level counts for the Telegram bot: total posts, tracked users, banned users, and admins.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    const gate = await assertAdmin(ctx);
    if (!gate.ok) return errorResult(gate.msg);

    const [posts, users, banned, admins] = await Promise.all([
      gate.sb.from("posts").select("*", { count: "exact", head: true }),
      gate.sb.from("bot_users").select("*", { count: "exact", head: true }),
      gate.sb.from("bot_users").select("*", { count: "exact", head: true }).eq("banned", true),
      gate.sb.from("admins").select("*", { count: "exact", head: true }),
    ]);

    const stats = {
      total_posts: posts.count ?? 0,
      total_users: users.count ?? 0,
      banned_users: banned.count ?? 0,
      admins: admins.count ?? 0,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      structuredContent: stats,
    };
  },
});
