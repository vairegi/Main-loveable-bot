// Server functions for the /admin web page — all gated by requireSupabaseAuth
// plus a has_role('admin') check.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function requireAdmin(context: any) {
  const { data: isAdmin, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!isAdmin) throw new Error("Forbidden — you are not linked to a Telegram admin account.");
}

export const consumeLinkToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { token: string }) => data)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("telegram_link_tokens")
      .select("token, telegram_user_id, expires_at, consumed_at")
      .eq("token", data.token)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!row) return { ok: false as const, reason: "Token not found" };
    if (row.consumed_at) return { ok: false as const, reason: "Token already used" };
    if (new Date(row.expires_at) < new Date()) return { ok: false as const, reason: "Token expired" };

    // Confirm the Telegram user is actually an admin
    const { data: adm } = await supabaseAdmin
      .from("admins")
      .select("telegram_user_id")
      .eq("telegram_user_id", row.telegram_user_id)
      .maybeSingle();
    if (!adm) return { ok: false as const, reason: "Telegram user is no longer an admin" };

    // Upsert link + consume token
    await supabaseAdmin.from("telegram_web_links").upsert({
      auth_user_id: context.userId,
      telegram_user_id: row.telegram_user_id,
    });
    await supabaseAdmin
      .from("telegram_link_tokens")
      .update({ consumed_at: new Date().toISOString() })
      .eq("token", data.token);

    return { ok: true as const, telegramUserId: row.telegram_user_id };
  });

export const getAdminDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [users, posts, activity, failures, audit] = await Promise.all([
      supabaseAdmin.from("bot_users").select("telegram_user_id, username, first_name, fetch_count, last_seen, banned").order("last_seen", { ascending: false }).limit(50),
      supabaseAdmin.from("posts").select("id, code, caption, fetch_count, created_at").order("created_at", { ascending: false }).limit(50),
      supabaseAdmin.from("activity_log").select("id, actor_id, actor_username, action, details, created_at").order("created_at", { ascending: false }).limit(50),
      supabaseAdmin.from("backup_failures").select("id, post_id, backup_chat_id, attempts, last_error, updated_at").order("updated_at", { ascending: false }).limit(50),
      supabaseAdmin.from("admin_audit").select("id, admin_id, admin_username, action, target, details, created_at").order("created_at", { ascending: false }).limit(50),
    ]);

    return {
      users: users.data ?? [],
      posts: posts.data ?? [],
      activity: activity.data ?? [],
      failures: failures.data ?? [],
      audit: audit.data ?? [],
    };
  });

export const checkAdminAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    const { data: link } = await context.supabase
      .from("telegram_web_links")
      .select("telegram_user_id")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    return { isAdmin: !!isAdmin, telegramUserId: link?.telegram_user_id ?? null };
  });
