import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";

export function supabaseForUser(ctx: ToolContext): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AdminGate =
  | { ok: false; msg: string }
  | { ok: true; sb: SupabaseClient };

export async function assertAdmin(ctx: ToolContext): Promise<AdminGate> {
  if (!ctx.isAuthenticated()) return { ok: false, msg: "Not authenticated." };
  const sb = supabaseForUser(ctx);
  const { data, error } = await sb.rpc("has_role", { _user_id: ctx.getUserId(), _role: "admin" });
  if (error) return { ok: false, msg: `Role check failed: ${error.message}` };
  if (!data) return { ok: false, msg: "Admin role required." };
  return { ok: true, sb };
}

export function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}
