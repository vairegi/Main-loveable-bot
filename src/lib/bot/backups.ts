// Backup mirroring — forwards raw database-channel posts to backup channels.
// Tracks per-channel mirror state in `backup_copies` so runs are incremental.

import type { SupabaseClient } from "@supabase/supabase-js";
import { copyMessage, forwardMessage, sendPhoto, sendVideo, sendDocument, sendAudio } from "./telegram";

async function getSettingText(db: SupabaseClient, key: string): Promise<string> {
  const { data } = await db.from("bot_settings").select("value").eq("key", key).maybeSingle();
  const v = (data?.value as { text?: string } | null) ?? null;
  return (v?.text ?? "").trim();
}

function appendExtra(base: string, extra: string): string {
  if (!extra) return base;
  if (!base) return extra;
  return `${base}\n\n${extra}`;
}

// Copy a message, falling back to forward when Telegram says it can't be copied
// (service messages, protected content, etc.).
async function copyOrForward(
  toChatId: number | string,
  fromChatId: number | string,
  messageId: number,
  extra: Record<string, unknown> = {},
): Promise<any> {
  try {
    return await copyMessage(toChatId, fromChatId, messageId, extra);
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (/can't be copied|can not be copied|cannot be copied/i.test(msg)) {
      return await forwardMessage(toChatId, fromChatId, messageId);
    }
    throw e;
  }
}

export interface BackupResult {
  mirrored: number;
  skipped: number;
  failed: number;
  firstError?: string;
}

function chatId(value: number | string): number | string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : value;
}

async function listBackupChannels(db: SupabaseClient): Promise<number[]> {
  const { data } = await db.from("channels").select("telegram_chat_id").eq("role", "backup");
  return (data ?? []).map((c) => Number(c.telegram_chat_id)).filter((n) => Number.isFinite(n));
}

// Return post ids already mirrored to a given backup channel
async function alreadyMirroredSet(db: SupabaseClient, backupChatId: number): Promise<Set<number>> {
  const { data } = await db
    .from("backup_copies")
    .select("post_id")
    .eq("backup_chat_id", backupChatId);
  return new Set((data ?? []).map((r) => Number(r.post_id)));
}

async function mirrorOne(
  db: SupabaseClient,
  post: any,
  backupChatId: number,
): Promise<{ ok: boolean; error?: string }> {
  const sourceChatId = post.source_chat_id;
  const sourceMessageId = post.source_message_id;
  if (!sourceChatId || !sourceMessageId) {
    return { ok: false, error: "post has no source_chat_id / source_message_id" };
  }

  const dest = chatId(backupChatId);
  const from = chatId(sourceChatId);
  const media = (post.media ?? {}) as { kind?: string; file_id?: string };
  const baseCaption = (post.caption ?? "") as string;
  const postExtra = await getSettingText(db, "post_caption_extra");
  const caption = appendExtra(baseCaption, postExtra);

  try {
    // Mirror the main message. If it's a photo/video with a stored file_id,
    // re-send it with has_spoiler so the backup channel gets a spoiler-covered
    // media. Otherwise fall back to copy/forward (with caption override when
    // an extra caption is configured).
    let main: any;
    if (media.kind === "photo" && media.file_id) {
      main = await sendPhoto(dest, media.file_id, { caption, has_spoiler: true });
    } else if (media.kind === "video" && media.file_id) {
      main = await sendVideo(dest, media.file_id, { caption, has_spoiler: true });
    } else {
      const copyExtra = postExtra ? { caption } : {};
      main = await copyOrForward(dest, from, Number(sourceMessageId), copyExtra);
    }

    // Mirror extra files (docs, etc.) — best effort. Backup channel is a
    // "posting" surface, so extras carry post_caption_extra (not file_caption_extra,
    // which is reserved for user-facing file delivery).
    const extras = Array.isArray(post.extra_files) ? post.extra_files : [];
    for (const [i, f] of extras.entries()) {
      const smid = f?.source_message_id ?? Number(sourceMessageId) + i + 1;
      const fCaption = postExtra;
      const fOpt: Record<string, unknown> = fCaption ? { caption: fCaption } : {};
      try {
        if (f?.kind === "photo" && f.file_id) {
          await sendPhoto(dest, f.file_id, { has_spoiler: true, ...fOpt });
        } else if (f?.kind === "video" && f.file_id) {
          await sendVideo(dest, f.file_id, { has_spoiler: true, ...fOpt });
        } else if (f?.kind === "document" && f.file_id) {
          await sendDocument(dest, f.file_id, fOpt);
        } else if (f?.kind === "audio" && f.file_id) {
          await sendAudio(dest, f.file_id, fOpt);
        } else if (smid) {
          await copyOrForward(dest, from, Number(smid), fOpt);
        }
      } catch (e) {
        console.error("backup extra failed:", e);
      }
    }

    await db.from("backup_copies").upsert(
      {
        post_id: post.id,
        backup_chat_id: backupChatId,
        backup_message_id: main?.message_id ?? null,
      },
      { onConflict: "post_id,backup_chat_id" },
    );

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "unknown error" };
  }
}

