// Warning system: 3 active warnings → auto-ban.
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage } from "./telegram";
import { banUser } from "./users";

export const WARN_LIMIT = 3;

export async function addWarning(
  db: SupabaseClient,
  targetId: number,
  adminId: number,
  reason: string | null,
): Promise<{ count: number; banned: boolean; error?: string }> {
  const { error } = await db.from("warnings").insert({
    user_id: targetId,
    admin_id: adminId,
    reason: reason ?? null,
  });
  if (error) return { count: 0, banned: false, error: error.message };

  const { count } = await db
    .from("warnings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", targetId);
  const total = count ?? 0;

  let banned = false;
  if (total >= WARN_LIMIT) {
    const r = await banUser(db, targetId, `Auto-ban: reached ${WARN_LIMIT} warnings`);
    if (!r.error) banned = true;
  }

  try {
    if (banned) {
      await sendMessage(targetId, `🚫 You have been <b>banned</b> after receiving ${WARN_LIMIT} warnings.`);
    } else {
      await sendMessage(
        targetId,
        `⚠️ <b>Warning ${total}/${WARN_LIMIT}</b>${reason ? `\nReason: ${reason}` : ""}\nOne more warning may result in a ban.`,
      );
    }
  } catch { /* user may have blocked bot */ }

  return { count: total, banned };
}

export async function clearWarnings(db: SupabaseClient, targetId: number): Promise<number> {
  const { count } = await db
    .from("warnings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", targetId);
  await db.from("warnings").delete().eq("user_id", targetId);
  return count ?? 0;
}

export async function listWarnings(db: SupabaseClient, targetId: number) {
  const { data } = await db
    .from("warnings")
    .select("id, admin_id, reason, created_at")
    .eq("user_id", targetId)
    .order("created_at", { ascending: false });
  return data ?? [];
}
