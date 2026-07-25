// Persistent admin audit log — separate from activity_log so it stays clean.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TgUser } from "./commands";

export async function writeAudit(
  db: SupabaseClient,
  admin: TgUser,
  action: string,
  target: string | null,
  details?: unknown,
): Promise<void> {
  try {
    await db.from("admin_audit").insert({
      admin_id: admin.id,
      admin_username: admin.username ?? null,
      action,
      target: target ?? null,
      details: details ?? null,
    });
  } catch (e) {
    console.error("writeAudit failed:", e);
  }
}

export async function listAudit(db: SupabaseClient, limit = 20) {
  const { data } = await db
    .from("admin_audit")
    .select("id, admin_id, admin_username, action, target, details, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}
