import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { assertAdmin, errorResult } from "./_shared";

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
    if (!gate.ok) return errorResult(gate.msg);

    const n = limit ?? 10;
    const { data, error } = await gate.sb
      .from("posts")
      .select("id, caption, created_at, posted_at, source_chat_id, source_message_id")
      .order("id", { ascending: false })
      .limit(n);
    if (error) return errorResult(error.message);

    const rows = (data ?? []).map((p: any) => ({
      id: p.id,
      caption: (p.caption ?? "").slice(0, 200),
      created_at: p.created_at,
      posted_at: p.posted_at,
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
      structuredContent: { posts: rows },
    };
  },
});
