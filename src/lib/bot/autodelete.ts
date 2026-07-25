// Auto-delete: queue bot-sent messages to be removed after a delay.
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteMessage } from "./telegram";

export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s || s === "off" || s === "0") return 0;
  const m = s.match(/^(\d+)([hmd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2];
  if (unit === "m") return n * 60;
  if (unit === "h") return n * 3600;
  if (unit === "d") return n * 86400;
  return null;
}

export function formatDuration(seconds: number): string {
  if (!seconds) return "off";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export async function getAutodeleteSeconds(db: SupabaseClient): Promise<number> {
  const { data } = await db.from("bot_settings").select("value").eq("key", "autodelete_seconds").maybeSingle();
  const v = (data?.value as { seconds?: number } | null)?.seconds;
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0;
}

export async function setAutodeleteSeconds(db: SupabaseClient, seconds: number): Promise<void> {
  await db.from("bot_settings").upsert({
    key: "autodelete_seconds",
    value: { seconds },
    updated_at: new Date().toISOString(),
  });
}

export async function getCommandAutodeleteSeconds(db: SupabaseClient): Promise<number> {
  const { data } = await db.from("bot_settings").select("value").eq("key", "command_autodelete_seconds").maybeSingle();
  const v = (data?.value as { seconds?: number } | null)?.seconds;
  if (v === undefined || v === null) return 120; // default 2 minutes
  return Number.isFinite(v) && (v as number) >= 0 ? (v as number) : 120;
}

export async function setCommandAutodeleteSeconds(db: SupabaseClient, seconds: number): Promise<void> {
  await db.from("bot_settings").upsert({
    key: "command_autodelete_seconds",
    value: { seconds },
    updated_at: new Date().toISOString(),
  });
}

export async function queueDeletion(
  db: SupabaseClient,
  chatId: number | string,
  messageIds: number[],
  seconds: number,
): Promise<void> {
  if (!seconds || !messageIds.length) return;
  const deleteAt = new Date(Date.now() + seconds * 1000).toISOString();
  const rows = messageIds
    .filter((id) => Number.isFinite(id))
    .map((id) => ({ chat_id: Number(chatId), message_id: id, delete_at: deleteAt }));
  if (!rows.length) return;
  await db.from("pending_deletions").insert(rows);
}

export async function processPendingDeletions(db: SupabaseClient, limit = 2000): Promise<{ deleted: number; failed: number }> {
  const { data } = await db
    .from("pending_deletions")
    .select("id, chat_id, message_id")
    .lte("delete_at", new Date().toISOString())
    .order("delete_at", { ascending: true })
    .limit(limit);
  if (!data?.length) return { deleted: 0, failed: 0 };
  let deleted = 0;
  let failed = 0;
  const done: number[] = [];
  const CONCURRENCY = 25;
  for (let i = 0; i < data.length; i += CONCURRENCY) {
    const chunk = data.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (row) => {
        try {
          await deleteMessage(row.chat_id as number, row.message_id as number);
          deleted++;
        } catch {
          failed++;
        }
        done.push(row.id as number);
      }),
    );
  }
  if (done.length) {
    // Delete in batches to keep the IN() list manageable
    for (let i = 0; i < done.length; i += 500) {
      await db.from("pending_deletions").delete().in("id", done.slice(i, i + 500));
    }
  }
  return { deleted, failed };
}