// Mirror stored posts to ONE backup channel.
// - `limit` caps how many NEW posts to mirror this call (default: unlimited, but
//   in practice capped by the caller to fit inside the Worker time budget).
// - `onProgress` fires after each post attempt with progress metrics.
// - Adds a small delay between posts to avoid Telegram flood control.
export async function backupAllToChannel(
  db: SupabaseClient,
  backupChatId: number,
  limit?: number,
  onProgress?: (p: {
    processed: number;
    mirrored: number;
    failed: number;
    totalToDo: number;
    totalAll: number;
    doneAll: number;
  }) => Promise<void> | void,
  delayMs = 300,
  maxFailedAttempts = 3,
): Promise<BackupResult & { totalAll: number; totalToDo: number; doneAll: number; skippedIds: number[] }> {
  const { data: posts } = await db
    .from("posts")
    .select("id, source_chat_id, source_message_id, extra_files, media, caption")
    .order("created_at", { ascending: true });

  const totalAll = posts?.length ?? 0;
  if (!posts?.length) {
    return { mirrored: 0, skipped: 0, failed: 0, totalAll: 0, totalToDo: 0, doneAll: 0, skippedIds: [] };
  }

  const done = await alreadyMirroredSet(db, backupChatId);
  const alreadyDone = done.size;

  // Load failure counts and treat posts that have already exhausted attempts
  // as "done" so they don't block the queue.
  const { data: failRows } = await db
    .from("backup_failures")
    .select("post_id, attempts")
    .eq("backup_chat_id", backupChatId);
  const failMap = new Map<number, number>(
    (failRows ?? []).map((r) => [Number(r.post_id), Number(r.attempts) ?? 0]),
  );
  const exhaustedIds = new Set<number>(
    Array.from(failMap.entries()).filter(([, n]) => n >= maxFailedAttempts).map(([id]) => id),
  );

  const pending = posts.filter(
    (p) => !done.has(Number(p.id)) && !exhaustedIds.has(Number(p.id)),
  );
  const totalToDo = pending.length;

  let mirrored = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | undefined;
  let processed = 0;
  const skippedIds: number[] = [];

  for (const p of pending) {
    if (typeof limit === "number" && processed >= limit) break;
    const r = await mirrorOne(db, p, backupChatId);
    processed++;
    if (r.ok) {
      mirrored++;
      // Clear any prior failure record on success.
      if (failMap.has(Number(p.id))) {
        await db.from("backup_failures").delete().eq("post_id", p.id).eq("backup_chat_id", backupChatId);
      }
    } else {
      failed++;
      if (!firstError) firstError = r.error;
      const prev = failMap.get(Number(p.id)) ?? 0;
      const attempts = prev + 1;
      failMap.set(Number(p.id), attempts);
      await db.from("backup_failures").upsert(
        {
          post_id: p.id,
          backup_chat_id: backupChatId,
          attempts,
          last_error: r.error ?? "unknown",
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "post_id,backup_chat_id" },
      );
      if (attempts >= maxFailedAttempts) {
        // Mark as processed in backup_copies so it's excluded from future pending sets.
        skippedIds.push(Number(p.id));
        await db.from("backup_copies").upsert(
          {
            post_id: p.id,
            backup_chat_id: backupChatId,
            backup_message_id: null,
          },
          { onConflict: "post_id,backup_chat_id" },
        );
      }
    }
    if (onProgress) {
      try {
        await onProgress({
          processed,
          mirrored,
          failed,
          totalToDo,
          totalAll,
          doneAll: alreadyDone + mirrored,
        });
      } catch { /* ignore progress errors */ }
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  skipped = alreadyDone;

  return {
    mirrored,
    skipped,
    failed,
    firstError,
    totalAll,
    totalToDo,
    doneAll: alreadyDone + mirrored + skippedIds.length,
    skippedIds,
  };
}


// Scan database for posts not yet mirrored to each backup channel,
// forward the missing ones to that channel.
export async function scanDatabaseToBackups(db: SupabaseClient): Promise<{
  channels: { chatId: number; result: BackupResult }[];
  totalChannels: number;
}> {
  const backups = await listBackupChannels(db);
  const results: { chatId: number; result: BackupResult }[] = [];
  for (const cid of backups) {
    const r = await backupAllToChannel(db, cid);
    results.push({ chatId: cid, result: r });
  }
  return { channels: results, totalChannels: backups.length };
}

// Clear the mirror-tracking table so /backup starts from post 1 again.
// If backupChatId is provided, only that channel is reset; otherwise all channels.
export async function resetBackupTracking(
  db: SupabaseClient,
  backupChatId?: number,
): Promise<{ cleared: number; error?: string }> {
  const q = db.from("backup_copies").delete({ count: "exact" });
  const { count, error } = backupChatId
    ? await q.eq("backup_chat_id", backupChatId)
    : await q.gte("id", 0);
  if (error) return { cleared: 0, error: error.message };
  return { cleared: count ?? 0 };
}

// Remove a backup channel registration (and its mirror-tracking rows).
export async function removeBackupChannel(
  db: SupabaseClient,
  backupChatId: number,
): Promise<{ removed: boolean; clearedCopies: number; error?: string }> {
  const { count: clearedCopies } = await db
    .from("backup_copies")
    .delete({ count: "exact" })
    .eq("backup_chat_id", backupChatId);
  const { error, count } = await db
    .from("channels")
    .delete({ count: "exact" })
    .eq("telegram_chat_id", backupChatId)
    .eq("role", "backup");
  if (error) return { removed: false, clearedCopies: clearedCopies ?? 0, error: error.message };
  return { removed: (count ?? 0) > 0, clearedCopies: clearedCopies ?? 0 };
}
