import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { assertAdmin, errorResult } from "./_shared";

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
    if (!gate.ok) return errorResult(gate.msg);

    const n = limit ?? 10;
    const escaped = query.replace(/[%_]/g, (m) => `\\${m}`);
    const { data, error } = await gate.sb
      .from("posts")
      .select("id, caption, created_at, posted_at")
      .ilike("caption", `%${escaped}%`)
      .order("id", { ascending: false })
      .limit(n);
    if (error) return errorResult(error.message);

    const rows = (data ?? []).map((p: any) => ({
      id: p.id,
      caption: (p.caption ?? "").slice(0, 300),
      created_at: p.created_at,
      posted_at: p.posted_at,
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
      structuredContent: { matches: rows, query },
    };
  },
});
