// Scheduled posts + scheduled broadcasts.
// Duration strings like "5h 2m", "10m", "2d 3h" -> milliseconds.
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractMedia, postByLink, repostByCode, type TgMedia } from "./posting";
import { sendPhoto, sendVideo, sendDocument, sendAudio, sendMessage } from "./telegram";

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDurationMs(input: string): number | null {
  if (!input) return null;
  const parts = input.trim().toLowerCase().match(/(\d+)\s*([smhd])/g);
  if (!parts) return null;
  let total = 0;
  for (const p of parts) {
    const m = p.match(/(\d+)\s*([smhd])/);
    if (!m) return null;
    total += Number(m[1]) * UNIT_MS[m[2]];
  }
  return total > 0 ? total : null;
}

export function formatDurationMs(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ") || `${s}s`;
}

// Schedule an existing post by code (or a t.me link that maps to a stored post).
export async function schedulePostByCode(
  db: SupabaseClient,
  scheduledFor: Date,
  code: string,
  createdBy: number,
): Promise<{ id: number }> {
  const { data, error } = await db
    .from("scheduled_posts")
    .insert({
      kind: "code",
      post_code: code,
      scheduled_for: scheduledFor.toISOString(),
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "insert failed");
  return { id: data.id as number };
}

// Schedule a one-shot post captured from a replied-to media message.
export async function scheduleOneshotFromMessage(
  db: SupabaseClient,
  scheduledFor: Date,
  repliedMsg: any,
  createdBy: number,
): Promise<{ id: number } | null> {
  const media = extractMedia(repliedMsg);
  if (media.kind === "text") return null;
  const { data, error } = await db
    .from("scheduled_posts")
    .insert({
      kind: "oneshot",
      media,
      caption: repliedMsg.caption ?? repliedMsg.text ?? null,
      scheduled_for: scheduledFor.toISOString(),
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "insert failed");
  return { id: data.id as number };
}

export async function listPendingScheduled(db: SupabaseClient, limit = 20) {
  const { data } = await db
    .from("scheduled_posts")
    .select("id, scheduled_for, kind, post_code, caption, status")
    .eq("status", "pending")
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  return data ?? [];
}

export async function cancelScheduled(db: SupabaseClient, id: number): Promise<boolean> {
  const { error } = await db
    .from("scheduled_posts")
    .update({ status: "cancelled", processed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");
  return !error;
}

async function publishOneshotToMainChannels(db: SupabaseClient, media: TgMedia, caption: string | null): Promise<number> {
  const { data: mains } = await db.from("channels").select("telegram_chat_id").eq("role", "main");
  let sent = 0;
  const cap = caption ? { caption } : {};
  for (const ch of mains ?? []) {
    const chatId = Number(ch.telegram_chat_id);
    try {
      if (media.kind === "photo" && media.file_id) await sendPhoto(chatId, media.file_id, cap);
      else if (media.kind === "video" && media.file_id) await sendVideo(chatId, media.file_id, cap);
      else if (media.kind === "document" && media.file_id) await sendDocument(chatId, media.file_id, cap);
      else if (media.kind === "audio" && media.file_id) await sendAudio(chatId, media.file_id, cap);
      else if (caption) await sendMessage(chatId, caption);
      sent++;
    } catch (e) {
      console.error("oneshot publish failed", chatId, e);
    }
  }
  return sent;
}

// Called by the drip cron each tick. Publishes any scheduled_posts whose time has arrived.
export async function processDueScheduledPosts(db: SupabaseClient, batch = 5): Promise<{ processed: number }> {
  const nowIso = new Date().toISOString();
  const { data: due } = await db
    .from("scheduled_posts")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(batch);
  let processed = 0;
  for (const row of due ?? []) {
    try {
      if (row.kind === "code" && row.post_code) {
        await repostByCode(db, row.post_code);
      } else if (row.kind === "oneshot") {
        await publishOneshotToMainChannels(db, (row.media as TgMedia) ?? { kind: "text" }, row.caption);
      }
      await db
        .from("scheduled_posts")
        .update({ status: "done", processed_at: new Date().toISOString() })
        .eq("id", row.id);
      processed++;
    } catch (e: any) {
      await db
        .from("scheduled_posts")
        .update({ status: "failed", last_error: String(e?.message ?? e).slice(0, 500), processed_at: new Date().toISOString() })
        .eq("id", row.id);
    }
  }
  return { processed };
}

// -------- Scheduled broadcasts --------
export async function promoteDueScheduledBroadcasts(db: SupabaseClient): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: due } = await db
    .from("broadcast_jobs")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .limit(20);
  if (!due?.length) return 0;
  const ids = due.map((r) => r.id);
  await db.from("broadcast_jobs").update({ status: "pending" }).in("id", ids);
  return ids.length;
}

// re-export for commands.ts convenience
export { postByLink };
