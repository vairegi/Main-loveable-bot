// Backup mirroring — forwards raw database-channel posts to backup channels.
// Tracks per-channel mirror state in `backup_copies` so runs are incremental.

import type { SupabaseClient } from "@supabase/supabase-js";
import { copyMessage, forwardMessage, sendPhoto, sendVideo, sendDocument, sendAudio, deleteMessage } from "./telegram";
import { getSettingText } from "./settings";


function appendExtra(base: string, extra: string): string {
  if (!extra) return base;
  if (!base) return extra;
  // Skip if base already contains this exact extra text (avoid duplicates
  // when a post's stored caption was captured with the extra already inline).
  if (base.includes(extra.trim())) return base;
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
  const fileExtra = await getSettingText(db, "file_caption_extra");
  const { getPostPosition } = await import("./posting");
  const position = await getPostPosition(db, post);
  const caption = `#${position}\n\n${appendExtra(baseCaption, postExtra)}`.trim();

  try {
    // Mirror the main message. If it's a photo/video with a stored file_id,
    // re-send it with has_spoiler so the backup channel gets a spoiler-covered
    // media. Otherwise fall back to copy/forward (with caption override so the
    // position tag is preserved).
    let main: any;
    if (media.kind === "photo" && media.file_id) {
      main = await sendPhoto(dest, media.file_id, { caption, has_spoiler: true });
    } else if (media.kind === "video" && media.file_id) {
      main = await sendVideo(dest, media.file_id, { caption, has_spoiler: true });
    } else {
      main = await copyOrForward(dest, from, Number(sourceMessageId), { caption });
    }

    // Mirror extra files (docs, etc.) — best effort. Extra files carry the
    // /filecaption text (they're files, not posts), matching user-facing
    // delivery behavior.
    const extras = Array.isArray(post.extra_files) ? post.extra_files : [];
    for (const [i, f] of extras.entries()) {
      const smid = f?.source_message_id ?? Number(sourceMessageId) + i + 1;
      const fCaption = fileExtra;
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
// Mirror stored posts to ONE backup channel.
// - `limit` caps how many NEW posts to mirror this call (default: unlimited, but
//   in practice capped by the caller to fit inside the Worker time budget).
// - `onProgress` fires after each post attempt with progress metrics.
// - Adds a small delay between posts to avoid Telegram flood control.
//
// Keyset pagination: instead of loading ALL posts up front (slow + memory-heavy
// once the table grows past a few thousand rows), we scan in chunks of
// `CHUNK_SIZE` using `WHERE id > lastId ORDER BY id`. The mirrored / failure
// maps are still loaded once because they are small (bounded by this channel's
// activity), and we consult them in-memory per chunk.
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
  const CHUNK_SIZE = 500;

  // Total post count (cheap head query — no rows returned).
  const { count: totalAllRaw } = await db
    .from("posts")
    .select("id", { count: "exact", head: true });
  const totalAll = totalAllRaw ?? 0;

  if (totalAll === 0) {
    return { mirrored: 0, skipped: 0, failed: 0, totalAll: 0, totalToDo: 0, doneAll: 0, skippedIds: [] };
  }

  const done = await alreadyMirroredSet(db, backupChatId);
  const alreadyDone = done.size;

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

  const totalToDo = Math.max(0, totalAll - alreadyDone - exhaustedIds.size);

  let mirrored = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | undefined;
  let processed = 0;
  const skippedIds: number[] = [];

  // Keyset cursor: fetch posts with id > lastId, ascending, in fixed-size chunks.
  let lastId = 0;
  let exhaustedChunks = false;

  outer: while (!exhaustedChunks) {
    const { data: chunk, error } = await db
      .from("posts")
      .select("id, source_chat_id, source_message_id, extra_files, media, caption, created_at")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(CHUNK_SIZE);

    if (error) {
      firstError = firstError ?? error.message;
      break;
    }
    if (!chunk || chunk.length === 0) break;
    if (chunk.length < CHUNK_SIZE) exhaustedChunks = true;
    lastId = Number(chunk[chunk.length - 1].id);

    for (const p of chunk) {
      const pid = Number(p.id);
      if (done.has(pid) || exhaustedIds.has(pid)) continue;
      if (typeof limit === "number" && processed >= limit) break outer;

      const r = await mirrorOne(db, p, backupChatId);
      processed++;
      if (r.ok) {
        mirrored++;
        done.add(pid);
        if (failMap.has(pid)) {
          await db.from("backup_failures").delete().eq("post_id", pid).eq("backup_chat_id", backupChatId);
        }
      } else {
        failed++;
        if (!firstError) firstError = r.error;
        const prev = failMap.get(pid) ?? 0;
        const attempts = prev + 1;
        failMap.set(pid, attempts);
        await db.from("backup_failures").upsert(
          {
            post_id: pid,
            backup_chat_id: backupChatId,
            attempts,
            last_error: r.error ?? "unknown",
            last_attempt_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "post_id,backup_chat_id" },
        );
        if (attempts >= maxFailedAttempts) {
          skippedIds.push(pid);
          exhaustedIds.add(pid);
          await db.from("backup_copies").upsert(
            {
              post_id: pid,
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

// Delete previously-mirrored messages from a backup channel and clear their
// tracking rows. Chunked so it fits inside the Worker time budget — re-run
// until it reports 0 remaining.
export async function wipeBackupChannelMessages(
  db: SupabaseClient,
  backupChatId: number,
  limit = 200,
  delayMs = 60,
): Promise<{ deleted: number; failed: number; remaining: number; firstError?: string }> {
  const { data: rows, error } = await db
    .from("backup_copies")
    .select("id, backup_message_id")
    .eq("backup_chat_id", backupChatId)
    .not("backup_message_id", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (error) return { deleted: 0, failed: 0, remaining: 0, firstError: error.message };

  let deleted = 0;
  let failed = 0;
  let firstError: string | undefined;
  const clearedIds: number[] = [];

  for (const r of rows ?? []) {
    const mid = Number(r.backup_message_id);
    if (!mid) continue;
    try {
      await deleteMessage(backupChatId, mid);
      deleted++;
      clearedIds.push(Number(r.id));
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      // "message to delete not found" / already gone → treat as cleared.
      if (/not found|message can't be deleted|MESSAGE_ID_INVALID/i.test(msg)) {
        clearedIds.push(Number(r.id));
      } else {
        failed++;
        if (!firstError) firstError = msg;
      }
    }
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
  }

  if (clearedIds.length > 0) {
    await db.from("backup_copies").delete().in("id", clearedIds);
  }

  const { count } = await db
    .from("backup_copies")
    .select("id", { count: "exact", head: true })
    .eq("backup_chat_id", backupChatId)
    .not("backup_message_id", "is", null);

  return { deleted, failed, remaining: count ?? 0, firstError };
}

